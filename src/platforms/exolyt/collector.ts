import type {CsRuntime} from '../../shared/cli-bridge/cs-runtime'
import type {ExolytRawSearchInput, ExolytVideoDetail} from './types'
import {searchVideos, fetchDetail as defaultFetchDetail} from './api'
import {resolveSearchBody, parseSearchUrl, SEARCH_RESULT_LIMIT} from './search-params'
import {clampConcurrency, makeCircuitBreaker, runWithConcurrency} from './concurrency'
import {withPdCode} from '../../shared/cli-bridge/cs-runtime'
import {enqueueUpsertVideos} from '../../shared/sheets-sync'


// 远程去重权威 = SW 端 get_collected_video_ids（platform='exolyt'），不落本地状态文件
// 去重源不可用按红线中止而非静默跳过：拉取失败/SW 回 ok:false 一律带 [CODE] 抛错，绝不当空集放行重采
async function loadCollectedVideoIdSet(): Promise<Set<string>> {
    const resp = await chrome.runtime.sendMessage({
        type: 'get_collected_video_ids',
        platform: 'exolyt'
    }) as {ok?: boolean; ids?: string[]; error?: string} | undefined
    if (!resp || resp.ok !== true) {
        const detail = resp?.error ? `：${resp.error}` : ''
        throw withPdCode(new Error(`[UNKNOWN_ERROR] exolyt 去重源不可用，已采集合获取失败${detail}`), 'UNKNOWN_ERROR')
    }
    const ids = Array.isArray(resp.ids) ? resp.ids : []
    return new Set(ids.map(id => String(id)))
}

// 链路A 编排入口：三入口 → 映射 → 默认 → 校验 → 组装 9 字段 body → 调 searchVideos → ≤200 videoId
// → 1.4 接力：就地并发池 + 连续 3 错熔断 并发调 fetchDetail → 时长门过滤 → 返回过门 detail 列表交 1.5
// 本 story 终点 = 过门 detail 列表；不落盘（1.5）/不入队（1.6）/不下视频（链路B）/不推进 checkpoint（1.5）
export interface ExolytCollectInput {
    rawUrl?: string
    input?: ExolytRawSearchInput
    // 反风控并发数（默认 5、夹到 [1,15]）——内部参数，越界夹紧非失败
    concurrency?: number
}

// 连续错熔断阈值（沿用 nox paginator 的 3，FR-15 不复用 nox 文件就地另写）
const CIRCUIT_BREAKER_THRESHOLD = 3

// 时长硬门阈值（ms）：FB/IG 上传硬约束。Task 0 经窗口 31402 真实 GET /videos/{id} 实测——
// 字段名 = duration（非 epics 写的 videoDuration）、单位 = ms（实测 32508 对应 ~32.5s 短视频，s 量级不可能）
// 判门语义：duration > 60000 严格大于剔除、恰好 60000 保留；缺字段保守不剔除（宁多采不误删）
const DURATION_GATE_MS = 60000

// 图文硬门白名单：仅保留视频 contentType {0,55,61}，剔除其它（尤其 150=图文/图集）
// 用白名单而非黑名单——防平台后续新增未知 contentType 被误采（默认剔除比默认放行更安全）
// 注意：此 contentType 是 detail.raw 顶层的 number，非 api.ts 里 HTTP 响应头那个 content-type 字符串
const VIDEO_CONTENT_TYPES = new Set([0, 55, 61])

// 可注入 fetchDetail 便于 AC7 注入式 mock（验证时长门过滤/熔断/归一）；默认走 1.2 api.fetchDetail
export interface ExolytCollectDeps {
    fetchDetail?: (id: string) => Promise<ExolytVideoDetail>
}

