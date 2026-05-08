import type {AppsScriptRequestMessage, AppsScriptResponse, DownloadMessage, ScriptApiRequestMessage, ScriptApiResponse} from '../types'
import {
    idbAtomicEnqueueSheetsSync,
    idbDelete,
    idbDeleteSheetsSyncPayload,
    idbGet,
    idbGetCollectedVideoIds,
    idbGetCollectedVideoIdsLastSync,
    idbGetSheetsSyncPayload,
    idbGetSheetsSyncState,
    idbPut,
    idbPutCollectedVideoIds,
    idbPutCollectedVideoIdsLastSync,
    idbPutSheetsSyncPayload,
    idbPutSheetsSyncState,
    IDB_KEY,
    clearStaleCache,
    parseVideoMeta,
    type CachedVideo
} from './idb'
import {truncateError} from './errors'
import {loadHeaderCache, getHeaderValues, getHeaderStatus, setupHeaderListener} from './header-cache'
import {APPS_SCRIPT_TOKEN, APPS_SCRIPT_URL, SCRIPT_API_BASE, SCRIPT_API_KEY} from './env'

import {
    NOX_LOG,
    PREPARE_IG_TAB,
    PREPARE_TK_TAB,
    type PrepareIgTabResponse,
    type PrepareTkPageContextResponse,
    TK_COLLECT_PROGRESS,
    TK_COLLECT_REMOTE,
    TK_COLLECT_VIA_TAB,
    TK_PROFILE_METRICS_REMOTE,
    TK_PROFILE_METRICS_VIA_TAB,
    TK_PREPARE_PAGE_CONTEXT
} from './remote-collect'
import {delay} from './timing'
import {ensureTabReady, IG_TAB, TK_TAB} from './tab-manager'

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

async function doAppsScriptFetch(request: AppsScriptRequestMessage): Promise<AppsScriptResponse> {
    if (!APPS_SCRIPT_URL) {
        return {ok: false, status: 0, data: null, error: 'APPS_SCRIPT_URL 未配置'}
    }

    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
                action: request.action,
                payload: request.payload,
                token: APPS_SCRIPT_TOKEN
            })
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
            error: extractScriptApiError(data, `Apps Script 请求失败 (${response.status})`)
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

let appsScriptChain: Promise<unknown> = Promise.resolve()

async function requestAppsScript(request: AppsScriptRequestMessage): Promise<AppsScriptResponse> {
    const run = (): Promise<AppsScriptResponse> => doAppsScriptFetch(request)
    const next = appsScriptChain.then(run, run)
    appsScriptChain = next.catch(() => undefined)
    return next
}

const collectedVideoIdCache: Record<string, Set<string>> = {}
const collectedVideoIdInit: Record<string, Promise<void> | undefined> = {}
const collectedVideoIdDirty: Record<string, boolean> = {}
const collectedVideoIdSyncInflight: Record<string, Promise<void> | undefined> = {}
let collectedVideoIdFlushTimer: number | null = null
const COLLECTED_VIDEO_IDS_SYNC_INTERVAL_MS = 30_000

async function syncCollectedVideoIdsIncremental(platform: string): Promise<void> {
    if (collectedVideoIdSyncInflight[platform]) return collectedVideoIdSyncInflight[platform]
    collectedVideoIdSyncInflight[platform] = (async () => {
        const lastCursor = await idbGetCollectedVideoIdsLastSync(platform).catch(() => undefined)
        const payload: Record<string, unknown> = {platform}
        if (typeof lastCursor === 'number' && lastCursor > 0) payload.sinceRow = lastCursor

        const resp = await requestAppsScript({
            type: 'apps_script_request',
            action: 'getCollectedVideoIds',
            payload
        })
        if (!resp.ok) return

        const data = resp.data as {ok?: boolean; ids?: unknown[]; cursor?: unknown} | null
        const ids = Array.isArray(data?.ids) ? data!.ids! : []
        const newCursor = Number(data?.cursor)
        const set = collectedVideoIdCache[platform] || new Set<string>()
        let added = 0
        for (const id of ids) {
            const s = String(id || '')
            if (s && !set.has(s)) {
                set.add(s)
                added += 1
            }
        }
        collectedVideoIdCache[platform] = set
        if (added > 0) {
            try {
                await idbPutCollectedVideoIds(platform, Array.from(set))
            } catch {
            }
        }
        if (Number.isFinite(newCursor) && newCursor > 0) {
            try {
                await idbPutCollectedVideoIdsLastSync(platform, newCursor)
            } catch {
            }
        }
    })().finally(() => {
        collectedVideoIdSyncInflight[platform] = undefined
    })
    return collectedVideoIdSyncInflight[platform]
}

