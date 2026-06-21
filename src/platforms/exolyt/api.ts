import {withPdCode} from '../../shared/cli-bridge/cs-runtime'
import type {ExolytSearchParams, ExolytSearchResult, ExolytVideoDetail} from './types'

// exolyt 后端 API 封装（1.2）：CS 端握手内聚于此（架构五层无 client.ts），借 page-bridge 走同源 JWT 发往 backend.exolyt.com
// 范式 A：JWT 取值在 page-bridge 页面端完成（auth:true），token 不出页面上下文；本层只发「目标 url + auth 标志」
// 错误归一：会话失效→LOGIN_REQUIRED、限流→RATE_LIMITED、握手失败/超时带 [CODE] 前缀，全经 withPdCode 打码

const BACKEND_ORIGIN = 'https://backend.exolyt.com'

// 单次 page_fetch 自身超时（对齐 tk pageFetch timeoutMs）；握手就绪超时对齐 tk client.ts 5s
const PAGE_FETCH_TIMEOUT_MS = 15000
const BRIDGE_READY_TIMEOUT_MS = 5000

interface PageFetchPayload {
    ok: boolean
    status: number
    contentType: string
    text: string
}

declare const chrome: typeof globalThis.chrome

declare global {
    interface Window {
        __EXOLYT_BRIDGE_READY__?: boolean
        __EXOLYT_BRIDGE_READY_PROMISE__?: Promise<void> | null
        __EXOLYT_PAGE_FETCH_HANDLER_LOADED__?: boolean
    }
}

const pageFetchPending = new Map<string, { resolve: (payload: PageFetchPayload) => void; reject: (error: Error) => void; timer: number }>()
let pageFetchSeq = 0

// 幂等注册一次回包监听：按 requestId 匹配 pending，error → reject、否则 resolve 结构化 payload
function registerPageFetchHandler(): void {
    if (window.__EXOLYT_PAGE_FETCH_HANDLER_LOADED__) return
    window.__EXOLYT_PAGE_FETCH_HANDLER_LOADED__ = true

    window.addEventListener('message', (event: MessageEvent) => {
        if (event.source !== window) return

        const msg = event.data as { type?: string; requestId?: string; ok?: boolean; status?: number; contentType?: string; text?: string; error?: string }
        if (!msg || msg.type !== 'exolyt/page_fetch_result' || !msg.requestId) return

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

// 复位就绪状态：清 window 残留标志与缓存 promise，下一次 injectPageBridge 即重走注入+握手。
// 仅由 pageFetch 超时（确定失败）调用——页面端注入脚本自防重，重注入时若监听器尚在则只补发一次 ready、不重建。
function resetBridgeReady(): void {
    window.__EXOLYT_BRIDGE_READY__ = false
    window.__EXOLYT_BRIDGE_READY_PROMISE__ = null
}

// 注入 page-bridge 并等就绪：已就绪直 resolve、并发共享同一 Promise、5s 超时 reject、.finally 失败清空允许重试
// exolyt 与 tk 差异：无 CAPTCHA 检测、注入产物名为 exolyt-page-bridge.js
function injectPageBridge(): Promise<void> {
    if (window.__EXOLYT_BRIDGE_READY__) {
        return Promise.resolve()
    }

    if (window.__EXOLYT_BRIDGE_READY_PROMISE__) {
        return window.__EXOLYT_BRIDGE_READY_PROMISE__
    }

    window.__EXOLYT_BRIDGE_READY_PROMISE__ = new Promise<void>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
            cleanup()
            reject(new Error('page_bridge_ready_timeout'))
        }, BRIDGE_READY_TIMEOUT_MS)

        function cleanup(): void {
            clearTimeout(timeoutId)
            window.removeEventListener('message', onReady)
        }

        function onReady(event: MessageEvent): void {
            if (event.source !== window) return
            const msg = event.data as { type?: string }
            if (!msg || msg.type !== 'exolyt/page_bridge_ready') return
            window.__EXOLYT_BRIDGE_READY__ = true
            cleanup()
            resolve()
        }

        window.addEventListener('message', onReady)

        const script = document.createElement('script')
        script.src = chrome.runtime.getURL('exolyt-page-bridge.js')
        script.async = false
        script.onload = () => script.remove()
        script.onerror = () => {
            cleanup()
            reject(new Error('page_bridge_inject_failed'))
        }
        ;(document.head || document.documentElement).appendChild(script)
    }).finally(() => {
        if (!window.__EXOLYT_BRIDGE_READY__) {
            window.__EXOLYT_BRIDGE_READY_PROMISE__ = null
        }
    })

    return window.__EXOLYT_BRIDGE_READY_PROMISE__
}

// 单次页面 fetch：握手就绪后经 exolyt/page_fetch 触发，auth:true 则 page 端先取同源 session token 再带 Bearer
async function pageFetch(url: string, init: RequestInit, auth: boolean): Promise<PageFetchPayload> {
    registerPageFetchHandler()
    await injectPageBridge()

    pageFetchSeq += 1
    const requestId = `req_${Date.now()}_${pageFetchSeq}`

    return await new Promise<PageFetchPayload>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            pageFetchPending.delete(requestId)
            // 桥失效兜底：postMessage 无人应答而超时，说明页面端监听器已随 SPA 软导航/dev-reload 丢失而 window 标志仍残留。
            // 复位就绪标志与缓存 promise，使下一次 pageFetch 重走注入+握手——仅在此确定失败路径触发，正常往返不受影响。
            resetBridgeReady()
            reject(new Error('page_fetch_timeout'))
        }, PAGE_FETCH_TIMEOUT_MS)

        pageFetchPending.set(requestId, {resolve, reject, timer})
        window.postMessage({type: 'exolyt/page_fetch', requestId, url, init, auth}, '*')
    })
}

