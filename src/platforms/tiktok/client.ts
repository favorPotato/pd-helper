export interface BinaryResponse {
    bytes: ArrayBuffer
    contentType: string
    contentLength: number
}

export interface ItemListPageResponse {
    items: unknown[]
    hasMore: boolean
    cursor: number
}

export interface CommentPageResponse {
    comments: unknown[]
    total: number
    cursor: number
    hasMore: boolean
    hasFilteredComments: boolean
}

export interface RequestEnv {
    appLanguage: string
    browserLanguage: string
    deviceId: string
    region: string
}

interface BrowserEnv {
    browserPlatform: string
    browserVersion: string
    browserLanguage: string
    os: string
    screenHeight: string
    screenWidth: string
}

interface PageFetchPayload {
    ok: boolean
    status: number
    contentType: string
    text: string
    error?: string
}

type ApiObject = Record<string, unknown>

declare const chrome: typeof globalThis.chrome

declare global {
    interface Window {
        __TK_PAGE_BRIDGE_READY__?: boolean
        __TK_PAGE_BRIDGE_READY_PROMISE__?: Promise<void> | null
        __TK_PAGE_FETCH_HANDLER_LOADED__?: boolean
    }
}

const pageFetchPending = new Map<string, { resolve: (payload: PageFetchPayload) => void; reject: (error: Error) => void; timer: number }>()
let pageFetchSeq = 0

function withDefaultCredentials(init: RequestInit = {}): RequestInit {
    return {
        credentials: 'include',
        ...init
    }
}

function isTikTokUrl(url: string): boolean {
    try {
        const hostname = new URL(url, window.location.origin).hostname
        return hostname.endsWith('.tiktok.com') || hostname === 'tiktok.com'
    } catch {
        return false
    }
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
    return await fetch(url, withDefaultCredentials(init))
}

function ensureOk(response: Response): void {
    if (!response.ok) {
        throw new Error(`请求失败: ${response.status}`)
    }
}

function parseJsonText<T>(text: string, contentType: string): T {
    const trimmed = text.trim()
    if (!trimmed) {
        throw new Error('响应体为空')
    }

    const normalizedType = contentType.toLowerCase()
    const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[')
    if (!normalizedType.includes('json') && !looksLikeJson) {
        throw new Error('响应不是 JSON')
    }

    try {
        return JSON.parse(trimmed) as T
    } catch (error) {
        throw new Error(`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`)
    }
}

function registerPageFetchHandler(): void {
    if (window.__TK_PAGE_FETCH_HANDLER_LOADED__) return
    window.__TK_PAGE_FETCH_HANDLER_LOADED__ = true

    window.addEventListener('message', (event: MessageEvent) => {
        if (event.source !== window) return

        const msg = event.data as { type?: string; requestId?: string; ok?: boolean; status?: number; contentType?: string; text?: string; error?: string }
        if (!msg || msg.type !== 'tk/page_fetch_result' || !msg.requestId) return

        const pending = pageFetchPending.get(msg.requestId)
        if (!pending) return

        pageFetchPending.delete(msg.requestId)
        clearTimeout(pending.timer)

        if (msg.error) {
            pending.reject(new Error(msg.error))
            return
        }

        pending.resolve({
            ok: msg.ok === true,
            status: typeof msg.status === 'number' ? msg.status : 0,
            contentType: typeof msg.contentType === 'string' ? msg.contentType : '',
            text: typeof msg.text === 'string' ? msg.text : ''
        })
    })
}

function injectPageBridge(): Promise<void> {
    if (window.__TK_PAGE_BRIDGE_READY__) {
        return Promise.resolve()
    }

    if (window.__TK_PAGE_BRIDGE_READY_PROMISE__) {
        return window.__TK_PAGE_BRIDGE_READY_PROMISE__
    }

    window.__TK_PAGE_BRIDGE_READY_PROMISE__ = new Promise<void>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
            cleanup()
            reject(new Error('page_bridge_ready_timeout'))
        }, 5000)

        function cleanup(): void {
            clearTimeout(timeoutId)
            window.removeEventListener('message', onReady)
        }

        function onReady(event: MessageEvent): void {
            if (event.source !== window) return
            const msg = event.data as { type?: string }
            if (!msg || msg.type !== 'tk/page_bridge_ready') return
            window.__TK_PAGE_BRIDGE_READY__ = true
            cleanup()
            resolve()
        }

        window.addEventListener('message', onReady)

        const script = document.createElement('script')
        script.src = chrome.runtime.getURL('page-bridge.js')
        script.async = false
        script.onload = () => script.remove()
        script.onerror = () => {
            cleanup()
            reject(new Error('page_bridge_inject_failed'))
        }
        ;(document.head || document.documentElement).appendChild(script)
    }).finally(() => {
        if (!window.__TK_PAGE_BRIDGE_READY__) {
            window.__TK_PAGE_BRIDGE_READY_PROMISE__ = null
        }
    })

    return window.__TK_PAGE_BRIDGE_READY_PROMISE__
}

