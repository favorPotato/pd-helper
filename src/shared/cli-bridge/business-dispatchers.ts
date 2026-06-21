import type {DispatchContext, DispatchFn, PdFacade} from './types'
import {PLATFORM_EXOLYT, PLATFORM_INSTAGRAM, PLATFORM_NOX, PLATFORM_TIKTOK, type PlatformSpec} from './platforms'
import {registerEphemeralTab} from './ephemeral-tabs'
import {delay} from '../timing'
import {
    IG_COLLECT_REELS_REMOTE,
    IG_GENERATE_SCRIPT_REMOTE,
    IG_MANUAL_ANALYZE_REMOTE,
    NOX_AUTO_COLLECT_REMOTE,
    NOX_BACKFILL_PROFILES_REMOTE,
    NOX_COLLECT_AUDIENCE_REMOTE,
    NOX_COLLECT_TIKTOK_POOL_REMOTE,
    NOX_PAUSE_AUTO_COLLECT_REMOTE,
    NOX_RESUME_AUTO_COLLECT_REMOTE,
    EXOLYT_SEARCH_REMOTE,
    EXOLYT_DETAIL_REMOTE,
    EXOLYT_MARK_COLLECTED_REMOTE,
    PD_RUNTIME_DISPATCH,
    PD_RUNTIME_PING,
    type PdRuntimeDispatchResponse,
    TK_BATCH_COLLECT_REMOTE,
    TK_BRIDGE_TO_IG_REMOTE,
    TK_COLLECT_REMOTE,
    TK_FETCH_VIDEO_REMOTE,
    TK_DOWNLOAD_VIDEO_REMOTE,
    TK_PROFILE_METRICS_REMOTE
} from '../remote-collect'

const RUNTIME_PAGE = 'runtime.html'

async function findTab(spec: PlatformSpec): Promise<chrome.tabs.Tab | null> {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) return null
    const tabs = await chrome.tabs.query({url: spec.urls})
    return tabs[0] || null
}

async function dispatchRemoteToTab(
    ctx: DispatchContext,
    spec: PlatformSpec,
    remoteType: string,
    payload: Record<string, unknown>
): Promise<void> {
    ctx.markPhase('locating_tab')
    const tab = await findTab(spec)
    if (!tab?.id) {
        ctx.setTabId(null)
        ctx.fail('TAB_CLOSED', `未找到 ${spec.name} 已打开的 tab，请先在浏览器打开对应站点并完成登录`)
        return
    }
    ctx.setTabId(tab.id)

    ctx.markPhase('messaging_cs')
    let ack: unknown
    try {
        ack = await chrome.tabs.sendMessage(tab.id, {
            ...payload,
            type: remoteType,
            taskId: ctx.taskId
        })
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        ctx.fail('TAB_CLOSED', `cs sendMessage failed: ${msg}`)
        return
    }

    const okAck = ack && typeof ack === 'object' && ((ack as {accepted?: unknown}).accepted === true || (ack as {ok?: unknown}).ok === true)
    if (!okAck) {
        ctx.fail('UNKNOWN_ERROR', `cs did not accept: ${JSON.stringify(ack ?? null)}`)
        return
    }
    ctx.pushLog('progress', {message: `cs accepted: ${JSON.stringify(ack)}`})
}

async function waitForTabComplete(tabId: number, timeoutMs = 15000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const tab = await chrome.tabs.get(tabId)
        if (tab.status === 'complete') return true
        await new Promise(resolve => setTimeout(resolve, 250))
    }
    return false
}

async function ensureRuntimeTab(): Promise<chrome.tabs.Tab> {
    const runtimeUrl = chrome.runtime.getURL(RUNTIME_PAGE)
    const tabs = (await chrome.tabs.query({})).filter(tab => tab.url === runtimeUrl)
    if (tabs.length > 1) {
        for (const extra of tabs.slice(1)) {
            if (extra.id) void chrome.tabs.remove(extra.id).catch(() => undefined)
        }
    }
    const existing = tabs[0]
    if (existing?.id) {
        await chrome.tabs.update(existing.id, {active: true})
        return existing
    }

    const tab = await chrome.tabs.create({url: runtimeUrl, active: true})
    if (!tab.id) throw new Error('pd-runtime tab missing id')
    return tab
}

