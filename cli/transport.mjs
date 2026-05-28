export class CdpError extends Error {
    constructor(code, message) {
        super(message)
        this.code = code
    }
}

export async function httpJson(url) {
    let resp
    try {
        resp = await fetch(url)
    } catch (e) {
        throw new CdpError('CHROME_NOT_FOUND', `连接 CDP 失败: ${e.message}`)
    }
    if (!resp.ok) throw new CdpError('CHROME_NOT_FOUND', `${url} → HTTP ${resp.status}`)
    return await resp.json()
}

export async function connectWs(wsUrl) {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    let nextId = 1
    let closed = false
    const eventCbs = []

    await new Promise((resolve, reject) => {
        const onOpen = () => { ws.removeEventListener('error', onErr); resolve() }
        const onErr = (e) => {
            ws.removeEventListener('open', onOpen)
            reject(new CdpError('CDP_DISCONNECTED', `WS open failed: ${e.message || 'unknown'}`))
        }
        ws.addEventListener('open', onOpen, {once: true})
        ws.addEventListener('error', onErr, {once: true})
    })

    ws.addEventListener('message', (ev) => {
        const raw = typeof ev.data === 'string' ? ev.data : ''
        if (!raw) return
        let msg
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
            const event = {method: msg.method, params: msg.params || {}, sessionId: msg.sessionId}
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
    })

    return {
        send(method, params = {}, sessionId) {
            if (closed) return Promise.reject(new CdpError('CDP_DISCONNECTED', 'WS already closed'))
            const id = nextId++
            const payload = {id, method, params}
            if (sessionId) payload.sessionId = sessionId
            return new Promise((resolve, reject) => {
                pending.set(id, {resolve, reject})
                try {
                    ws.send(JSON.stringify(payload))
                } catch (e) {
                    pending.delete(id)
                    reject(new CdpError('CDP_DISCONNECTED', `send failed: ${e.message}`))
                }
            })
        },
        close() {
            try { ws.close() } catch { /* ignore */ }
        },
        onEvent(cb) {
            eventCbs.push(cb)
            return () => {
                const i = eventCbs.indexOf(cb)
                if (i >= 0) eventCbs.splice(i, 1)
            }
        }
    }
}