async function pageFetch(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<PageFetchPayload> {
    registerPageFetchHandler()
    await injectPageBridge()

    pageFetchSeq += 1
    const requestId = `req_${Date.now()}_${pageFetchSeq}`

    const payload = await new Promise<PageFetchPayload>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            pageFetchPending.delete(requestId)
            reject(new Error('page_fetch_timeout'))
        }, timeoutMs)

        pageFetchPending.set(requestId, {resolve, reject, timer})
        window.postMessage({type: 'tk/page_fetch', requestId, url, init}, '*')
    })

    if (!payload.ok) {
        throw new Error(`请求失败: ${payload.status || 'unknown'}`)
    }

    return payload
}

export async function ensureTikTokPageContextReady(): Promise<void> {
    const payload = await pageFetch(window.location.href, {
        method: 'GET',
        mode: 'cors',
        credentials: 'include',
        headers: {accept: 'text/html'}
    })

    if (!payload.text.trim()) {
        throw new Error('page_context_empty_response')
    }
}

function toNumber(value: unknown): number {
    const num = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(num) ? num : 0
}

function buildBrowserEnv(): BrowserEnv {
    const userAgent = navigator.userAgent || ''
    const lowerUserAgent = userAgent.toLowerCase()
    const navigatorRecord = navigator as unknown as Record<string, unknown>
    const browserPlatform = String(navigatorRecord.platform || 'Win32')
    let os = 'windows'
    if (lowerUserAgent.includes('mac os x')) {
        os = 'mac'
    } else if (lowerUserAgent.includes('linux')) {
        os = 'linux'
    }

    return {
        browserPlatform,
        browserVersion: userAgent || 'Mozilla/5.0',
        browserLanguage: navigator.language || 'zh-CN',
        os,
        screenHeight: String(window.screen?.height || 1920),
        screenWidth: String(window.screen?.width || 1080)
    }
}

function buildCommonApiUrl(path: string, requestEnv: RequestEnv): URL {
    const browserEnv = buildBrowserEnv()
    const url = new URL(`https://www.tiktok.com${path}`)
    url.searchParams.set('aid', '1988')
    url.searchParams.set('app_language', requestEnv.appLanguage || 'zh-Hans')
    url.searchParams.set('app_name', 'tiktok_web')
    url.searchParams.set('browser_language', requestEnv.browserLanguage || browserEnv.browserLanguage)
    url.searchParams.set('browser_name', 'Mozilla')
    url.searchParams.set('browser_online', 'true')
    url.searchParams.set('browser_platform', browserEnv.browserPlatform)
    url.searchParams.set('browser_version', browserEnv.browserVersion)
    url.searchParams.set('channel', 'tiktok_web')
    url.searchParams.set('device_id', requestEnv.deviceId || '7605966330110543378')
    url.searchParams.set('device_platform', 'web_pc')
    url.searchParams.set('os', browserEnv.os)
    url.searchParams.set('region', requestEnv.region || 'TW')
    url.searchParams.set('screen_height', browserEnv.screenHeight)
    url.searchParams.set('screen_width', browserEnv.screenWidth)
    return url
}

function getBizCode(response: ApiObject): number {
    if (typeof response.statusCode === 'number') return response.statusCode
    if (typeof response.status_code === 'number') return response.status_code
    return 0
}