async function waitForRuntimeReady(tabId: number): Promise<void> {
    await waitForTabComplete(tabId)
    let lastError = 'pd-runtime not ready'
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            const resp = await chrome.runtime.sendMessage({type: PD_RUNTIME_PING, runtimeTabId: tabId}) as {ok?: boolean} | undefined
            if (resp?.ok) return
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
        }
        await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(lastError)
}

async function dispatchRemoteToRuntime(
    ctx: DispatchContext,
    remoteType: string,
    payload: Record<string, unknown>
): Promise<void> {
    ctx.markPhase('locating_runtime_tab')
    let tab: chrome.tabs.Tab
    try {
        tab = await ensureRuntimeTab()
        if (!tab.id) throw new Error('pd-runtime tab missing id')
        await waitForRuntimeReady(tab.id)
    } catch (error) {
        ctx.setTabId(null)
        ctx.fail('RUNTIME_TAB_ERROR', error instanceof Error ? error.message : String(error))
        return
    }

    ctx.setTabId(tab.id)
    ctx.markPhase('messaging_runtime')
    let ack: PdRuntimeDispatchResponse | undefined
    try {
        ack = await chrome.runtime.sendMessage({
            ...payload,
            type: PD_RUNTIME_DISPATCH,
            runtimeTabId: tab.id,
            remoteType,
            taskId: ctx.taskId
        }) as PdRuntimeDispatchResponse | undefined
    } catch (error) {
        ctx.fail('RUNTIME_TAB_ERROR', error instanceof Error ? error.message : String(error))
        return
    }

    if (!ack?.ok || ack.accepted !== true) {
        ctx.fail('UNKNOWN_ERROR', `pd-runtime did not accept: ${JSON.stringify(ack ?? null)}`)
        return
    }
    ctx.pushLog('progress', {message: `pd-runtime accepted: ${JSON.stringify(ack)}`})
}

function strParam(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : ''
}

function numParam(raw: unknown): number | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
}

function boolParam(raw: unknown, fallback = false): boolean {
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'string') return raw === 'true' || raw === '1' || raw === 'yes'
    if (typeof raw === 'number') return raw !== 0
    return fallback
}


const tkProfileMetrics: DispatchFn = async (params, ctx) => {
    const username = strParam(params.username)
    if (!username) {
        ctx.setTabId(null)
        ctx.fail('INVALID_PARAM', 'username required')
        return
    }
    await dispatchRemoteToTab(ctx, PLATFORM_TIKTOK, TK_PROFILE_METRICS_REMOTE, {
        clientTabId: 0,
        username,
        minLikeRate: numParam(params.minLikeRate),
        maxDurationSec: numParam(params.maxDurationSec)
    })
}

const tkCollect: DispatchFn = async (params, ctx) => {
    const username = strParam(params.username)
    if (!username) {
        ctx.setTabId(null)
        ctx.fail('INVALID_PARAM', 'username required')
        return
    }
    await dispatchRemoteToTab(ctx, PLATFORM_TIKTOK, TK_COLLECT_REMOTE, {
        clientTabId: 0,
        username,
        maxVideoCount: numParam(params.maxVideoCount),
        fromTs: numParam(params.fromTs),
        toTs: numParam(params.toTs),
        startYear: numParam(params.startYear),
        endYear: numParam(params.endYear),
        minLikeRate: numParam(params.minLikeRate),
        maxDurationSec: numParam(params.maxDurationSec),
        filenamePrefix: strParam(params.filenamePrefix),
        sortType: params.sortType === 'hot' ? 'hot' : 'recent'
    })
}

const tkFetchVideo: DispatchFn = async (params, ctx) => {
    const id = resolveTkVideoId(strParam(params.url), strParam(params.videoId))
    if (!id) {
        ctx.setTabId(null)
        ctx.fail('INVALID_PARAM', 'url or videoId required')
        return
    }
    // 导航式单采：CS 从活 DOM 出 itemStruct(JSON) + 视频文件；CLI 默认连评论一并采进 JSON，comments=false 可关
    await navigateAndDispatch(ctx, `https://www.tiktok.com/@i/video/${id}`, TK_FETCH_VIDEO_REMOTE, {
        comments: boolParam(params.comments, true)
    }, waitForTkDetailReady)
}

