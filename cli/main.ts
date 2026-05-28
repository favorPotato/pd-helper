#!/usr/bin/env bun

import {attachToServiceWorker, callPd, CdpError, connectWs, type AttachedSession} from './cdp'
import {emit, emitSynthetic, ttyLog} from './ndjson'
import {exitFor} from './errors'
import {runCall} from './loop'
import {numFlag} from './util'

interface Argv {
    cmd: string
    rest: string[]
    flags: Record<string, string>
    params: Record<string, unknown>
}

// 无值 bool flag 白名单：避免 `list --all <taskId>` 中 <taskId> 被吞作 --all 的值
const BOOL_FLAGS: ReadonlySet<string> = new Set(['all', 'help'])

function parseArgs(raw: string[]): Argv {
    const cmd = raw[0] || ''
    const rest: string[] = []
    const flags: Record<string, string> = {}
    const params: Record<string, unknown> = {}
    for (let i = 1; i < raw.length; i += 1) {
        const a = raw[i]
        if (a === '--param' && i + 1 < raw.length) {
            const kv = raw[++i]
            const eq = kv.indexOf('=')
            if (eq < 0) {
                console.error(`invalid --param value: ${kv} (expected key=value)`)
                process.exit(exitFor('INVALID_PARAM'))
            }
            params[kv.slice(0, eq)] = autoCoerce(kv.slice(eq + 1))
            continue
        }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=')
            if (eq > 0) {
                flags[a.slice(2, eq)] = a.slice(eq + 1)
            } else {
                const name = a.slice(2)
                if (BOOL_FLAGS.has(name)) {
                    flags[name] = 'true'
                } else if (i + 1 < raw.length && !raw[i + 1].startsWith('--')) {
                    flags[name] = raw[++i]
                } else {
                    flags[name] = 'true'
                }
            }
            continue
        }
        rest.push(a)
    }
    return {cmd, rest, flags, params}
}

function autoCoerce(v: string): unknown {
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === 'null') return null
    if (v !== '' && !Number.isNaN(Number(v))) return Number(v)
    return v
}

function usage(): string {
    return `pd-helper-cli <command> [options]

Commands:
  call <method> [--param k=v ...]    Start and follow a task to completion
  list [--all]                        List active tasks (--all includes done/cancelled/error)
  status <taskId>                     Snapshot a task's progress
  cancel <taskId>                     Cancel a task
  methods                             List available methods
  dev-reload                          Reload the extension SW and refresh matching tabs (dev only)

Global options:
  --cdp <url>             CDP HTTP endpoint (default: env PD_HELPER_CDP or http://127.0.0.1:9222)
  --ext-id <id>           pd-helper extension id (default: env PD_HELPER_EXT_ID; auto-detect via chrome://extensions/)
  --timeout <seconds>     Total timeout for "call" (default: 3600)
  --poll-interval <ms>    Tail poll interval (default: 2000)
  --status-interval <ms>  Status snapshot interval (default: 30000)

Examples:
  pd-helper-cli call ping --param count=5 --param interval=300 --cdp http://127.0.0.1:31402
  pd-helper-cli methods
`
}

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2))
    if (!args.cmd || args.cmd === '-h' || args.cmd === '--help' || args.cmd === 'help') {
        process.stdout.write(usage())
        return 0
    }

    const cdpUrl = args.flags.cdp || process.env.PD_HELPER_CDP || 'http://127.0.0.1:9222'

    const extId = args.flags['ext-id'] || process.env.PD_HELPER_EXT_ID || undefined

    let session: AttachedSession
    try {
        session = await attachToServiceWorker(cdpUrl, {extId})
    } catch (e) {
        const code = e instanceof CdpError ? e.code : 'CHROME_NOT_FOUND'
        const msg = e instanceof Error ? e.message : String(e)
        emit({v: 1, type: 'error', taskId: '', seq: -1, ts: Date.now(), data: {code, message: msg}})
        return exitFor(code)
    }
    ttyLog(`[pd-helper-cli] attached via=${session.via} extId=${session.target.extId} title="${session.target.title}"`)

    try {
        switch (args.cmd) {
            case 'methods': {
                const methods = await callPd<string[]>(session, 'methods', [])
                process.stdout.write(JSON.stringify(methods) + '\n')
                return 0
            }
            case 'list': {
                const all = args.flags.all === 'true'
                const tasks = await callPd<unknown[]>(session, 'listTasks', [{all}])
                process.stdout.write(JSON.stringify(tasks, null, 2) + '\n')
                return 0
            }
            case 'status': {
                const taskId = args.rest[0]
                if (!taskId) {
                    console.error('status: missing <taskId>')
                    return exitFor('INVALID_PARAM')
                }
                const snap = await callPd(session, 'status', [taskId])
                process.stdout.write(JSON.stringify(snap, null, 2) + '\n')
                return 0
            }
            case 'cancel': {
                const taskId = args.rest[0]
                if (!taskId) {
                    console.error('cancel: missing <taskId>')
                    return exitFor('INVALID_PARAM')
                }
                const r = await callPd(session, 'cancel', [taskId])
                process.stdout.write(JSON.stringify(r) + '\n')
                return 0
            }
            case 'dev-reload': {
                try {
                    await session.conn.send('Runtime.evaluate', {
                        expression: 'chrome.runtime.reload()',
                        awaitPromise: false,
                        returnByValue: true,
                        userGesture: false
                    }, session.sessionId)
                } catch {
                    // SW 重启时 evaluate 被打断，可忽略
                }
                ttyLog('[pd-helper-cli] SW reload triggered')

                const sw = cdpUrl.replace(/\/+$/, '')
                let refreshed = 0
                try {
                    const list = await (await fetch(`${sw}/json`)).json() as Array<{type?: string; url?: string; webSocketDebuggerUrl?: string}>
                    const targets = list.filter(t => t.type === 'page'
                        && typeof t.webSocketDebuggerUrl === 'string'
                        && /(?:tiktok|instagram|noxinfluencer)\.com/i.test(String(t.url || '')))
                    for (const t of targets) {
                        const conn = await connectWs(t.webSocketDebuggerUrl!)
                        try {
                            await conn.send('Page.reload')
                            refreshed += 1
                        } catch { /* ignore single-tab refresh errors */ } finally {
                            conn.close()
                        }
                    }
                } catch (e) {
                    ttyLog(`[pd-helper-cli] tab refresh skipped: ${(e as Error).message}`)
                }
                process.stdout.write(JSON.stringify({ok: true, swReloaded: true, tabsRefreshed: refreshed}) + '\n')
                return 0
            }
            case 'call': {
                const method = args.rest[0]
                if (!method) {
                    console.error('call: missing <method>')
                    return exitFor('INVALID_PARAM')
                }
                const timeoutMs = numFlag(args.flags.timeout, 3600) * 1000
                const pollIntervalMs = numFlag(args.flags['poll-interval'], 2000)
                const statusIntervalMs = numFlag(args.flags['status-interval'], 30000)
                return await runCall(session, {
                    method,
                    params: args.params,
                    timeoutMs,
                    pollIntervalMs,
                    statusIntervalMs
                })
            }
            default:
                process.stderr.write(`unknown command: ${args.cmd}\n\n${usage()}`)
                return exitFor('INVALID_PARAM')
        }
    } catch (e) {
        const code = e instanceof CdpError ? e.code : 'UNKNOWN_ERROR'
        const msg = e instanceof Error ? e.message : String(e)
        emitSynthetic('', 'error', {code, message: msg})
        return exitFor(code)
    } finally {
        session.conn.close()
    }
}

void main().then((code) => process.exit(code))
