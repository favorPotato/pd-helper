import type {CsRuntime} from '../../shared/cli-bridge/cs-runtime'
import type {ExolytRawSearchInput, ExolytVideoDetail} from './types'
import {searchVideos, fetchDetail as defaultFetchDetail} from './api'
import {resolveSearchBody, parseSearchUrl, SEARCH_RESULT_LIMIT} from './search-params'
import {clampConcurrency, runWithConcurrency} from '../../shared/collect/concurrency'
import {makeCircuitBreaker} from '../../shared/collect/circuit-breaker'
import {withPdCode} from '../../shared/cli-bridge/cs-runtime'


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
    // 跳过空数组继续找有数据的容器（与 api.ts extractVideoIds 的长度守卫一致）——
    // 防空 data.videos 短路掩盖后面 record.videos 等真正带数据的数组
    const candidates = [data?.videos, record.videos, record.items, record.results]
    const list = candidates.find((c): c is unknown[] => Array.isArray(c) && c.length > 0)
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

// search 段单独触发口（链路B 浮窗「检索」按钮 / 链路A collectExolyt 内部首段共用）：
// 三入口 → 映射 → 默认 → 校验 → 组 9 字段 body → searchVideos → ≤200 videoId → 远程去重剔 + 前置时长/图文预剔
// 终点 = 待采 videoId 列表（不发 detail、不入队）。不依赖 detailPhase，可单独调。
export async function searchPhase(
    params: ExolytCollectInput,
    rt: CsRuntime
): Promise<string[]> {
    rt.throwIfCancelled()

    // URL 入口优先：粘前端筛选 URL → 解析为后端名原始输入；否则用直传的条件表单/CLI KV
    const rawInput: ExolytRawSearchInput = params.rawUrl ? parseSearchUrl(params.rawUrl) : (params.input ?? {})

    // 组装 + 白名单校验：非法值在此经 withPdCode('INVALID_PARAM') 抛带前缀错误，绝不静默回落默认
    const body = resolveSearchBody(rawInput)
    rt.log(`[exolyt] search body 组装完成 sort=${body.sort} regions=${body.regions.join(',')} hashtags=${body.or?.length ?? 0}`)

    rt.throwIfCancelled()
    // 翻页拿满上限：后端单页约 100、试用账号硬顶 200——拉 page 1..N 合并去重到 SEARCH_RESULT_LIMIT 即止（不突破 200）。
    // body 纯 JSON 可序列化（避免 postMessage 结构化克隆丢字段）；逐页覆盖 page 翻页。
    const PAGE_HINT = 100  // 后端单页约定条数，仅用于"不满页=到底"判定，避免无谓多请求
    const seenSearch = new Set<string>()
    const searched: string[] = []
    const searchDurationById = new Map<string, number>()
    let rawTotal = 0
    for (let page = 1; searched.length < SEARCH_RESULT_LIMIT; page += 1) {
        rt.throwIfCancelled()
        const pageResult = await searchVideos({...body, page})
        const ids = pageResult.videoIds
        rawTotal += ids.length
        for (const [k, v] of buildSearchDurationMap(pageResult.raw)) searchDurationById.set(k, v)
        const before = searched.length
        for (const id of ids) {
            if (searched.length >= SEARCH_RESULT_LIMIT) break
            const key = String(id)
            if (seenSearch.has(key)) continue
            seenSearch.add(key)
            searched.push(id)
        }
        // 到底即停：空页 / 不满页（后端无更多）/ 本页零新增（全重复，防死循环）
        if (ids.length === 0 || ids.length < PAGE_HINT || searched.length === before) break
    }

    rt.throwIfCancelled()
    // detail 前用 search 自带的 duration 预剔省请求：① 去重剔已采；② 超时长 duration>60000；
    // ③ 图文 duration<=0（图文 duration=0，与 contentType=150 捆绑）。缺 duration 不前置剔，留 detail 后兜底。
    // contentType 不在 search 响应，detail 后图文门仍保留（双保险——search 未见过图文项，不全信 duration<=0）
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
    rt.log(`[exolyt] 检索 ${rawTotal}、取 ${searched.length}（上限 ${SEARCH_RESULT_LIMIT}）；去重剔 ${dedupDropped}、前置超时长剔 ${preOverDuration}、前置图文(dur≤0)剔 ${preImage}，待采 ${videoIds.length} 进 detail`)

    return videoIds
}