// 会话失效信号：page-bridge 端取 token 失败抛的 session_* / 后端 401 / 握手取不到 token
function isSessionFailure(message: string): boolean {
    return message.startsWith('session_')
}

// 归一握手/通道错误为带 [CODE] 前缀错误 + withPdCode 打码；会话失效就近归 LOGIN_REQUIRED，余者归 UNKNOWN_ERROR
function normalizeBridgeError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error)
    if (isSessionFailure(message)) {
        return withPdCode(new Error(`[LOGIN_REQUIRED] exolyt 会话失效：${message}`), 'LOGIN_REQUIRED')
    }
    return withPdCode(new Error(`[UNKNOWN_ERROR] exolyt page-bridge 握手/通道失败：${message}`), 'UNKNOWN_ERROR')
}

// 后端 HTTP 状态归一：401→LOGIN_REQUIRED、429→RATE_LIMITED、其余非 2xx→UNKNOWN_ERROR，均带 [CODE] 前缀
function throwForStatus(status: number): never {
    if (status === 401) {
        throw withPdCode(new Error(`[LOGIN_REQUIRED] exolyt 后端 401 会话失效`), 'LOGIN_REQUIRED')
    }
    if (status === 429) {
        throw withPdCode(new Error(`[RATE_LIMITED] exolyt 后端 429 限流`), 'RATE_LIMITED')
    }
    throw withPdCode(new Error(`[UNKNOWN_ERROR] exolyt 后端请求失败：${status}`), 'UNKNOWN_ERROR')
}

// 把 page-bridge 回传的 text 解析为 JSON；空体或非 JSON 时返回 null（上层按需判 raw）
function parseBody(text: string): unknown {
    const trimmed = text.trim()
    if (!trimmed) return null
    try {
        return JSON.parse(trimmed)
    } catch {
        return null
    }
}

export interface ExolytApiRaw {
    ok: boolean
    status: number
    body: unknown
}

// 后端访问层：path 拼 backend.exolyt.com、auth:true 由 page 端注入 Bearer、返回结构化 raw（含 ok/status/解析 body）
// 注意：非 2xx 不在此 throw，由调用方据 raw.ok/status 决定归一（search/detail 走 throwForStatus），保留 raw 供上层取数
export async function exolytApiFetch(path: string, init: RequestInit = {}): Promise<ExolytApiRaw> {
    const url = path.startsWith('http') ? path : `${BACKEND_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`

    let payload: PageFetchPayload
    try {
        payload = await pageFetch(url, init, true)
    } catch (error) {
        throw normalizeBridgeError(error)
    }

    return {
        ok: payload.ok,
        status: payload.status,
        body: parseBody(payload.text)
    }
}

// search 响应条目遍历单一出口：收敛容器探测规则到此一处，extractVideoIds 与
// collector.buildSearchDurationMap（取 duration）共用——避免容器名/字段名规则两份手抄、后端改名漏改一处。
// 实测对账 examples/exolyt/search.js：真实结构为 data.videos[]；余路径留作宽松兜底（后端结构变更时不致全空）。
// 返回首个「能提取出至少一条有效 videoId 对象」的容器中的对象条目；据「有 id 的对象」判定容器有效，
// 防空 data.videos / 无 id 噪声数组短路掩盖后面真正带数据的容器。
export function extractSearchItems(body: unknown): Array<Record<string, unknown>> {
    if (!body || typeof body !== 'object') return []
    const record = body as Record<string, unknown>
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : undefined
    const containers = [data?.videos, record.videos, record.items, record.results, record.data, body]
    for (const container of containers) {
        if (!Array.isArray(container)) continue
        const items = container.filter(
            (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
        )
        if (items.some((item) => extractVideoId(item))) return items
    }
    return []
}

// 从后端 search 响应提取 videoId 列表（复用 extractSearchItems 单一出口）；videoId 强类型化属 1.3/1.4
function extractVideoIds(body: unknown): string[] {
    return extractSearchItems(body)
        .map((item) => extractVideoId(item))
        .filter((id): id is string => Boolean(id))
}

// 实测：search item / detail 顶层均以 id 为 videoId 字段；保留 videoId/video_id 兜底应对结构差异
function extractVideoId(item: unknown): string {
    if (!item || typeof item !== 'object') return ''
    const record = item as Record<string, unknown>
    const candidate = record.id ?? record.videoId ?? record.video_id
    return typeof candidate === 'string' ? candidate : typeof candidate === 'number' ? String(candidate) : ''
}

// searchVideos = POST /video-insight/search：body 用后端名透传（不组装 9 字段/不校验/不映射/不填默认，属 1.3）
export async function searchVideos(params: ExolytSearchParams): Promise<ExolytSearchResult> {
    const raw = await exolytApiFetch('/video-insight/search', {
        method: 'POST',
        body: JSON.stringify(params)
    })

    if (!raw.ok) {
        throwForStatus(raw.status)
    }

    return {
        videoIds: extractVideoIds(raw.body),
        raw: raw.body
    }
}

// fetchDetail = GET /videos/{id}：拼 path 调通返回结构化 raw，最小提取 videoId
export async function fetchDetail(id: string): Promise<ExolytVideoDetail> {
    const raw = await exolytApiFetch(`/videos/${id}`, {method: 'GET'})

    if (!raw.ok) {
        throwForStatus(raw.status)
    }

    const body = raw.body
    const videoId = extractVideoId(body) || id

    return {
        videoId,
        raw: body
    }
}
