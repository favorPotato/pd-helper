import {sleep} from './util'

interface CdpTarget {
    id?: string
    targetId?: string
    type?: string
    url?: string
    title?: string
    webSocketDebuggerUrl?: string
}

function getTargetId(t: CdpTarget): string {
    return t.targetId || t.id || ''
}

export interface SwTarget {
    extId: string
    title: string
    webSocketDebuggerUrl: string
    targetId: string
    via: 'json' | 'browser'
}

export class CdpError extends Error {
    code: string
    constructor(code: string, message: string) {
        super(message)
        this.code = code
    }
}

async function httpJson<T>(url: string): Promise<T> {
    let resp: Response
    try {
        resp = await fetch(url)
    } catch (e) {
        throw new CdpError('CHROME_NOT_FOUND', `连接 CDP 失败: ${(e as Error).message}`)
    }
    if (!resp.ok) throw new CdpError('CHROME_NOT_FOUND', `${url} → HTTP ${resp.status}`)
    return await resp.json() as T
}

function listExtensionSws(targets: CdpTarget[]): CdpTarget[] {
    return targets.filter(t => t.type === 'service_worker' && typeof t.url === 'string' && t.url.includes('chrome-extension://'))
}

const PD_HELPER_NAME = 'pd-helper'

async function probeSwIsPdHelper(wsUrl: string): Promise<boolean> {
    let conn: CdpConnection | null = null
    try {
        conn = await connectWs(wsUrl)
        const res = await conn.send<{
            result: {value?: unknown}
            exceptionDetails?: unknown
        }>('Runtime.evaluate', {
            expression: `(() => { try { return chrome.runtime.getManifest().name; } catch (e) { return ''; } })()`,
            returnByValue: true,
            awaitPromise: false
        })
        return String(res.result?.value || '') === PD_HELPER_NAME
    } catch {
        return false
    } finally {
        if (conn) conn.close()
    }
}

async function discoverViaJson(base: string, extIdHint?: string): Promise<SwTarget | null> {
    const targets = await httpJson<CdpTarget[]>(`${base}/json`)
    const sws = listExtensionSws(targets)
    for (const sw of sws) {
        if (!sw.webSocketDebuggerUrl) continue
        const m = String(sw.url || '').match(/chrome-extension:\/\/([a-p]{32})\//)
        const extId = m ? m[1] : ''
        const ok = extIdHint
            ? extId === extIdHint
            : await probeSwIsPdHelper(sw.webSocketDebuggerUrl)
        if (ok) {
            return {
                extId,
                title: sw.title || '',
                webSocketDebuggerUrl: sw.webSocketDebuggerUrl,
                targetId: getTargetId(sw),
                via: 'json'
            }
        }
    }
    return null
}

type Pending = {resolve: (v: unknown) => void; reject: (e: Error) => void}

export interface CdpEvent {
    method: string
    params: Record<string, unknown>
    sessionId?: string
}

export interface CdpConnection {
    send<T = unknown>(method: string, params?: object, sessionId?: string): Promise<T>
    close(): void
    onClose(cb: () => void): void
    onEvent(cb: (e: CdpEvent) => void): () => void
    isOpen(): boolean
}

export async function connectWs(wsUrl: string): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl)
    const pending = new Map<number, Pending>()
    let nextId = 1
    let closed = false
    const closeCbs: Array<() => void> = []
    const eventCbs: Array<(e: CdpEvent) => void> = []

    await new Promise<void>((resolve, reject) => {
        const onOpen = () => { ws.removeEventListener('error', onErr); resolve() }
        const onErr = (e: Event) => {
            ws.removeEventListener('open', onOpen)
            reject(new CdpError('CDP_DISCONNECTED', `WS open failed: ${(e as ErrorEvent).message || 'unknown'}`))
        }
        ws.addEventListener('open', onOpen, {once: true})
        ws.addEventListener('error', onErr, {once: true})
    })

    ws.addEventListener('message', (ev: MessageEvent) => {
        const raw = typeof ev.data === 'string' ? ev.data : ''
        if (!raw) return
        let msg: {id?: number; result?: unknown; error?: {message?: string}; method?: string; params?: Record<string, unknown>; sessionId?: string}
        try { msg = JSON.parse(raw) } catch { return }
        if (typeof msg.id === 'number') {
            const p = pending.get(msg.id)
            if (!p) return
            pending.delete(msg.id)
            if (msg.error) {
                const errMsg = msg.error.message || 'unknown'
                // SW 重启后旧 sessionId 失效——chrome 不会关 WS，只回错误
                // 把它归为 CDP_DISCONNECTED 让上层触发重连
                const code = /Session with given id not found|Target closed|Inspected target navigated or closed/i.test(errMsg)
                    ? 'CDP_DISCONNECTED'
                    : 'UNKNOWN_ERROR'
                p.reject(new CdpError(code, `CDP error: ${errMsg}`))
            } else {
                p.resolve(msg.result)
            }
            return
        }
        if (typeof msg.method === 'string') {
            const event: CdpEvent = {method: msg.method, params: msg.params || {}, sessionId: msg.sessionId}
            for (const cb of eventCbs) {
                try { cb(event) } catch { /* ignore */ }
            }
        }
    })

    ws.addEventListener('close', () => {
        if (closed) return  // 防重入：close 事件可能因 abort + 网络层各自触发
        closed = true
        for (const p of pending.values()) p.reject(new CdpError('CDP_DISCONNECTED', 'WS closed'))
        pending.clear()
        for (const cb of closeCbs) {
            try { cb() } catch { /* ignore */ }
        }
    })

    return {
        send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
            if (closed) return Promise.reject(new CdpError('CDP_DISCONNECTED', 'WS already closed'))
            const id = nextId++
            const payload: Record<string, unknown> = {id, method, params}
            if (sessionId) payload.sessionId = sessionId
            return new Promise<T>((resolve, reject) => {
                pending.set(id, {resolve: resolve as (v: unknown) => void, reject})
                try {
                    ws.send(JSON.stringify(payload))
                } catch (e) {
                    pending.delete(id)
                    reject(new CdpError('CDP_DISCONNECTED', `send failed: ${(e as Error).message}`))
                }
            })
        },
        close() {
            try { ws.close() } catch { /* ignore */ }
        },
        onClose(cb) { closeCbs.push(cb) },
        onEvent(cb) {
            eventCbs.push(cb)
            return () => {
                const i = eventCbs.indexOf(cb)
                if (i >= 0) eventCbs.splice(i, 1)
            }
        },
        isOpen() { return !closed }
    }
}

