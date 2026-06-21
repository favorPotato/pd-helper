export {}

// 页面真实上下文脚本（IIFE）：CS 经 chrome.runtime.getURL('exolyt-page-bridge.js') 注入，借页面同源态发 fetch
// 通道映射对齐 tk：exolyt/page_fetch → exolyt/page_fetch_result，就绪发 exolyt/page_bridge_ready
// 范式 A（1.2）：auth:true 时本端单条消息内串「取同源 session.accessToken + 带 Bearer 发目标」两步
// —— token 全程留在页面上下文、绝不经 postMessage 回 CS（更安全、最贴实测脚本 examples/exolyt/search.js）
type PageFetchMessage = {
    type: 'exolyt/page_fetch'
    requestId: string
    url: string
    init?: RequestInit
    auth?: boolean
}

declare global {
    interface Window {
        __EXOLYT_BRIDGE_READY__?: boolean
    }
}

(() => {
    if (window.__EXOLYT_BRIDGE_READY__) {
        window.postMessage({type: 'exolyt/page_bridge_ready'}, '*')
        return
    }

    window.__EXOLYT_BRIDGE_READY__ = true

    // 取同源 JWT：无 session / 字段缺失 / 非 2xx 均视为会话失效，回 status 供 CS 归一为 LOGIN_REQUIRED
    // 现取不缓存：每次 auth 请求重新拉 session，token 失效自然反映为下次现取失败
    async function resolveBearerToken(): Promise<string> {
        const sessionRes = await fetch('/api/auth/session')
        if (!sessionRes.ok) {
            throw new Error(`session_${sessionRes.status}`)
        }
        const session = await sessionRes.json().catch(() => null)
        const token = session && typeof session.accessToken === 'string' ? session.accessToken : ''
        if (!token) {
            throw new Error('session_no_access_token')
        }
        return token
    }

    function mergeAuthInit(init: RequestInit | undefined, token: string): RequestInit {
        const headers = new Headers(init?.headers || {})
        headers.set('Authorization', `Bearer ${token}`)
        if (!headers.has('Content-Type') && init?.body) {
            headers.set('Content-Type', 'application/json')
        }
        return {...init, headers}
    }

    window.addEventListener('message', async (event: MessageEvent<PageFetchMessage>) => {
        if (event.source !== window) return

        const msg = event.data
        if (!msg || msg.type !== 'exolyt/page_fetch' || !msg.requestId || !msg.url) return

        try {
            let init = msg.init || {}
            if (msg.auth) {
                // 取不到 token 直接抛 → 回 ok:false + error，CS 端归一为 LOGIN_REQUIRED；token 不离本上下文
                const token = await resolveBearerToken()
                init = mergeAuthInit(msg.init, token)
            }

            const response = await fetch(msg.url, init)
            const text = await response.text()
            window.postMessage({
                type: 'exolyt/page_fetch_result',
                requestId: msg.requestId,
                ok: response.ok,
                status: response.status,
                contentType: response.headers.get('content-type') || '',
                text
            }, '*')
        } catch (error) {
            window.postMessage({
                type: 'exolyt/page_fetch_result',
                requestId: msg.requestId,
                ok: false,
                status: 0,
                contentType: '',
                text: '',
                error: error instanceof Error ? error.message : String(error)
            }, '*')
        }
    })

    window.postMessage({type: 'exolyt/page_bridge_ready'}, '*')
})()