// 浮窗采单视频→就地组 zip：开 tiktok @i/video/{id} 静默临时 tab，把 exolytRaw 随 CS 消息下行
// 复用 TK_FETCH_VIDEO_REMOTE 作 CS 消息类型 + 四态分流（navigateAndDispatch + waitForTkDetailReady）
// CS 端凭 payload 带 exolytRaw+packZip 走「就地组 zip + downloadBlob」分支；视频字节不回传，本 tab 落盘
const exolytPackVideo: DispatchFn = async (params, ctx) => {
    const id = resolveTkVideoId(strParam(params.url), strParam(params.videoId))
    if (!id) {
        ctx.setTabId(null)
        ctx.fail('INVALID_PARAM', 'videoId required')
        return
    }
    if (params.exolytRaw === undefined || params.exolytRaw === null) {
        ctx.setTabId(null)
        ctx.fail('INVALID_PARAM', 'exolytRaw required')
        return
    }
    await navigateAndDispatch(ctx, `https://www.tiktok.com/@i/video/${id}`, TK_FETCH_VIDEO_REMOTE, {
        videoId: id,
        exolytRaw: params.exolytRaw,
        packZip: true
    }, waitForTkDetailReady)
}

const tkBatchCollect: DispatchFn = async (params, ctx) => {
    await dispatchRemoteToRuntime(ctx, TK_BATCH_COLLECT_REMOTE, {
        batchSize: numParam(params.batchSize),
        maxVideoCount: numParam(params.maxVideoCount),
        sortType: params.sortType === 'hot' ? 'hot' : 'recent',
        minLikeRate: numParam(params.minLikeRate),
        maxDurationSec: numParam(params.maxDurationSec),
        fromTs: numParam(params.fromTs),
        toTs: numParam(params.toTs)
    })
}

// SW 侧无 window，不能复用 getVideoIdFromPageUrl：纯 videoId 直认，否则从链接抽 /video/{id}
function resolveTkVideoId(url: string, videoId: string): string | null {
    const direct = videoId.trim()
    if (/^\d+$/.test(direct)) return direct
    const m = url.trim().match(/\/video\/(\d+)/)
    return m ? m[1] : null
}

// 详情页五态：READY 正常 / GONE 已删除·不存在·审核中（终态）/ AUTH_WALL 登录墙（终态）/
// CAPTCHA 人机验证墙（清 cookie 重试）/ PENDING 风控·过渡（可 reload 重试）
type TkDetailState = 'READY' | 'GONE' | 'AUTH_WALL' | 'CAPTCHA' | 'PENDING'

// 在目标 tab 内探测 TikTok 详情页态。判别序 PENDING→GONE→AUTH_WALL→READY，PENDING 命中验证码正则升级为 CAPTCHA。
// 与 video-detail.ts 的 classifyVideoDetail 同构，但 executeScript 注入页面上下文无法 import，改判据须同步。
// captchaRe 是验证码权威份（tiktok/captcha-detect.ts:TK_CAPTCHA_RE）的内联副本：改正则须同步「权威份 + 此处」两处。
function tkDetailReadyProbe(): TkDetailState {
    // JSON 优先：能解析出 itemStruct 即 READY（即使页面同时有验证码元素也算成功）；
    // 仅 JSON 未就绪（PENDING）时才看 HTML 是否命中验证码，命中则升级 CAPTCHA，否则保持 PENDING 兜底
    const captchaRe = /captcha-verify-container|captcha-verify-container-main-page|captcha_verify|secsdk-captcha|secsdk-captcha-drag-icon|Drag the puzzle piece into place|TUXModal/i
    const pendingOrCaptcha = (): TkDetailState => (captchaRe.test(document.documentElement.outerHTML) ? 'CAPTCHA' : 'PENDING')
    const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__') || document.getElementById('__UNIVERSAL_DATA_FOR_VAR__')
    const text = el && el.textContent
    if (!text) return pendingOrCaptcha()
    try {
        const scope = (JSON.parse(text) || {}).__DEFAULT_SCOPE__ || {}
        const detail = scope['webapp.video-detail']
        if (!detail) return pendingOrCaptcha()
        const code = Number(detail.statusCode)
        if (code === 10204) return 'GONE'
        if (code !== 0) return pendingOrCaptcha()
        const itemStruct = detail.itemInfo && detail.itemInfo.itemStruct
        const id = itemStruct && itemStruct.id
        if (typeof id !== 'string' || !id) return pendingOrCaptcha()
        const video = itemStruct.video || {}
        const hasPlayAddr = typeof video.playAddr === 'string' && video.playAddr.length > 0
        const hasBitrate = Array.isArray(video.bitrateInfo) && video.bitrateInfo.length > 0
        if (!hasPlayAddr && !hasBitrate) return 'AUTH_WALL'
        return 'READY'
    } catch {
        return pendingOrCaptcha()
    }
}