// detail 段结果：items=过门 detail；aborted=是否因熔断/取消中止；reason=中止原因（带 [CODE]）。
// 中止信号必须透传给调用方裁决——CLI 据此恢复失败语义、浮窗据此跳过误删清理（不可在此吞掉）。
export interface DetailPhaseResult {
    items: ExolytVideoDetail[]
    aborted: boolean
    reason?: unknown
}

// detail 段单独触发口（链路B 浮窗「采详情」按钮 / 链路A collectExolyt 内部次段共用）：
// 输入待采 videoId 列表 → 就地并发池 + 连续 3 错熔断 并发调 fetchDetail → 双门过滤（时长/图文）
// 终点 = 过门 detail + 中止信号（不入队，入队归调用方）。不依赖 searchPhase，可单独调。
export async function detailPhase(
    videoIds: string[],
    rt: CsRuntime,
    deps: ExolytCollectDeps = {},
    concurrencyParam?: number
): Promise<DetailPhaseResult> {
    const fetchDetail = deps.fetchDetail ?? defaultFetchDetail
    const concurrency = clampConcurrency(concurrencyParam)
    const breaker = makeCircuitBreaker(CIRCUIT_BREAKER_THRESHOLD)

    const gated: ExolytVideoDetail[] = []
    let done = 0
    let dropped = 0
    let imageDropped = 0

    // 主动心跳：大批 detail 并发 + 限流节流可能跨 60s 静默，每完成若干条主动 rt.log 防 isAlive 60s 误判 dead
    const HEARTBEAT_EVERY = 10

    const poolResult = await runWithConcurrency(videoIds, async (id) => {
        // worker 取数前自查取消（并发池 runSlot 已在取 item 前 throwIfCancelled，此处再守 detail 取数前一刻）
        rt.throwIfCancelled()
        // 暂停轮询：浮窗「暂停」对 detail 并发段生效（CLI 链路无此方法=不挂起），对齐 onPackVideo 既有模式
        await rt.waitWhilePaused?.()
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

    if (poolResult.aborted) {
        const reasonMsg = poolResult.reason instanceof Error ? poolResult.reason.message : String(poolResult.reason ?? '')
        rt.log(`[exolyt] detail 采集被中止（熔断/取消）：已采 ${gated.length} 条；原因：${reasonMsg}`)
    }

    rt.log(`[exolyt] detail 采集收口：过门 ${gated.length} 条交 1.5（剔除超时长 ${dropped} 条、图文 ${imageDropped} 条）`)

    return {items: gated, aborted: poolResult.aborted, reason: poolResult.reason}
}

// 链路A 整批入口：内部依次调 searchPhase + detailPhase，返回过门 detail 列表。
// 注意：videoId 写回远程去重表格不在此做——口径为「视频下载完成后才写」，
// 由 node 总指挥（collect.mjs）在 mv 归位成功后逐条 call exolytMarkCollected 触发。
export async function collectExolyt(
    params: ExolytCollectInput,
    rt: CsRuntime,
    deps: ExolytCollectDeps = {}
): Promise<ExolytVideoDetail[]> {
    const videoIds = await searchPhase(params, rt)
    const result = await detailPhase(videoIds, rt, deps, params.concurrency)
    // CLI 链路恢复原失败语义：中止=任务非成功，按 reason 抛（透传带 [CODE] 的 RATE_LIMITED/取消码），
    // 不静默吞码上报成功。CLI 不保留已采（V3 增强对 CLI 留待裁决，非本次范围）。
    if (result.aborted) {
        throw result.reason instanceof Error ? result.reason : new Error(String(result.reason ?? 'detail aborted'))
    }
    return result.items
}
