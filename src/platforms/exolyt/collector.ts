import type {CsRuntime} from '../../shared/cli-bridge/cs-runtime'
import type {ExolytRawSearchInput, ExolytVideoDetail} from './types'
import {searchVideos, fetchDetail as defaultFetchDetail, extractSearchItems} from './api'
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

export interface ExolytCollectInput {
    rawUrl?: string
    input?: ExolytRawSearchInput
    // 反风控并发数（默认 5、夹到 [1,15]）——内部参数，越界夹紧非失败
    concurrency?: number
}

// 漏桶熔断阈值（沿用 nox paginator 的 3，就地另写不复用 nox 文件）：错+1/成功-1 封顶 0，水位 >=3 熔断
const CIRCUIT_BREAKER_THRESHOLD = 3

// 时长硬门阈值（ms）：FB/IG 上传硬约束。经窗口真实 GET /videos/{id} 实测——
// 字段名 = duration、单位 = ms（实测 32508 对应 ~32.5s 短视频）。
// 判门语义：duration > 60000 严格大于剔除、恰好 60000 保留；缺字段保守不剔除（宁多采不误删）
const DURATION_GATE_MS = 60000

// 图文硬门白名单：仅保留视频 contentType {0,55,61}，剔除其它（尤其 150=图文/图集）
// 用白名单而非黑名单——防平台后续新增未知 contentType 被误采（默认剔除比默认放行更安全）
// 注意：此 contentType 是 detail.raw 顶层的 number，非 api.ts 里 HTTP 响应头那个 content-type 字符串
const VIDEO_CONTENT_TYPES = new Set([0, 55, 61])

// 可注入 fetchDetail 便于注入式 mock（验证时长门过滤/熔断/归一）；默认走 api.fetchDetail
export interface ExolytCollectDeps {
    fetchDetail?: (id: string) => Promise<ExolytVideoDetail>
}

// 从 detail.raw 取时长（ms）：实测 duration 在 raw 顶层。非有限数（缺字段/结构异常）返回 null → 调用方保守不剔除
function readDurationMs(raw: unknown): number | null {
    if (!raw || typeof raw !== 'object') return null
    const value = (raw as Record<string, unknown>).duration
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// 从 detail.raw 顶层取 contentType（number）：实测 contentType 与 duration/height/width 完全捆绑，单看即足够
// 非有限 number（缺字段/结构异常）返回 null → 不在白名单视为剔除（守白名单语义，未知类型一律不放行）
function readContentType(raw: unknown): number | null {
    if (!raw || typeof raw !== 'object') return null
    const value = (raw as Record<string, unknown>).contentType
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// search 响应每条已带 duration（ms，实测；contentType 不带）。构建 videoId→duration 供 detail 前时长门预剔。
// 容器探测/取键复用 api.extractSearchItems 单一出口（避免第二份手抄）；本函数仅在提取出的条目上再取 duration。
// 缺 duration 的不入 map → 保守不前置剔、留 detail 后时长门兜底
function buildSearchDurationMap(raw: unknown): Map<string, number> {
    const map = new Map<string, number>()
    for (const r of extractSearchItems(raw)) {
        const id = r.id ?? r.videoId ?? r.video_id
        const dur = r.duration
        if ((typeof id === 'string' || typeof id === 'number') && typeof dur === 'number' && Number.isFinite(dur)) {
            map.set(String(id), dur)
        }
    }
    return map
}

// search 段单独触发口（链路B 浮窗「检索」按钮 / 链路A CLI search 段共用）：
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
    const PAGE_HINT = 100  // 后端单页约定条数，仅用于「不满页=到底」判定，避免无谓多请求
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

// detail 段单独触发口（链路B 浮窗「采详情」按钮 / 链路A CLI detail 段共用）：
// 输入待采 videoId 列表 → 就地并发池 + 漏桶熔断（错+1/成功-1 封顶 0，错多于成功才熔断）并发调 fetchDetail → 双门过滤（时长/图文）
// 终点 = 过门 detail + 中止信号（不入队，入队归调用方）。不依赖 searchPhase，可单独调。
export async function detailPhase(
    videoIds: string[],
    rt: CsRuntime,
    deps: ExolytCollectDeps = {},
    concurrencyParam?: number,
    // 可选逐条回调：每产出一条过门 detail 即触发，供调用方逐条实时落盘。
    // 不传则行为零变化；不参与双门/熔断/aborted，仅在 push 进 gated 同处多触发一下。
    onItem?: (detail: ExolytVideoDetail) => void
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
            // 成功返回即漏桶 -1（封顶 0，不清零）——时长门剔除走成功路径、与熔断正交
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
                onItem?.(detail)
            }
        } catch (error) {
            // 仅 fetchDetail 抛错才算「错」参与漏桶计数；桶满（错多于成功，count>=阈值）recordErr 抛出（透传带 [CODE] 原 error，熔断不新增码）
            breaker.recordErr(error)
            // 桶未满：单条错不中止整批（漏桶水位保留，后续成功逐次 recordOk -1 抵消，错多于成功才累积触发）
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

    rt.log(`[exolyt] detail 采集收口：过门 ${gated.length} 条（剔除超时长 ${dropped} 条、图文 ${imageDropped} 条）`)

    return {items: gated, aborted: poolResult.aborted, reason: poolResult.reason}
}