// 不硬等：仅 PENDING（风控/please-wait 过渡，多为一次性）才轮询 + reload 重试；GONE/AUTH_WALL 立即返回终态零重试
async function waitForTkDetailReady(tabId: number): Promise<TkDetailState> {
    const probe = async (): Promise<TkDetailState> => {
        try {
            const r = await chrome.scripting.executeScript({target: {tabId}, func: tkDetailReadyProbe})
            const state = r?.[0]?.result
            return state === 'READY' || state === 'GONE' || state === 'AUTH_WALL' || state === 'CAPTCHA' ? state : 'PENDING'
        } catch {
            return 'PENDING' // 导航中/不可达，下一轮再探
        }
    }
    let last: TkDetailState = 'PENDING'
    for (let round = 0; round < 3; round += 1) {
        const deadline = Date.now() + 4000
        while (Date.now() < deadline) {
            last = await probe()
            if (last !== 'PENDING') return last
            await delay(400)
        }
        if (round < 2) {
            try {
                await chrome.tabs.reload(tabId)
                await waitForTabComplete(tabId, 15000)
            } catch {
                return 'PENDING'
            }
        }
    }
    return last
}

// 后台开临时 tab 导航到 detailUrl 并定向派发；失败即关 tab，成功后登记由任务终态回收
async function navigateAndDispatch(
    ctx: DispatchContext,
    detailUrl: string,
    remoteType: string,
    payload: Record<string, unknown>,
    waitReady?: (tabId: number) => Promise<TkDetailState>
): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.tabs?.create) {
        ctx.setTabId(null)
        ctx.fail('UNKNOWN_ERROR', 'chrome.tabs API not available')
        return
    }

    ctx.markPhase('navigating_tab')

    // 开 tab 导航到 detailUrl 并探测就绪态；失败处置内部完成（关 tab + ctx.fail）→ 返回 null
    // 返回 number=就绪 tabId；'CAPTCHA'=命中验证码（tab 已被 reset_tk_tab 关，cookie 已清，供单条重试）；null=已终态处置
    const openAndProbe = async (): Promise<number | 'CAPTCHA' | null> => {
        let openedTabId: number
        try {
            const tab = await chrome.tabs.create({url: detailUrl, active: false})
            if (!tab.id) throw new Error('tab missing id')
            openedTabId = tab.id
        } catch (e) {
            ctx.setTabId(null)
            ctx.fail('TAB_CLOSED', `open tab failed: ${e instanceof Error ? e.message : String(e)}`)
            return null
        }
        ctx.setTabId(openedTabId)

        if (!await waitForTabComplete(openedTabId, 20000)) {
            void chrome.tabs.remove(openedTabId).catch(() => undefined)
            ctx.fail('TAB_CLOSED', 'timeout_waiting_for_tab_complete')
            return null
        }

        // 等页面真就绪（穿过 please-wait/空壳）再派发；按五态分流，仅 READY 继续
        if (waitReady) {
            const state = await waitReady(openedTabId)
            if (state === 'CAPTCHA') {
                // 清 tiktok.com cookie 并关本 tab（reset_tk_tab 一步到位）；供单条重新导航重试
                ctx.markPhase('captcha_reset_cookie')
                const reset = await chrome.runtime.sendMessage({type: 'reset_tk_tab', tabId: openedTabId}) as {ok?: boolean; error?: string} | undefined
                if (!reset?.ok) {
                    // 清 cookie 失败：tab 可能未关，兜底关一次再终态
                    void chrome.tabs.remove(openedTabId).catch(() => undefined)
                    ctx.fail('CAPTCHA', `[CAPTCHA] 命中 TikTok 人机验证，清 cookie 失败：${reset?.error || 'reset_tk_tab 无响应'}`)
                    return null
                }
                return 'CAPTCHA'
            }
            if (state !== 'READY') {
                void chrome.tabs.remove(openedTabId).catch(() => undefined)
                if (state === 'GONE') {
                    ctx.fail('VIDEO_DELETED', '视频已删除或不存在（statusCode=10204）')
                } else if (state === 'AUTH_WALL') {
                    ctx.fail('LOGIN_REQUIRED', '该视频需登录态才能查看，公共接口不可取')
                } else {
                    ctx.fail('UNKNOWN_ERROR', '详情页未就绪（please-wait/风控空壳，重试后仍未拿到数据）')
                }
                return null
            }
        }
        return openedTabId
    }

    // 单条 CAPTCHA 补救：清 cookie 后重导航一次；仍验证码 → 抛 CAPTCHA（exit 15）。
    // 不做跨条计数/整批终止——那由调用方（collect.mjs / 浮窗 main.ts）负责。
    let first = await openAndProbe()
    if (first === 'CAPTCHA') {
        first = await openAndProbe()
        if (first === 'CAPTCHA') {
            ctx.fail('CAPTCHA', '[CAPTCHA] 清 cookie 重试后仍命中 TikTok 人机验证')
            return
        }
    }
    if (first === null) return // 终态已在 openAndProbe 内处置
    const tabId = first

    // CS 由 manifest 在 tiktok.com 自动注入；tab 已 complete，少量重试即可覆盖注入竞态
    ctx.markPhase('messaging_cs')
    let ack: unknown
    let lastErr = ''
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
            ack = await chrome.tabs.sendMessage(tabId, {...payload, type: remoteType, taskId: ctx.taskId})
            break
        } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e)
            if (attempt < 7) await delay(250)
        }
    }

    const okAck = ack && typeof ack === 'object' && ((ack as {accepted?: unknown}).accepted === true || (ack as {ok?: unknown}).ok === true)
    if (!okAck) {
        void chrome.tabs.remove(tabId).catch(() => undefined)
        ctx.fail('UNKNOWN_ERROR', `cs did not accept: ${lastErr || JSON.stringify(ack ?? null)}`)
        return
    }

    // ack 成功才登记，确保失败路径不会留下需关闭的幽灵 tab
    registerEphemeralTab(ctx.taskId, tabId)
    ctx.pushLog('progress', {message: `cs accepted on nav tab ${tabId}: ${JSON.stringify(ack)}`})
}

