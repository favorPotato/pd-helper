import type {DownloadMessage, ScriptApiRequestMessage, ScriptApiResponse, ScriptApiUploadFile} from '../types'
import {idbGet, idbPut, idbDelete, IDB_KEY, clearStaleCache, parseVideoMeta, type CachedVideo} from './idb'
import {truncateError} from './errors'
import {loadHeaderCache, getHeaderValues, getHeaderStatus, setupHeaderListener} from './header-cache'
import {SCRIPT_API_BASE, SCRIPT_API_KEY} from './env'

// Bridge lock to prevent multi-tab race conditions
let bridgeLock = {held: false, since: 0}
const LOCK_TTL_MS = 2 * 60 * 1000 // 2 minutes

function acquireLock(): boolean {
    const now = Date.now()
    if (bridgeLock.held && now - bridgeLock.since < LOCK_TTL_MS) {
        return false // Lock held and not expired
    }
    bridgeLock = {held: true, since: now}
    return true
}

function releaseLock(): void {
    bridgeLock = {held: false, since: 0}
}

const IG_MATCH_RE = /^https:\/\/www\.instagram\.com\//

function parseJsonIfPossible(text: string): unknown {
    if (!text) return null
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

function extractScriptApiError(data: unknown, fallback: string): string {
    if (typeof data === 'string' && data.trim()) {
        return truncateError(data, 500)
    }

    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const record = data as Record<string, unknown>
        const candidates = [record.error, record.message, record.detail, record.msg]
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) {
                return truncateError(candidate, 500)
            }
        }
        try {
            return truncateError(JSON.stringify(record), 500)
        } catch {
        }
    }

    return fallback
}

async function requestScriptApi(request: ScriptApiRequestMessage): Promise<ScriptApiResponse> {
    if (!SCRIPT_API_BASE) {
        return {ok: false, status: 0, data: null, error: 'SCRIPT_API_BASE 未配置'}
    }

    if (!SCRIPT_API_KEY) {
        return {ok: false, status: 0, data: null, error: 'SCRIPT_API_KEY 未配置'}
    }

    try {
        const url = `${SCRIPT_API_BASE}${request.endpoint}`
        const method = request.method || (request.body === undefined ? 'GET' : 'POST')
        const headers: Record<string, string> = {
            accept: 'application/json, text/plain, */*',
            'x-api-key': SCRIPT_API_KEY
        }

        let body: BodyInit | undefined
        if (request.bodyType === 'multipart') {
            const formData = new FormData()
            formData.set('media', typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {}))

            for (const file of Array.isArray(request.files) ? request.files : []) {
                const bytes = new Uint8Array(Array.isArray(file.bytes) ? file.bytes : [])
                const blob = new Blob([bytes], {type: file.mimeType || 'application/octet-stream'})
                formData.append('media_files', blob, file.filename || 'media.bin')
            }

            body = formData
        } else if (request.body !== undefined) {
            headers['content-type'] = 'application/json'
            body = JSON.stringify(request.body)
        }

        const response = await fetch(url, {
            method,
            headers,
            body
        })
        const text = await response.text()
        const data = parseJsonIfPossible(text)

        if (response.ok) {
            return {ok: true, status: response.status, data}
        }

        return {
            ok: false,
            status: response.status,
            data,
            error: extractScriptApiError(data, `请求失败 (${response.status})`)
        }
    } catch (error) {
        return {
            ok: false,
            status: 0,
            data: null,
            error: truncateError(error instanceof Error ? error.message : String(error), 500)
        }
    }
}

function classifyIgTabError(e: unknown): {reason: string; error: string} {
    const raw = e instanceof Error ? e.message : String(e)
    const error = truncateError(raw, 500)
    const lower = error.toLowerCase()

    if (lower.includes('timeout_waiting_for_ig_tab_complete')) {
        return {reason: 'ig_tab_timeout', error}
    }
    if (lower.includes('could not establish connection') || lower.includes('receiving end does not exist')) {
        return {reason: 'ig_sendMessage_failed', error}
    }
    if (lower.includes('cannot access a chrome:// url') || lower.includes('cannot access contents of url')) {
        return {reason: 'ig_inject_failed', error}
    }
    return {reason: 'ig_tab_error', error}
}

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

async function getOrCreateIgTab(): Promise<chrome.tabs.Tab> {
    const tabs = await chrome.tabs.query({url: 'https://www.instagram.com/*'})

    if (tabs.length > 0) {
        return tabs[0]
    }

    return await chrome.tabs.create({
        url: 'https://www.instagram.com/',
        active: false
    })
}

async function ensureIgTabReady(): Promise<{ok: true; tab: chrome.tabs.Tab} | {ok: false; reason: string; error: string}> {
    try {
        const tab = await getOrCreateIgTab()
        try {
            await waitForTabComplete(tab.id!)
        } catch (e) {
            return {ok: false, ...classifyIgTabError(new Error(`ig_wait_complete_failed: ${String(e)}`))}
        }

        try {
            await ensureContentScript(tab.id!)
        } catch (e) {
            return {ok: false, ...classifyIgTabError(new Error(`ig_ensure_cs_failed: ${String(e)}`))}
        }

        return {ok: true, tab}
    } catch (e) {
        return {ok: false, ...classifyIgTabError(e)}
    }
}