export interface AttachedSession {
    conn: CdpConnection
    sessionId?: string  // browser endpoint 模式下必填
    via: 'json' | 'browser'
    target: SwTarget
    cdpUrl: string
    opts: AttachOpts
}

export async function reconnectSession(session: AttachedSession): Promise<void> {
    try { session.conn.close() } catch { /* ignore */ }
    const fresh = await attachToServiceWorker(session.cdpUrl, session.opts)
    session.conn = fresh.conn
    session.sessionId = fresh.sessionId
    session.target = fresh.target
    session.via = fresh.via
}

export interface AttachOpts {
    extId?: string
}

export async function attachToServiceWorker(cdpUrl: string, opts: AttachOpts = {}): Promise<AttachedSession> {
    const base = cdpUrl.replace(/\/+$/, '')

    try {
        const target = await discoverViaJson(base, opts.extId)
        if (target) {
            const conn = await connectWs(target.webSocketDebuggerUrl)
            try { await conn.send('Debugger.enable') } catch { /* ignore */ }
            try { await conn.send('Runtime.enable') } catch { /* ignore */ }
            return {conn, via: 'json', target, cdpUrl, opts}
        }
    } catch (e) {
        if (e instanceof CdpError && e.code === 'CHROME_NOT_FOUND') throw e
    }

    const version = await httpJson<{webSocketDebuggerUrl?: string}>(`${base}/json/version`)
    if (!version.webSocketDebuggerUrl) throw new CdpError('SW_DEAD', '未拿到 browser webSocketDebuggerUrl')

    const conn = await connectWs(version.webSocketDebuggerUrl)
    try {
        const session = await dormantWakeAndAttach(conn, version.webSocketDebuggerUrl, opts.extId)
        session.cdpUrl = cdpUrl
        session.opts = opts
        return session
    } catch (e) {
        conn.close()
        throw e
    }
}

async function dormantWakeAndAttach(conn: CdpConnection, browserWsUrl: string, extIdHint?: string): Promise<AttachedSession> {
    const captures: Array<{sessionId: string; targetInfo: CdpTarget}> = []
    const off = conn.onEvent((ev) => {
        if (ev.method !== 'Target.attachedToTarget') return
        const info = ev.params as {targetInfo?: CdpTarget; sessionId?: string}
        const t = info.targetInfo
        const sid = info.sessionId
        if (!t || !sid) return
        if (t.type === 'service_worker' && String(t.url || '').includes('chrome-extension://')) {
            captures.push({sessionId: sid, targetInfo: t})
        }
    })

    try {
        await conn.send('Target.setDiscoverTargets', {discover: true})
        await conn.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
            filter: [{type: 'service_worker', exclude: false}]
        })

        const pdExtId = extIdHint || await detectPdHelperExtId(conn).catch(() => '')
        if (!pdExtId) throw new CdpError('SW_DEAD', '未能枚举到 pd-helper 扩展 ID（可用 --ext-id 提供）')

        const matchPd = () => captures.find(c => String(c.targetInfo.url || '').includes(`chrome-extension://${pdExtId}/`))

        await sleep(300)

        if (!matchPd()) {
            await wakeViaPageSession(conn, pdExtId)
            const deadline = Date.now() + 5000
            while (!matchPd() && Date.now() < deadline) await sleep(100)
        }

        const cap = matchPd()
        if (!cap) throw new CdpError('SW_DEAD', `pd-helper SW 唤醒后仍未 attach (extId=${pdExtId})`)

        const t = cap.targetInfo
        const sessionId = cap.sessionId
        const target: SwTarget = {
            extId: pdExtId,
            title: t.title || '',
            webSocketDebuggerUrl: browserWsUrl,
            targetId: getTargetId(t),
            via: 'browser'
        }

        try { await conn.send('Runtime.enable', {}, sessionId) } catch { /* ignore */ }
        try { await conn.send('Debugger.enable', {}, sessionId) } catch { /* ignore */ }

        return {conn, sessionId, via: 'browser', target, cdpUrl: '', opts: {}}
    } finally {
        off()
    }
}

