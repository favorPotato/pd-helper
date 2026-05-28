// 注意：x-web-session-id 是客户端 web 标识，不是 auth cookie `sessionid`
// 这些头仅用于对齐请求形态，未证实是上传失败的根因
const CACHE_KEYS = ['x-ig-www-claim', 'x-instagram-ajax', 'x-web-session-id'] as const
const STORAGE_KEY = 'ig_bridge_header_cache_v1'

interface HeaderCache {
    'x-ig-www-claim': string
    'x-instagram-ajax': string
    'x-web-session-id': string
    lastSeenAt: number
}

export interface HeaderValues {
    claim: string
    ajax: string
    webSid: string
}

export interface HeaderStatus {
    claim: boolean
    ajax: boolean
    webSid: boolean
    lastSeenAt: number
}

let headerCache: HeaderCache = {
    'x-ig-www-claim': '',
    'x-instagram-ajax': '',
    'x-web-session-id': '',
    lastSeenAt: 0
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSaveHeaderCache(): void {
    if (saveTimer) return
    saveTimer = setTimeout(async () => {
        saveTimer = null
        try {
            await chrome.storage.session.set({[STORAGE_KEY]: headerCache})
        } catch {
        }
    }, 500)
}

function normalizeHeaderName(name: string | undefined): string {
    return String(name || '').toLowerCase()
}

export async function loadHeaderCache(): Promise<void> {
    try {
        const data = await chrome.storage.session.get(STORAGE_KEY)
        const stored = data && data[STORAGE_KEY]
        if (stored && typeof stored === 'object') {
            headerCache = {...headerCache, ...stored}
        }
    } catch {
    }
}

export function getHeaderValues(): HeaderValues {
    return {
        claim: headerCache['x-ig-www-claim'] || '',
        ajax: headerCache['x-instagram-ajax'] || '',
        webSid: headerCache['x-web-session-id'] || ''
    }
}

export function getHeaderStatus(): HeaderStatus {
    return {
        claim: Boolean(headerCache['x-ig-www-claim']),
        ajax: Boolean(headerCache['x-instagram-ajax']),
        webSid: Boolean(headerCache['x-web-session-id']),
        lastSeenAt: headerCache.lastSeenAt || 0
    }
}

function maybeUpdateFromHeaders(requestHeaders: chrome.webRequest.HttpHeader[]): void {
    if (!Array.isArray(requestHeaders)) return

    let changed = false
    for (const h of requestHeaders) {
        const nk = normalizeHeaderName(h?.name) as (typeof CACHE_KEYS)[number]
        if (!CACHE_KEYS.includes(nk)) continue
        const v = String(h?.value || '')
        if (!v) continue
        if (headerCache[nk] !== v) {
            headerCache[nk] = v
            changed = true
        }
    }

    if (changed) {
        headerCache.lastSeenAt = Date.now()
        scheduleSaveHeaderCache()
    }
}

export function setupHeaderListener(): void {
    chrome.webRequest.onBeforeSendHeaders.addListener(
        (details) => {
            try {
                maybeUpdateFromHeaders(details.requestHeaders || [])
            } catch {
            }
            return undefined
        },
        {
            urls: [
                'https://www.instagram.com/*',
                'https://i.instagram.com/*',
                'https://*.instagram.com/*'
            ]
        },
        ['requestHeaders', 'extraHeaders']
    )
}