function getHasMore(response: ApiObject): boolean {
    if (typeof response.hasMore === 'boolean') return response.hasMore
    if (typeof response.has_more === 'boolean') return response.has_more
    if (typeof response.hasMore === 'number') return response.hasMore === 1
    if (typeof response.has_more === 'number') return response.has_more === 1
    return false
}

function getCursor(response: ApiObject): number {
    return toNumber(response.cursor)
}

function getItemList(response: ApiObject): unknown[] {
    if (Array.isArray(response.itemList)) return response.itemList
    if (Array.isArray(response.item_list)) return response.item_list
    return []
}

export async function fetchHtml(url: string): Promise<string> {
    if (isTikTokUrl(url)) {
        const payload = await pageFetch(url, {
            method: 'GET',
            mode: 'cors',
            credentials: 'include',
            headers: {accept: 'text/html'}
        })
        if (!payload.text.trim()) {
            throw new Error('响应体为空')
        }
        return payload.text
    }

    const response = await request(url, {
        method: 'GET',
        headers: {accept: 'text/html'}
    })
    ensureOk(response)
    return await response.text()
}

export async function fetchHead(url: string, referrer?: string): Promise<Response> {
    return await request(url, {method: 'HEAD', mode: 'cors', referrer})
}

export async function fetchBinary(url: string, referrer?: string): Promise<BinaryResponse> {
    const response = await request(url, {method: 'GET', mode: 'cors', referrer})
    ensureOk(response)
    const contentType = response.headers.get('content-type') || ''
    const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10)
    const bytes = await response.arrayBuffer()
    return {
        bytes,
        contentType,
        contentLength: Number.isFinite(contentLength) ? contentLength : 0
    }
}

export async function fetchVideoPage(
    secUid: string,
    cursor: number,
    requestEnv: RequestEnv,
    referrer: string,
    hot = true
): Promise<ItemListPageResponse> {
    const url = buildCommonApiUrl('/api/post/item_list/', requestEnv)
    url.searchParams.set('count', '35')
    url.searchParams.set('coverFormat', '2')
    url.searchParams.set('cursor', String(cursor))
    url.searchParams.set('from_page', 'user')
    url.searchParams.set('secUid', secUid)
    if (hot) {
        url.searchParams.set('needPinnedItemIds', 'true')
        url.searchParams.set('post_item_list_request_type', '1')
    }

    const payload = await pageFetch(url.toString(), {
        method: 'GET',
        mode: 'cors',
        credentials: 'include',
        referrer,
        headers: {accept: 'application/json, text/plain, */*'}
    })
    const json = parseJsonText<ApiObject>(payload.text, payload.contentType)
    const bizCode = getBizCode(json)
    if (bizCode !== 0) {
        throw new Error(`视频列表业务码异常: ${bizCode}`)
    }

    return {
        items: getItemList(json),
        hasMore: getHasMore(json),
        cursor: getCursor(json)
    }
}

export async function fetchCommentPage(
    videoId: string,
    cursor: number,
    requestEnv: RequestEnv,
    referrer: string
): Promise<CommentPageResponse> {
    const url = buildCommonApiUrl('/api/comment/list/', requestEnv)
    url.searchParams.set('aweme_id', videoId)
    url.searchParams.set('count', '50')
    url.searchParams.set('cursor', String(cursor))
    url.searchParams.set('from_page', 'video')

    const payload = await pageFetch(url.toString(), {
        method: 'GET',
        mode: 'cors',
        credentials: 'include',
        referrer,
        headers: {accept: 'application/json, text/plain, */*'}
    })
    const json = parseJsonText<ApiObject>(payload.text, payload.contentType)
    const bizCode = getBizCode(json)
    if (bizCode !== 0) {
        throw new Error(`评论接口业务码异常: ${bizCode}`)
    }

    return {
        comments: Array.isArray(json.comments) ? json.comments : [],
        total: toNumber(json.total),
        cursor: getCursor(json),
        hasMore: getHasMore(json),
        hasFilteredComments: toNumber(json.has_filtered_comments) === 1
    }
}
