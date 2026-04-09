export {}

type PageFetchMessage = {
    type: 'tk/page_fetch'
    requestId: string
    url: string
    init?: RequestInit
}

declare global {
    interface Window {
        __TK_PAGE_BRIDGE_READY__?: boolean
    }
}

(() => {
    if (window.__TK_PAGE_BRIDGE_READY__) {
        window.postMessage({type: 'tk/page_bridge_ready'}, '*')
        return
    }

    window.__TK_PAGE_BRIDGE_READY__ = true

    window.addEventListener('message', async (event: MessageEvent<PageFetchMessage>) => {
        if (event.source !== window) return

        const msg = event.data
        if (!msg || msg.type !== 'tk/page_fetch' || !msg.requestId || !msg.url) return

        try {
            const response = await fetch(msg.url, msg.init || {})
            const text = await response.text()
            window.postMessage({
                type: 'tk/page_fetch_result',
                requestId: msg.requestId,
                ok: response.ok,
                status: response.status,
                contentType: response.headers.get('content-type') || '',
                text
            }, '*')
        } catch (error) {
            window.postMessage({
                type: 'tk/page_fetch_result',
                requestId: msg.requestId,
                ok: false,
                status: 0,
                contentType: '',
                text: '',
                error: error instanceof Error ? error.message : String(error)
            }, '*')
        }
    })

    window.postMessage({type: 'tk/page_bridge_ready'}, '*')
})()