// 下载当前已打开 TK tab 的视频（不导航）；带 videoId 的导航式单采走 tkFetchVideo
const tkDownloadVideo: DispatchFn = async (_params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_TIKTOK, TK_DOWNLOAD_VIDEO_REMOTE, {})
}

const tkBridgeToIg: DispatchFn = async (params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_TIKTOK, TK_BRIDGE_TO_IG_REMOTE, {
        caption: strParam(params.caption)
    })
}


const igCollectReels: DispatchFn = async (params, ctx) => {
    const username = strParam(params.username)
    if (!username) {
        ctx.setTabId(null)
        ctx.fail('INVALID_PARAM', 'username required')
        return
    }
    await dispatchRemoteToTab(ctx, PLATFORM_INSTAGRAM, IG_COLLECT_REELS_REMOTE, {
        username,
        order: params.order === 'desc' ? 'desc' : 'asc',
        rangeFrom: strParam(params.rangeFrom),
        rangeTo: strParam(params.rangeTo)
    })
}

const igManualAnalyze: DispatchFn = async (_params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_INSTAGRAM, IG_MANUAL_ANALYZE_REMOTE, {})
}

const igGenerateScript: DispatchFn = async (_params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_INSTAGRAM, IG_GENERATE_SCRIPT_REMOTE, {})
}


const noxAutoCollect: DispatchFn = async (params, ctx) => {
    // searchUrl / platform 由 CS handler 从 URL 读取，不需要 dispatch 传入
    await dispatchRemoteToTab(ctx, PLATFORM_NOX, NOX_AUTO_COLLECT_REMOTE, {
        targetCount: numParam(params.targetCount),
        startPageNum: numParam(params.startPageNum),
        collectProfile: boolParam(params.collectProfile, true)
    })
}

const noxCollectAudience: DispatchFn = async (_params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_NOX, NOX_COLLECT_AUDIENCE_REMOTE, {})
}

const noxBackfillProfiles: DispatchFn = async (params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_NOX, NOX_BACKFILL_PROFILES_REMOTE, {
        batchSize: numParam(params.batchSize)
    })
}

const noxCollectTikTokPool: DispatchFn = async (params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_NOX, NOX_COLLECT_TIKTOK_POOL_REMOTE, {
        batchSize: numParam(params.batchSize),
        maxVideoCount: numParam(params.maxVideoCount),
        sortType: params.sortType === 'hot' ? 'hot' : 'recent',
        minLikeRate: numParam(params.minLikeRate),
        maxDurationSec: numParam(params.maxDurationSec),
        fromTs: numParam(params.fromTs),
        toTs: numParam(params.toTs)
    })
}