// 从 detail.raw 取时长（ms）：实测 duration 在 raw 顶层。非有限数（缺字段/结构异常）返回 null → 调用方保守不剔除
function readDurationMs(raw: unknown): number | null {
    if (!raw || typeof raw !== 'object') return null
    const value = (raw as Record<string, unknown>).duration
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// 从 detail.raw 顶层取 contentType（number）：8200 条实测 contentType 与 duration/height/width 完全捆绑，单看即足够
// 非有限 number（缺字段/结构异常）返回 null → 不在白名单视为剔除（守白名单语义，未知类型一律不放行）
function readContentType(raw: unknown): number | null {
    if (!raw || typeof raw !== 'object') return null
    const value = (raw as Record<string, unknown>).contentType
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// search 响应每条已带 duration（ms，实测；contentType 不带）。构建 videoId→duration 供 detail 前时长门预剔。
// 缺 duration 的不入 map → 保守不前置剔、留 detail 后时长门兜底
function buildSearchDurationMap(raw: unknown): Map<string, number> {
    const map = new Map<string, number>()
    if (!raw || typeof raw !== 'object') return map
    const record = raw as Record<string, unknown>
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : undefined
    const list = [data?.videos, record.videos, record.items, record.results].find(Array.isArray) as unknown[] | undefined
    if (!list) return map
    for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const r = item as Record<string, unknown>
        const id = r.id ?? r.videoId ?? r.video_id
        const dur = r.duration
        if ((typeof id === 'string' || typeof id === 'number') && typeof dur === 'number' && Number.isFinite(dur)) {
            map.set(String(id), dur)
        }
    }
    return map
}

export async function collectExolyt(
    params: ExolytCollectInput,
    rt: CsRuntime,
    deps: ExolytCollectDeps = {}
): Promise<ExolytVideoDetail[]> {
    rt.throwIfCancelled()

    // URL 入口优先：粘前端筛选 URL → 解析为后端名原始输入；否则用直传的条件表单/CLI KV
    const rawInput: ExolytRawSearchInput = params.rawUrl ? parseSearchUrl(params.rawUrl) : (params.input ?? {})

    // 组装 + 白名单校验：非法值在此经 withPdCode('INVALID_PARAM') 抛带前缀错误，绝不静默回落默认
    const body = resolveSearchBody(rawInput)
    rt.log(`[exolyt] search body 组装完成 sort=${body.sort} regions=${body.regions.join(',')} hashtags=${body.or?.length ?? 0}`)

    rt.throwIfCancelled()
    // body 为纯 JSON 可序列化对象（string/number/null/array），不含 Headers/AbortSignal/函数——避免 postMessage 结构化克隆静默丢字段
    const result = await searchVideos({...body})

    // ≤200 硬上限：page 固定单页不递增，后端单页即便 >200 也在此截断守上限
    const searched = result.videoIds.slice(0, SEARCH_RESULT_LIMIT)

    rt.throwIfCancelled()
    // detail 前用 search 自带的 duration 预剔省请求：① 去重剔已采；② 超时长 duration>60000；
    // ③ 图文 duration<=0（图文 duration=0，与 contentType=150 捆绑）。缺 duration 不前置剔，留 detail 后兜底。
    // contentType 不在 search 响应，detail 后图文门仍保留（双保险——search 未见过图文项，不全信 duration<=0）
    const searchDurationById = buildSearchDurationMap(result.raw)
    const collected = await loadCollectedVideoIdSet()
    let preOverDuration = 0
    let preImage = 0
    const videoIds = searched.filter(id => {
        if (collected.has(String(id))) return false
        const d = searchDurationById.get(String(id))
        if (d !== undefined) {
            if (d > DURATION_GATE_MS) { preOverDuration += 1; return false }
            if (d <= 0) { preImage += 1; return false }
        }
        return true
    })
    const dedupDropped = searched.length - videoIds.length - preOverDuration - preImage
    rt.log(`[exolyt] 检索 ${result.videoIds.length}、截断 ${searched.length}；去重剔 ${dedupDropped}、前置超时长剔 ${preOverDuration}、前置图文(dur≤0)剔 ${preImage}，待采 ${videoIds.length} 进 detail`)

    const fetchDetail = deps.fetchDetail ?? defaultFetchDetail
    const concurrency = clampConcurrency(params.concurrency)
    const breaker = makeCircuitBreaker(CIRCUIT_BREAKER_THRESHOLD)

    const gated: ExolytVideoDetail[] = []
    let done = 0
    let dropped = 0
    let imageDropped = 0

    // 主动心跳：大批 detail 并发 + 限流节流可能跨 60s 静默，每完成若干条主动 rt.log 防 isAlive 60s 误判 dead
    const HEARTBEAT_EVERY = 10

    await runWithConcurrency(videoIds, async (id) => {
        // worker 取数前自查取消（并发池 runSlot 已在取 item 前 throwIfCancelled，此处再守 detail 取数前一刻）
        rt.throwIfCancelled()
        try {
            const detail = await fetchDetail(id)
            // 成功返回即重置连续错计数——时长门剔除走成功路径、与熔断正交（AC4）
            breaker.recordOk()

            // 两门并列：任一门未过即丢弃，不 push 进 gated；时长 / 图文各自计数
            const durationMs = readDurationMs(detail.raw)
            const contentType = readContentType(detail.raw)
            // 时长门：duration > 60000ms 严格大于剔除（恰好 60000 保留）；缺字段保守不剔除
            const overDuration = durationMs !== null && durationMs > DURATION_GATE_MS
            // 图文门：keep iff contentType ∈ 白名单（number 比较，禁字符串）；非白名单（含图文 150/缺字段）剔除
            const notVideo = contentType === null || !VIDEO_CONTENT_TYPES.has(contentType)
            if (overDuration) {
                dropped += 1
            } else if (notVideo) {
                imageDropped += 1
            } else {
                gated.push(detail)
            }
        } catch (error) {
            // 仅 fetchDetail 抛错才算「错」参与连续计数；达阈值 recordErr 抛出（透传带 [CODE] 原 error，熔断不新增码）
            breaker.recordErr(error)
            // 未达阈值：单条错不中止整批（连续计数保留，下条成功会 recordOk 重置）
        } finally {
            done += 1
            if (done % HEARTBEAT_EVERY === 0 || done === videoIds.length) {
                rt.log(`[exolyt] detail 已采 ${done}/${videoIds.length}、过门 ${gated.length}、超时长剔除 ${dropped}、图文剔除 ${imageDropped}`)
            }
        }
    }, concurrency, rt)

    rt.log(`[exolyt] detail 采集收口：过门 ${gated.length} 条交 1.5（剔除超时长 ${dropped} 条、图文 ${imageDropped} 条）`)

    // 入队这批新采 videoId（已经远程去重，均为新采）：rows 对齐 tiktok 调用方的最小字段集 {videoId}
    if (gated.length > 0) {
        await enqueueUpsertVideos('exolyt', gated.map(d => ({videoId: d.videoId})))
        rt.log(`[exolyt] 已入队 ${gated.length} 条新采 videoId 待远程 upsert`)
    }

    return gated
}