async function waitForTabComplete(tabId: number, timeoutMs = 20000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const tab = await chrome.tabs.get(tabId)
        if (tab.status === 'complete' && IG_MATCH_RE.test(tab.url || '')) return
        await delay(250)
    }
    throw new Error('timeout_waiting_for_ig_tab_complete')
}

async function pingContentScript(tabId: number): Promise<unknown> {
    return await chrome.tabs.sendMessage(tabId, {type: 'ping'})
}

async function ensureContentScript(tabId: number): Promise<void> {
    try {
        await pingContentScript(tabId)
        return
    } catch {
    }

    await chrome.scripting.executeScript({
        target: {tabId},
        files: ['content.js']
    })

    await delay(500)
    await pingContentScript(tabId)
}

setupHeaderListener()
void loadHeaderCache()
void clearStaleCache()

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!request || typeof request !== 'object') return

    if (request.action === 'download') {
        if (typeof request.url !== 'string' || typeof request.filename !== 'string') return
        const msg = request as DownloadMessage
        void chrome.downloads.download({url: msg.url, filename: msg.filename})
        return
    }

    if (request.type === 'get_header_status') {
        sendResponse(getHeaderStatus())
        return
    }

    if (request.type === 'get_header_values') {
        sendResponse(getHeaderValues())
        return
    }

    if (request.type === 'get_ig_cookies') {
        ;(async () => {
            try {
                const targetUrl = 'https://www.instagram.com'
                const names = ['ds_user_id', 'sessionid', 'csrftoken']
                const result: Record<string, string> = {}
                for (const name of names) {
                    const cookie = await chrome.cookies.get({url: targetUrl, name})
                    if (cookie?.value) result[name] = cookie.value
                }
                sendResponse({ok: true, cookies: result})
            } catch (e) {
                sendResponse({ok: false, error: String(e)})
            }
        })()
        return true
    }

    if (request.type === 'script_api_request') {
        ;(async () => {
            sendResponse(await requestScriptApi(request as ScriptApiRequestMessage))
        })()
        return true
    }

    if (request.type === 'cache_store_whole') {
        if (!Array.isArray(request.bytes) || request.bytes.length === 0) {
            sendResponse({ok: false, error: 'Invalid bytes format'})
            return true
        }
        if (!acquireLock()) {
            sendResponse({ok: false, error: 'bridge_in_progress'})
            return true
        }
        ;(async () => {
            try {
                const bytes = new Uint8Array(request.bytes)
                const value: CachedVideo = {
                    bytes: bytes.buffer,
                    mime: String(request.mime || 'video/mp4'),
                    name: String(request.name || 'video.mp4'),
                    meta: parseVideoMeta(request.meta),
                    createdAt: Date.now()
                }
                await idbPut(IDB_KEY, value)
                // Lock kept: released by open_ig_and_upload or cache_clear
                sendResponse({ok: true})
            } catch (e) {
                releaseLock()
                sendResponse({ok: false, error: String(e)})
            }
        })()
        return true
    }

    if (request.type === 'cache_get_whole') {
        ;(async () => {
            try {
                const rec = await idbGet(IDB_KEY)
                if (!rec || !rec.bytes) {
                    sendResponse({ok: false, reason: 'missing'})
                    return
                }
                const bytes = new Uint8Array(rec.bytes)
                sendResponse({
                    ok: true,
                    bytes: Array.from(bytes),
                    mime: rec.mime || 'video/mp4',
                    meta: parseVideoMeta(rec.meta)
                })
            } catch (e) {
                sendResponse({ok: false, error: String(e)})
            }
        })()
        return true
    }

    if (request.type === 'cache_clear') {
        ;(async () => {
            try {
                await idbDelete(IDB_KEY)
                releaseLock()
                sendResponse({ok: true})
            } catch (e) {
                releaseLock()
                sendResponse({ok: false, error: String(e)})
            }
        })()
        return true
    }

    if (request.type === 'prepare_ig_tab') {
        ;(async () => {
            const prepared = await ensureIgTabReady()
            if (!prepared.ok) {
                sendResponse({ok: false, reason: prepared.reason, error: prepared.error})
                return
            }

            sendResponse({ok: true, tabId: prepared.tab.id})
        })()
        return true
    }

    if (request.type === 'open_ig_and_upload') {
        const caption = typeof request.caption === 'string' ? request.caption : ''
        ;(async () => {
            try {
                const rec = await idbGet(IDB_KEY)
                if (!rec) {
                    releaseLock()
                    sendResponse({ok: false, reason: 'no_cached_video'})
                    return
                }

                const prepared = await ensureIgTabReady()
                if (!prepared.ok) {
                    releaseLock()
                    sendResponse({ok: false, reason: prepared.reason, error: prepared.error})
                    return
                }

                let result: unknown
                try {
                    result = await chrome.tabs.sendMessage(prepared.tab.id!, {
                        type: 'start_upload',
                        caption
                    })
                } catch (e) {
                    releaseLock()
                    const {reason, error} = classifyIgTabError(new Error(`ig_send_message_failed: ${String(e)}`))
                    sendResponse({ok: false, reason, error})
                    return
                }

                releaseLock()
                sendResponse({ok: true, uploadResult: result})
            } catch (e) {
                releaseLock()
                const {reason, error} = classifyIgTabError(e)
                sendResponse({ok: false, reason, error})
            }
        })()
        return true
    }
})
