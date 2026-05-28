/**
 * 通过 CDP 给指定比特环境打开 N 个独立 BrowserContext
 * 默认 daemon 化，关闭比特环境后自动退出
 *
 * 用法：
 *   bun scripts/cdp-ctx.js --seq 31402            # 默认 N=3，后台
 *   bun scripts/cdp-ctx.js --seq 31402 --n 5      # 5 个 ctx，后台
 *   bun scripts/cdp-ctx.js --seq 31402 --fg       # 前台（调试）
 */

import {spawn} from 'node:child_process'
import {mkdirSync, openSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

const BIT_API = 'http://127.0.0.1:54345'

function parseArgs(argv) {
    const out = {}
    const flags = new Set(['fg'])
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i]
        const m = a.match(/^--?([^=]+)(?:=(.+))?$/)
        if (!m) continue
        const key = m[1]
        if (flags.has(key)) {
            out[key] = true
            continue
        }
        out[key] = m[2] ?? argv[++i]
    }
    return out
}

/** @type {{seq?: string, s?: string, n?: string, fg?: boolean}} */
const args = parseArgs(process.argv)
const SEQ = parseInt(args.seq ?? args.s ?? '', 10)
const N = parseInt(args.n ?? '3', 10)
const FG = !!args.fg

if (!Number.isFinite(SEQ) || SEQ <= 0) {
    console.error('用法: bun scripts/cdp-ctx.js --seq <编号> [--n <数量>] [--fg]')
    process.exit(1)
}
if (!Number.isFinite(N) || N <= 0) {
    console.error('--n 必须是正整数')
    process.exit(1)
}

if (!FG && !process.env.__CDP_CTX_DAEMON__) {
    const logPath = join(homedir(), `Library/Logs/pd-helper-cdp-ctx-${SEQ}.log`)
    const fd = openSync(logPath, 'a')
    const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: ['ignore', fd, fd],
        env: {...process.env, __CDP_CTX_DAEMON__: '1'}
    })
    child.unref()
    console.log(`已后台启动 PID=${child.pid}`)
    console.log(`日志: ${logPath}`)
    console.log(`停止: kill ${child.pid}`)
    process.exit(0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function bitPost(endpoint, body = {}) {
    const r = await fetch(`${BIT_API}${endpoint}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    })
    return await r.json()
}

const list = await bitPost('/browser/list', {page: 0, pageSize: 1, seq: SEQ})
const windowId = list?.data?.list?.[0]?.id
if (!windowId) {
    console.error(`找不到 seq=${SEQ}`)
    process.exit(1)
}
console.log(`[init] seq=${SEQ} windowId=${windowId}`)

let portsRes = await bitPost('/browser/ports')
let cdpPort = portsRes?.data?.[windowId]
if (!cdpPort) {
    console.log('[init] 调用 /browser/open ...')
    await bitPost('/browser/open', {
        id: windowId,
        args: ['--disable-notifications'],
        ignoreDefaultUrls: true,
        queue: true
    })
    await sleep(1500)
    portsRes = await bitPost('/browser/ports')
    cdpPort = portsRes?.data?.[windowId]
    if (!cdpPort) {
        console.error('[init] 打开后未拿到端口')
        process.exit(1)
    }
}
console.log(`[init] CDP port=${cdpPort}`)

const verRes = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
/** @type {{webSocketDebuggerUrl: string}} */
const ver = await verRes.json()
console.log(`[init] ws=${ver.webSocketDebuggerUrl}`)

const ws = new WebSocket(ver.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()

ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
        else p.resolve(msg.result)
    }
})

ws.addEventListener('close', () => {
    console.log('[cdp] ws closed, exit')
    process.exit(0)
})

ws.addEventListener('error', (e) => {
    console.error('[cdp] ws error:', e?.message ?? e)
})

function cdpSend(method, params = {}) {
    const id = nextId++
    return new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject})
        ws.send(JSON.stringify({id, method, params}))
    })
}

await new Promise((r) => ws.addEventListener('open', () => r()))
console.log('[cdp] ws connected')

const downloadDir = join(homedir(), 'Downloads', String(SEQ))
mkdirSync(downloadDir, {recursive: true})
console.log(`[cdp] downloadDir=${downloadDir}`)

const created = []
for (let i = 1; i <= N; i++) {
    const ctx = await cdpSend('Target.createBrowserContext')
    await cdpSend('Browser.setDownloadBehavior', {
        behavior: 'allow',
        browserContextId: ctx.browserContextId,
        downloadPath: downloadDir,
        eventsEnabled: false
    })
    const tgt = await cdpSend('Target.createTarget', {
        url: 'about:blank',
        browserContextId: ctx.browserContextId
    })

    const sess = await cdpSend('Target.attachToTarget', {targetId: tgt.targetId, flatten: true})
    ws.send(JSON.stringify({
        sessionId: sess.sessionId,
        id: nextId++,
        method: 'Runtime.evaluate',
        params: {
            expression: `document.title='cdp-ctx-${SEQ}-#${i}';document.body.innerHTML='<h1 style="font-family:sans-serif">独立 context #${i}（seq=${SEQ}）</h1>';`
        }
    }))

    created.push({browserContextId: ctx.browserContextId, targetId: tgt.targetId, idx: i})
    console.log(`[cdp] ctx${i}: ${ctx.browserContextId.slice(0, 12)}…`)
}

console.log(`\n[cdp] ${N} 个 context 已就绪`)
console.log(`[cdp] tab 标题: cdp-ctx-${SEQ}-#1 ... #${N}`)
console.log('[cdp] holding... Ctrl+C 退出，context 会被 Chromium 自动 dispose')

const cleanup = (sig) => {
    console.log(`\n[cdp] ${sig} received, closing ws ...`)
    try { ws.close() } catch {}
    setTimeout(() => process.exit(0), 500)
}
process.on('SIGTERM', () => cleanup('SIGTERM'))
process.on('SIGINT', () => cleanup('SIGINT'))

await new Promise(() => {})