async function ensureCollectedVideoIdCache(platform: string): Promise<Set<string>> {
    if (!collectedVideoIdCache[platform]) {
        if (!collectedVideoIdInit[platform]) {
            collectedVideoIdInit[platform] = (async () => {
                const set = new Set<string>()
                try {
                    const persisted = await idbGetCollectedVideoIds(platform)
                    if (Array.isArray(persisted)) {
                        for (const id of persisted) {
                            const s = String(id || '')
                            if (s) set.add(s)
                        }
                    }
                } catch {
                }
                collectedVideoIdCache[platform] = set
                await syncCollectedVideoIdsIncremental(platform).catch(() => undefined)
            })()
        }
        await collectedVideoIdInit[platform]
    } else {
        const lastSync = await idbGetCollectedVideoIdsLastSync(platform).catch(() => undefined)
        if (!lastSync || Date.now() - lastSync >= COLLECTED_VIDEO_IDS_SYNC_INTERVAL_MS) {
            void syncCollectedVideoIdsIncremental(platform).catch(() => undefined)
        }
    }
    return collectedVideoIdCache[platform] || new Set<string>()
}

function scheduleCollectedVideoIdFlush(): void {
    if (collectedVideoIdFlushTimer !== null) return
    collectedVideoIdFlushTimer = self.setTimeout(() => {
        collectedVideoIdFlushTimer = null
        for (const platform of Object.keys(collectedVideoIdDirty)) {
            if (!collectedVideoIdDirty[platform]) continue
            collectedVideoIdDirty[platform] = false
            const cache = collectedVideoIdCache[platform]
            if (!cache) continue
            void idbPutCollectedVideoIds(platform, Array.from(cache)).catch(() => undefined)
        }
    }, 2000) as unknown as number
}

function ingestUpsertedVideoIds(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const p = payload as {platform?: string; videos?: unknown}
    const platform = String(p.platform || 'tiktok')
    const cache = collectedVideoIdCache[platform]
    if (!cache) return
    const videos = Array.isArray(p.videos) ? p.videos : []
    let added = 0
    for (const v of videos) {
        const vid = (v as {videoId?: unknown})?.videoId
        const s = String(vid || '')
        if (s && !cache.has(s)) {
            cache.add(s)
            added += 1
        }
    }
    if (added > 0) {
        collectedVideoIdDirty[platform] = true
        scheduleCollectedVideoIdFlush()
    }
}

function classifyIgTabError(e: unknown): {reason: string; error: string} {
    const raw = e instanceof Error ? e.message : String(e)
    const error = truncateError(raw, 500)
    const lower = error.toLowerCase()

    if (lower.includes('timeout_waiting_for_ig_tab_complete')) {
        return {reason: 'ig_tab_timeout', error}
    }
    if (lower.includes('timeout_waiting_for_tab_complete')) {
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

async function ensureIgTabReady(windowId?: number): Promise<{ok: true; tab: chrome.tabs.Tab} | {ok: false; reason: string; error: string}> {
    const prepared = await ensureTabReady(IG_TAB, {windowId})
    if (!prepared.ok) {
        return {ok: false, ...classifyIgTabError(prepared.error)}
    }

    return prepared
}

async function ensureTikTokTabReady(returnToTabId?: number, targetUrl?: string, windowId?: number): Promise<{ok: true; tab: chrome.tabs.Tab; href: string} | {ok: false; reason: string; error: string}> {
    const prepared = await ensureTabReady(TK_TAB, {
        activate: true,
        readySelector: '#app',
        returnToTabId,
        selectorTimeoutMs: 15000,
        targetUrl,
        windowId
    })
    if (!prepared.ok) {
        return {ok: false, reason: 'tk_tab_error', error: prepared.error}
    }

    let lastError = 'tk_page_context_not_ready'
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            const warmup = await chrome.tabs.sendMessage(prepared.tab.id!, {type: TK_PREPARE_PAGE_CONTEXT}) as PrepareTkPageContextResponse | undefined
            if (warmup?.ok) {
                return {
                    ok: true,
                    tab: prepared.tab,
                    href: typeof warmup.href === 'string' ? warmup.href : (prepared.tab.url || '')
                }
            }

            lastError = warmup?.error || lastError
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
        }

        await delay(400)
    }

    return {
        ok: false,
        reason: 'tk_page_context_error',
        error: truncateError(lastError, 500)
    }
}