const noxPauseAutoCollect: DispatchFn = async (_params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_NOX, NOX_PAUSE_AUTO_COLLECT_REMOTE, {})
}

const noxResumeAutoCollect: DispatchFn = async (_params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_NOX, NOX_RESUME_AUTO_COLLECT_REMOTE, {})
}

// search/detail 解耦——search 单段：透传筛选条件（rawUrl/9 字段 KV）到 exolyt CS。
// 须已打开 exolyt 站点 tab 取同源 JWT，故用 dispatchRemoteToTab；严禁 dispatchRemoteToRuntime（runtime.html 无站点 session）。
// 映射/默认/白名单校验落 CS 就近（search-params），非法 → [INVALID_PARAM]；本 dispatcher 不做白名单校验（校验对象是 CS 组装后的 body）。
// CS 端 searchPhase → addSearched 累积进内存池，result 帧回 {added,total}。
const exolytSearch: DispatchFn = async (params, ctx) => {
    const rawUrl = strParam(params.url) || strParam(params.rawUrl)

    const input: Record<string, unknown> = {}
    const passStr = (k: string): void => { const v = strParam(params[k]); if (v) input[k] = v }
    const passArr = (k: string): void => {
        const raw = params[k]
        if (Array.isArray(raw)) input[k] = raw
        else { const v = strParam(raw); if (v) input[k] = v.split(',').map(s => s.trim()).filter(Boolean) }
    }
    passStr('sort')
    passStr('mood')
    passStr('dateStart')
    passStr('dateEnd')
    passStr('followers')
    passArr('regions')
    passArr('hashtags')
    passStr('likesMin')
    passStr('accountType')

    if (!rawUrl && Object.keys(input).length === 0) {
        ctx.setTabId(null)
        ctx.fail('INVALID_PARAM', 'exolyt 检索需提供 url（前端筛选 URL）或至少一个筛选字段')
        return
    }

    await dispatchRemoteToTab(ctx, PLATFORM_EXOLYT, EXOLYT_SEARCH_REMOTE, {rawUrl, input})
}

// search/detail 解耦——detail 单段：CS 端读内存池 searched∪detailed 态 ids，剔除 node 端已落盘集（have）后 detailPhase 逐条流式 push（kind=exolytDetail）。
// have = node 端 raws/exolyt 已落盘 videoId[]，作续采基准（中断不丢数据 + 跳过已落盘 fetchDetail）；result 帧回 {detailed,gated,aborted,reason}。须经 exolyt 站点 tab。
const exolytDetail: DispatchFn = async (params, ctx) => {
    const have = Array.isArray(params.have) ? params.have.filter((v): v is string => typeof v === 'string') : []
    await dispatchRemoteToTab(ctx, PLATFORM_EXOLYT, EXOLYT_DETAIL_REMOTE, {have})
}

// 链路A 下载后写回：node 在视频 mv 归位成功后逐条 call，把 videoId 写入远程去重表格。
// 须经 exolyt CS（其 setup 启动了同步 worker，入队即 flush 到 Sheets）；只入队，不依赖 JWT。
const exolytMarkCollected: DispatchFn = async (params, ctx) => {
    const videoId = strParam(params.videoId)
    if (!videoId) {
        ctx.setTabId(null)
        ctx.fail('INVALID_PARAM', 'videoId required')
        return
    }
    await dispatchRemoteToTab(ctx, PLATFORM_EXOLYT, EXOLYT_MARK_COLLECTED_REMOTE, {videoId})
}

const DISPATCHERS: Readonly<Record<string, DispatchFn>> = {
    tkProfileMetrics,
    tkCollect,
    tkFetchVideo,
    exolytPackVideo,
    tkBatchCollect,
    tkDownloadVideo,
    tkBridgeToIg,
    igCollectReels,
    igManualAnalyze,
    igGenerateScript,
    noxAutoCollect,
    noxCollectAudience,
    noxBackfillProfiles,
    noxCollectTikTokPool,
    noxPauseAutoCollect,
    noxResumeAutoCollect,
    exolytSearch,
    exolytDetail,
    exolytMarkCollected
}

export function registerBusinessDispatchers(facade: PdFacade): void {
    for (const [method, fn] of Object.entries(DISPATCHERS)) {
        facade.register(method, fn)
    }
}