async function detectPdHelperExtId(conn: CdpConnection): Promise<string> {
    const t = await conn.send<{targetInfos: CdpTarget[]}>('Target.getTargets', {})
    let extPage = t.targetInfos.find(x => x.url === 'chrome://extensions/')
    let createdId = ''
    if (!extPage) {
        const ct = await conn.send<{targetId: string}>('Target.createTarget', {url: 'chrome://extensions/'})
        createdId = ct.targetId
        await sleep(800)
        extPage = {targetId: createdId, url: 'chrome://extensions/'}
    }
    const targetId = getTargetId(extPage)
    if (!targetId) return ''

    const at = await conn.send<{sessionId: string}>('Target.attachToTarget', {targetId, flatten: true})
    const sid = at.sessionId
    try {
        await conn.send('Runtime.enable', {}, sid)
        const r = await conn.send<{
            result: {value?: unknown}
            exceptionDetails?: unknown
        }>('Runtime.evaluate', {
            expression: `(() => { try {
                const items = [...document.querySelector("extensions-manager").shadowRoot.querySelector("extensions-item-list").shadowRoot.querySelectorAll("extensions-item")];
                const pd = items.find(e => (e.shadowRoot && e.shadowRoot.querySelector('#name')?.textContent || '').trim() === 'pd-helper');
                return pd ? pd.id : '';
            } catch (e) { return ''; } })()`,
            returnByValue: true,
            awaitPromise: false
        }, sid)
        return String((r.result?.value as string) || '')
    } finally {
        try { await conn.send('Target.detachFromTarget', {sessionId: sid}) } catch { /* ignore */ }
        if (createdId) {
            try { await conn.send('Target.closeTarget', {targetId: createdId}) } catch { /* ignore */ }
        }
    }
}

// ServiceWorker.* 不存在于 browser endpoint，必须在 page session 上调用
async function wakeViaPageSession(conn: CdpConnection, extId: string): Promise<void> {
    const ct = await conn.send<{targetId: string}>('Target.createTarget', {
        url: `chrome-extension://${extId}/manifest.json`
    })
    const pageTid = ct.targetId
    if (!pageTid) return

    try {
        await sleep(300)  // 等 page session ready
        const at = await conn.send<{sessionId: string}>('Target.attachToTarget', {targetId: pageTid, flatten: true})
        const pageSid = at.sessionId

        try {
            await conn.send('ServiceWorker.enable', {}, pageSid)
            await conn.send('ServiceWorker.startWorker', {scopeURL: `chrome-extension://${extId}/`}, pageSid)
        } finally {
            try { await conn.send('Target.detachFromTarget', {sessionId: pageSid}) } catch { /* ignore */ }
        }
    } finally {
        try { await conn.send('Target.closeTarget', {targetId: pageTid}) } catch { /* ignore */ }
    }
}

export async function evaluate<T = unknown>(session: AttachedSession, expression: string, awaitPromise = true): Promise<T> {
    const res = await session.conn.send<{
        result: {value?: unknown; type: string; description?: string}
        exceptionDetails?: {text?: string; exception?: {description?: string}}
    }>('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: false
    }, session.sessionId)

    if (res.exceptionDetails) {
        const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluation failed'
        throw new CdpError(classifyEvalError(desc), `evaluate exception: ${desc}`)
    }
    return res.result.value as T
}

// SW 端用 PdError 抛 `[CODE] message` 格式；优先解析前缀，否则退回字符串匹配
const PD_CODE_RE = /\[([A-Z_]+)\]/
const KNOWN_CODES: ReadonlySet<string> = new Set([
    'UNKNOWN_ERROR', 'LOGIN_REQUIRED', 'RATE_LIMITED', 'TAB_CLOSED', 'INVALID_PARAM',
    'SW_DEAD', 'CDP_DISCONNECTED', 'TIMEOUT', 'CHROME_NOT_FOUND', 'TASK_LOST', 'CANCELLED'
])

function classifyEvalError(desc: string): string {
    const m = desc.match(PD_CODE_RE)
    if (m && KNOWN_CODES.has(m[1])) return m[1]
    return 'UNKNOWN_ERROR'
}

export async function callPd<T = unknown>(session: AttachedSession, method: string, args: unknown[] = []): Promise<T> {
    const argsJson = JSON.stringify(args)
    const expr = `(async () => {
        if (!globalThis.__pd) throw new Error('__pd not installed');
        const fn = globalThis.__pd[${JSON.stringify(method)}];
        if (typeof fn !== 'function') throw new Error('unknown __pd method: ' + ${JSON.stringify(method)});
        const args = ${argsJson};
        return await fn.apply(globalThis.__pd, args);
    })()`
    return await evaluate<T>(session, expr, true)
}