setupHeaderListener()
void loadHeaderCache()
void clearStaleCache()

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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

    if (request.type === 'apps_script_request') {
        ;(async () => {
            const response = await requestAppsScript(request as AppsScriptRequestMessage)
            if (response.ok && (request as AppsScriptRequestMessage).action === 'upsertVideos') {
                ingestUpsertedVideoIds((request as AppsScriptRequestMessage).payload)
            }
            sendResponse(response)
        })()
        return true
    }

    if (request.type === 'get_collected_video_ids') {
        ;(async () => {
            try {
                const platform = String((request as {platform?: unknown}).platform || 'tiktok')
                const set = await ensureCollectedVideoIdCache(platform)
                sendResponse({ok: true, ids: Array.from(set)})
            } catch (error) {
                sendResponse({ok: false, ids: [], error: truncateError(error instanceof Error ? error.message : String(error), 500)})
            }
        })()
        return true
    }

    if (request.type === 'sheets_sync_payload_put') {
        ;(async () => {
            try {
                const id = Number(request.id)
                if (!Number.isFinite(id)) {
                    sendResponse({ok: false, error: 'invalid_payload_id'})
                    return
                }
                await idbPutSheetsSyncPayload(id, request.payload)
                sendResponse({ok: true})
            } catch (error) {
                sendResponse({ok: false, error: truncateError(error instanceof Error ? error.message : String(error), 500)})
            }
        })()
        return true
    }

    if (request.type === 'sheets_sync_payload_get') {
        ;(async () => {
            try {
                const id = Number(request.id)
                if (!Number.isFinite(id)) {
                    sendResponse({ok: false, error: 'invalid_payload_id'})
                    return
                }
                const payload = await idbGetSheetsSyncPayload(id)
                sendResponse({ok: true, payload})
            } catch (error) {
                sendResponse({ok: false, error: truncateError(error instanceof Error ? error.message : String(error), 500)})
            }
        })()
        return true
    }

    if (request.type === 'sheets_sync_payload_delete') {
        ;(async () => {
            try {
                const id = Number(request.id)
                if (!Number.isFinite(id)) {
                    sendResponse({ok: false, error: 'invalid_payload_id'})
                    return
                }
                await idbDeleteSheetsSyncPayload(id)
                sendResponse({ok: true})
            } catch (error) {
                sendResponse({ok: false, error: truncateError(error instanceof Error ? error.message : String(error), 500)})
            }
        })()
        return true
    }

    if (request.type === 'sheets_sync_state_get') {
        ;(async () => {
            try {
                const state = await idbGetSheetsSyncState()
                sendResponse({ok: true, payload: state})
            } catch (error) {
                sendResponse({ok: false, error: truncateError(error instanceof Error ? error.message : String(error), 500)})
            }
        })()
        return true
    }

    if (request.type === 'sheets_sync_state_put') {
        ;(async () => {
            try {
                await idbPutSheetsSyncState(request.state)
                sendResponse({ok: true})
            } catch (error) {
                sendResponse({ok: false, error: truncateError(error instanceof Error ? error.message : String(error), 500)})
            }
        })()
        return true
    }

    if (request.type === 'sheets_sync_atomic_enqueue') {
        ;(async () => {
            try {
                const id = Number(request.id)
                if (!Number.isFinite(id)) {
                    sendResponse({ok: false, error: 'invalid_payload_id'})
                    return
                }
                await idbAtomicEnqueueSheetsSync(id, request.payload, request.state)
                sendResponse({ok: true})
            } catch (error) {
                sendResponse({ok: false, error: truncateError(error instanceof Error ? error.message : String(error), 500)})
            }
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

    if (request.type === PREPARE_IG_TAB) {
        ;(async () => {
            const prepared = await ensureIgTabReady(sender.tab?.windowId)
            if (!prepared.ok) {
                const response: PrepareIgTabResponse = {ok: false, reason: prepared.reason, error: prepared.error}
                sendResponse(response)
                return
            }

            const response: PrepareIgTabResponse = {ok: true, tabId: prepared.tab.id}
            sendResponse(response)
        })()
        return true
    }

    if (request.type === PREPARE_TK_TAB) {
        ;(async () => {
            const targetUrl = typeof request.url === 'string' ? request.url : undefined
            const prepared = await ensureTikTokTabReady(sender.tab?.id, targetUrl, sender.tab?.windowId)
            if (!prepared.ok) {
                sendResponse({ok: false, reason: prepared.reason, error: prepared.error})
                return
            }

            sendResponse({ok: true, tabId: prepared.tab.id, href: prepared.href})
        })()
        return true
    }

    if (request.type === TK_COLLECT_PROGRESS) {
        ;(async () => {
            try {
                const clientTabId = typeof request.clientTabId === 'number' ? request.clientTabId : 0
                const message = typeof request.message === 'string' ? request.message : ''
                if (clientTabId && message) {
                    await chrome.tabs.sendMessage(clientTabId, {type: NOX_LOG, message})
                }
                sendResponse({ok: true})
            } catch (error) {
                sendResponse({ok: false, error: truncateError(error instanceof Error ? error.message : String(error), 500)})
            }
        })()
        return true
    }

    if (request.type === 'reset_tk_tab') {
        ;(async () => {
            try {
                const tabId = typeof request.tabId === 'number' ? request.tabId : (sender.tab?.id || 0)
                if (!tabId) {
                    sendResponse({ok: false, error: 'invalid_tab_id'})
                    return
                }
                const allCookies = await chrome.cookies.getAll({})
                const cookies = allCookies.filter(c => c.domain === 'tiktok.com' || c.domain.endsWith('.tiktok.com'))
                let removeFailed = 0
                for (const c of cookies) {
                    const protocol = c.secure ? 'https' : 'http'
                    const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain
                    try {
                        await chrome.cookies.remove({url: `${protocol}://${domain}${c.path}`, name: c.name})
                    } catch {
                        removeFailed += 1
                    }
                }
                await chrome.tabs.remove(tabId)
                sendResponse({ok: true, removed: cookies.length - removeFailed, removeFailed, closedTabs: 1})
            } catch (error) {
                sendResponse({ok: false, error: String(error)})
            }
        })()
        return true
    }

    if (request.type === 'nox_search_request') {
        ;(async () => {
            try {
                const response = await fetch(request.url, {
                    headers: {accept: 'application/json'}
                })
                const text = await response.text()
                const data = text.startsWith('{') ? JSON.parse(text) : null
                sendResponse({ok: response.ok, status: response.status, data})
            } catch (error) {
                sendResponse({ok: false, status: 0, data: null, error: String(error)})
            }
        })()
        return true
    }

    if (request.type === TK_PROFILE_METRICS_VIA_TAB) {
        ;(async () => {
            try {
                const tabId = typeof request.tabId === 'number' ? request.tabId : 0
                const clientTabId = sender.tab?.id || 0
                if (!tabId) {
                    sendResponse({ok: false, error: 'invalid_tab_id'})
                    return
                }

                const result = await chrome.tabs.sendMessage(tabId, {
                    type: TK_PROFILE_METRICS_REMOTE,
                    clientTabId,
                    username: request.username,
                    minLikeRate: request.minLikeRate,
                    maxDurationSec: request.maxDurationSec,
                })
                sendResponse(result)
            } catch (error) {
                sendResponse({ok: false, error: truncateError(error instanceof Error ? error.message : String(error), 500)})
            }
        })()
        return true
    }

    if (request.type === TK_COLLECT_VIA_TAB) {
        ;(async () => {
            try {
                const tabId = typeof request.tabId === 'number' ? request.tabId : 0
                const clientTabId = sender.tab?.id || 0
                if (!tabId) {
                    sendResponse({ok: false, error: 'invalid_tab_id'})
                    return
                }

                const result = await chrome.tabs.sendMessage(tabId, {
                    type: TK_COLLECT_REMOTE,
                    clientTabId,
                    username: request.username,
                    maxVideoCount: request.maxVideoCount,
                    fromTs: request.fromTs,
                    toTs: request.toTs,
                    minLikeRate: request.minLikeRate,
                    maxDurationSec: request.maxDurationSec,
                    startYear: request.startYear,
                    endYear: request.endYear,
                    filenamePrefix: request.filenamePrefix,
                    sortType: request.sortType
                })
                sendResponse(result)
            } catch (error) {
                sendResponse({ok: false, error: truncateError(error instanceof Error ? error.message : String(error), 500)})
            }
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

                const prepared = await ensureIgTabReady(sender.tab?.windowId)
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
