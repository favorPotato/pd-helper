import type {CsRuntime} from '../../shared/cli-bridge/cs-runtime'
import {runFireAndForget, withPdCode} from '../../shared/cli-bridge/cs-runtime'
import {EXOLYT_SEARCH_REMOTE, EXOLYT_DETAIL_REMOTE, EXOLYT_MARK_COLLECTED_REMOTE} from '../../shared/remote-collect'
import {enqueueUpsertVideos, startSyncWorker} from '../../shared/sheets-sync'
import {searchPhase, detailPhase} from './collector'
import type {DetailPhaseResult} from './collector'
import type {ExolytVideoDetail} from './types'
import {showDialog} from '../../shared/custom-dialog'
import {checkAppsScriptHealth} from '../../shared/apps-script-client'
import {delay} from '../../shared/timing'
import {UiHelper} from './helpers'
import * as collectState from './collect-state'
import type {ExolytRawSearchInput} from './types'

// import 红线：仅 cs-runtime + remote-collect 常量 + sheets-sync + 同目录模块。
// 严禁 facade/persistence/business-dispatchers（含 chrome.tabs/storage.session）——进 CS 即崩；
// pd:invoke 仅经 chrome.runtime.sendMessage 发字符串 type + method 字面量，不 import 任何 SW 独占模块。

declare const window: Window & {
    __EXOLYT_HANDLER_LOADED__?: boolean
}

// 异常是否已带 pdCode——已带则不被 main 兜底码覆盖，保 collector 的 INVALID_PARAM 上行
function hasPdCode(error: Error): boolean {
    return typeof (error as Error & {pdCode?: unknown}).pdCode === 'string'
}

function initExolytMessageHandler(): void {
    if (window.__EXOLYT_HANDLER_LOADED__) return
    window.__EXOLYT_HANDLER_LOADED__ = true

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return

        // 链路A 下载后写回：node 在视频下载完成后逐条 call，把 videoId 入队远程去重表格，
        // 经此 exolyt CS（setup 已 startSyncWorker）flush 到 Sheets。
        if (msg.type === EXOLYT_MARK_COLLECTED_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) {
                sendResponse({ok: false, error: 'taskId required'})
                return true
            }
            const videoId = typeof msg.videoId === 'string' && msg.videoId ? msg.videoId : ''
            sendResponse({ok: true, accepted: true})
            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                if (!videoId) {
                    return Promise.reject(withPdCode(new Error('[INVALID_PARAM] videoId required'), 'INVALID_PARAM'))
                }
                await enqueueUpsertVideos('exolyt', [{videoId}])
                rt.log(`[exolyt] 已入队回写 videoId ${videoId}`)
                return {videoId}
            })
            return true
        }

        // search 单段：searchPhase 得待采 ids → addSearched 累积进内存池（与浮窗 onSearch 共用）。
        // result 帧回 {added, total}；不发 detail，编排由 node 自行负责。
        if (msg.type === EXOLYT_SEARCH_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) {
                sendResponse({ok: false, error: 'taskId required'})
                return true
            }
            sendResponse({ok: true, accepted: true})

            const rawUrl = typeof msg.rawUrl === 'string' && msg.rawUrl.length ? msg.rawUrl : undefined
            const input = msg.input && typeof msg.input === 'object' ? msg.input as ExolytRawSearchInput : undefined

            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                try {
                    const videoIds = await searchPhase({rawUrl, input}, rt)
                    const added = collectState.addSearched(videoIds)
                    const total = collectState.listByStatus('searched').length
                    rt.log(`[exolyt] 检索完成：本次新增 ${added.length} 条待采（去重后），当前累计 searched ${total}`)
                    return {added: added.length, total}
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error))
                    return Promise.reject(hasPdCode(err) ? err : withPdCode(err, 'UNKNOWN_ERROR'))
                }
            })
            return true
        }

        // detail 单段：读内存池 searched 态 ids → detailPhase 双门过滤；
        // 每条过门 detail 逐条流式 pushLog（kind=exolytDetail，边采边落给 node）并 markDetailed；
        // result 帧回 {detailed, gated, aborted, reason}，透传整批终止信号（连续验证码/熔断）。
        if (msg.type === EXOLYT_DETAIL_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) {
                sendResponse({ok: false, error: 'taskId required'})
                return true
            }
            sendResponse({ok: true, accepted: true})

            // node 端已落盘集（raws/exolyt 实际文件）——续采权威基准：剔出已落盘条目，剩余即待采。
            const have = new Set(Array.isArray(msg.have) ? (msg.have as unknown[]).filter((v): v is string => typeof v === 'string') : [])

            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                try {
                    // 候选与浮窗共用 listDetailCandidates（searched∪detailed 剔 have），此处 have=node 已落盘集。
                    const ids = collectState.listDetailCandidates(have)
                    if (ids.length === 0) {
                        rt.log('[exolyt] 无待采详情条目')
                        return {detailed: 0, gated: 0, aborted: false}
                    }
                    // 共用 CS detail 收口（与链路B collectDetailPhase 同一 helper）：onPassed 做实时 pushLog（边采边落给 node），
                    // 内部 markDetailed + !aborted 时对被双门剔除的条目 removeItem（终态剔除，防 node 重跑时 listDetailCandidates 重采）。
                    const {result} = await runDetailWithCleanup(ids, rt, (detail) => {
                        rt.pushLog({kind: 'exolytDetail', __full: true, detail: {videoId: detail.videoId, raw: detail.raw}})
                    })
                    const reasonMsg = result.reason instanceof Error ? result.reason.message : (result.reason !== undefined ? String(result.reason) : undefined)
                    rt.log(`[exolyt] detail 段收口：过门 ${result.items.length}/${ids.length}${result.aborted ? '（整批终止：' + (reasonMsg ?? '') + '）' : ''}`)
                    return {detailed: result.items.length, gated: result.items.length, aborted: result.aborted, reason: reasonMsg}
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error))
                    return Promise.reject(hasPdCode(err) ? err : withPdCode(err, 'UNKNOWN_ERROR'))
                }
            })
            return true
        }
    })
}

// 浮窗链路（链路B）自造轻量 rt：不接 CLI 任务总线（无 pd:log/pd:done 上行），
// log 直落浮窗、pushLog 空操作；取消语义借 collect-state.isPaused()——暂停=不再开新单条（轮询前自查），
// 非硬中断当前在途单条，故 throwIfCancelled 恒不抛（暂停由各 handler 在循环前查 isPaused 实现）。
function makeFloatRuntime(): CsRuntime {
    return {
        taskId: `exolyt-float-${Date.now()}`,
        log: (message: string) => UiHelper.log(message),
        pushLog: () => { /* 浮窗无结构化日志通道，空操作 */ },
        isCancelled: () => false,
        throwIfCancelled: () => { /* 暂停经各 handler 轮询 isPaused 实现，此处不硬中断 */ },
        // detail 并发段经此挂起点响应暂停（对齐 onPackVideo 的轮询模式）：暂停=等待恢复、非取消。
        waitWhilePaused: async () => {
            let waited = false
            while (collectState.isPaused()) {
                if (!waited) { UiHelper.log('[exolyt] 已暂停，停在当前条目前（点继续恢复）'); waited = true }
                await delay(500)
            }
        }
    }
}

// CS 共用 detail 收口（链路A CLI detail 分支 / 链路B 浮窗 collectDetailPhase 共同入口，改一处须同步另一处）：
// 内部 detailPhase 双门过滤 → 每条过门 detail 当场 markDetailed + 调可选 onPassed（链路A 用于 pushLog 实时落盘）；
// 终态剔除：!aborted 时对 ids 中未过门的条目 removeItem（被时长/图文双门剔除→不得留待采集合致重跑重采）；
// 中止（熔断/取消）：未处理条目既非过门也非被剔除——整段跳过 removeItem，保留可续采。
async function runDetailWithCleanup(
    ids: string[],
    rt: CsRuntime,
    onPassed?: (detail: ExolytVideoDetail) => void
): Promise<{result: DetailPhaseResult; passed: Set<string>}> {
    const passed = new Set<string>()
    // detailPhase 每产出一条过门 detail 即回调，当场 markDetailed + onPassed；
    // 存 detail 整体 {videoId, raw}（非仅 detail.raw）——与链路A collect.mjs 落盘一致，供 zip 内 raws/exolyt/{id}.json 解压即落库。
    const result = await detailPhase(ids, rt, {}, undefined, (detail) => {
        collectState.markDetailed(detail.videoId, detail)
        passed.add(detail.videoId)
        onPassed?.(detail)
    })
    // 中止下未处理 id 既非过门也非被剔除——跳过 removeItem，保留可续采。
    if (!result.aborted) {
        // 终态剔除：ids 中未过门 = 被时长/图文双门剔除，移出候选，不得留在待采集合致 listDetailCandidates 重采。
        for (const id of ids) {
            if (!passed.has(id)) collectState.removeItem(id)
        }
    }
    return {result, passed}
}

// 详情段主体（链路B：onSearch 勾选「自动采集详情」与 onDetail 共用）：取续采候选 ids →
// runDetailWithCleanup 共用收口 → UiHelper.log 文案。busy 态由调用方管理。
async function collectDetailPhase(rt: CsRuntime): Promise<void> {
    // 候选与 CLI detail 分支共用 listDetailCandidates（searched∪detailed 剔 have）。
    // 浮窗无 node 落盘，have=内存已具 raw 集（落盘等价物）：detailed 皆有 raw 被剔，故常态恒等于「仅 searched」，
    // 但口径与链路A 一致、且对「detailed 却无 raw」的异常自动续采。
    const ids = collectState.listDetailCandidates(collectState.listVideoIdsWithRaw())
    if (ids.length === 0) {
        UiHelper.log('[exolyt] 无待采详情条目')
        return
    }
    const {result, passed} = await runDetailWithCleanup(ids, rt)
    if (result.aborted) {
        const reasonMsg = result.reason instanceof Error ? result.reason.message : String(result.reason ?? '')
        UiHelper.log(`[exolyt] 采详情被中止：过门 ${passed.size} 条已采，未处理条目保留可续采；原因：${reasonMsg}`)
        return
    }
    UiHelper.log(`[exolyt] 采详情完成：过门 ${passed.size} 条、剔除 ${ids.length - passed.size} 条`)
}

// 检索：弹窗确认（可勾选「自动采集详情」）→ 读当前页 URL → searchPhase 得待采 videoId[] →
// addSearched 累积去重 → 报本次新增 N；若勾选则紧接着对 searched 队列跑详情段。
async function onSearch(): Promise<void> {
    const result = await showDialog({
        title: '采集列表',
        fields: [
            {key: 'info', type: 'info', label: '将复用当前页面的搜索条件'},
            {key: 'collectDetail', type: 'checkbox', label: '自动采集详情', value: true}
        ],
        confirmText: '采集列表'
    })
    if (!result) return
    const collectDetail = result.collectDetail === true

    UiHelper.setBusyState({searching: true})
    try {
        const rt = makeFloatRuntime()
        const videoIds = await searchPhase({rawUrl: window.location.href}, rt)
        const added = collectState.addSearched(videoIds)
        UiHelper.log(`[exolyt] 检索完成：本次新增 ${added.length} 条待采（去重后）`)
        if (collectDetail) {
            UiHelper.setBusyState({searching: false, detailing: true})
            await collectDetailPhase(rt)
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        UiHelper.log(`[exolyt] 检索失败：${message}`)
    } finally {
        UiHelper.setBusyState({searching: false, detailing: false})
    }
}

// 采详情：单独触发详情段（针对已检索未采条目）
async function onDetail(): Promise<void> {
    UiHelper.setBusyState({detailing: true})
    try {
        await collectDetailPhase(makeFloatRuntime())
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        UiHelper.log(`[exolyt] 采详情失败：${message}`)
    } finally {
        UiHelper.setBusyState({detailing: false})
    }
}

// 采视频：detailed + 失败重试队列逐条经 pd:invoke→exolytPackVideo 就地组 zip。
// 每条前查 isPaused 实现暂停轮询（停在当前条前，不中断已发出的单条）。
// ok → markZipped + 入队远程 upsert；VIDEO_DELETED/LOGIN_REQUIRED → removeItem（终态）；其余 → markFailed 进重试队列。
// 同步重入护栏：按钮禁用靠异步刷新（~500ms 窗口），快速双击可并发进两个 onPackVideo
// 对同一队列各自 markZipped+入队致重复出包。入口同步置位、finally 复位，第二次直接早退。
let packVideoRunning = false

async function onPackVideo(): Promise<void> {
    if (packVideoRunning) {
        UiHelper.log('[exolyt] 采视频进行中，忽略重复触发')
        return
    }
    packVideoRunning = true
    UiHelper.setBusyState({packing: true})
    try {
        const queue = [...collectState.listByStatus('detailed'), ...collectState.listRetryQueue()]
        if (queue.length === 0) {
            UiHelper.log('[exolyt] 无待出包条目')
            return
        }
        let okCount = 0
        let failCount = 0
        let removedCount = 0
        // 连续验证码计数（作用域=本次出包队列）：仅「成功」清零、仅「CAPTCHA」累加；
        // VIDEO_DELETED/LOGIN_REQUIRED/其他错误中性（不加不清）——连续 3 次验证码判定环境被风控、整批终止。
        let captchaStreak = 0
        let captchaAborted = false
        // 逐条采集循环不变量(链路A runTkPhase / 链路B onPackVideo 共同契约,改一处须同步另一处):
        // 去重表写回一律 best-effort:产物落地后才写,写回抛错只记日志、绝不改条目状态(不得把已成功条目打回失败)；
        // 终态剔除:被双门剔除/GONE/AUTH_WALL 的条目必须移出候选,不得留在待采集合致重跑重采；
        // 连续验证码 ≥3 整批终止(captchaStreak:仅成功清零、仅 CAPTCHA 累加、其余错误中性)；
        // 单条失败绝不中止整批(逐条 try/catch 继续下一条),除非触发连续验证码终止。
        for (const item of queue) {
            // 暂停=挂起等待（不再开新单条、保 busy 态），点「继续」恢复；关闭浮窗即止（CS 随之销毁）。
            // 非硬中断已发出的单条，故停在「当前条目前」。
            let waited = false
            while (collectState.isPaused()) {
                if (!waited) { UiHelper.log('[exolyt] 已暂停，停在当前条目前（点继续恢复）'); waited = true }
                await delay(500)
            }
            const id = item.videoId
            // 单条出包加内层 try/catch：sendMessage 抛异常（端口关闭/SW 不可达，非业务回执）时
            // 记为该条失败并继续下一条，对齐链路A「逐条不中断整批」；业务失败回执处理逻辑不变。
            try {
                const res = await chrome.runtime.sendMessage({
                    type: 'pd:invoke',
                    method: 'exolytPackVideo',
                    params: {videoId: id, exolytRaw: item.exolytRaw}
                }) as {ok?: boolean; code?: string; message?: string} | undefined

                if (res?.ok) {
                    // 去重写回 best-effort：zip 已落地→先 markZipped 终态；入队抛错只记日志，
                    // 绝不 markFailed 已 markZipped 的条目（否则打回 retry 队列→下次重新 packVideo→重复下载 zip）。
                    collectState.markZipped(id)
                    okCount += 1
                    captchaStreak = 0  // 成功=环境活着，清零
                    try {
                        await enqueueUpsertVideos('exolyt', [{videoId: id}])
                    } catch (enqueueError) {
                        const em = enqueueError instanceof Error ? enqueueError.message : String(enqueueError)
                        UiHelper.log(`[exolyt] 已出包但入队去重表失败（zip 已落地，条目保留 zipped 不重采）：${id} ${em}`)
                    }
                } else if (res?.code === 'VIDEO_DELETED' || res?.code === 'LOGIN_REQUIRED') {
                    collectState.removeItem(id)
                    removedCount += 1
                    // 中性：不动计数
                } else {
                    collectState.markFailed(id, res?.message ?? '未知错误')
                    failCount += 1
                    // 连续验证码判定：仅 CAPTCHA 累加；其他错误中性（不动计数），当条已 markFailed 进重试队列。
                    if (res?.code === 'CAPTCHA') {
                        captchaStreak += 1
                        if (captchaStreak >= 3) { captchaAborted = true; break }
                    }
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                collectState.markFailed(id, message)
                failCount += 1
                // sendMessage 抛异常=端口/SW 不可达，非业务码，按其他错误中性处理（不动计数）
            }
        }
        if (captchaAborted) {
            // 整批终止：已出包 zip 保留、未处理条目留在队列；正常解除 busy（复用现有 finally）
            UiHelper.log('[exolyt] 连续验证码，疑似环境被风控，请换 IP 或稍后重试；已出包条目保留、未处理条目留在队列')
        }
        UiHelper.log(`[exolyt] 采视频收口：成功 ${okCount}、失败 ${failCount}、终态剔除 ${removedCount}`)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        UiHelper.log(`[exolyt] 采视频失败：${message}`)
    } finally {
        packVideoRunning = false
        UiHelper.setBusyState({packing: false})
    }
}

// 暂停·继续：切 collect-state 暂停标志并报当前态
async function onPauseResume(): Promise<void> {
    if (collectState.isPaused()) {
        collectState.resume()
        UiHelper.log('[exolyt] 已继续')
    } else {
        collectState.pause()
        UiHelper.log('[exolyt] 已暂停（当前条目完成后挂起，点继续恢复）')
    }
}

export function setup(): void {
    initExolytMessageHandler()
    // 启动同步搬运工：把 enqueueUpsertVideos 入的队真正 flush 到远程 Sheets 去重表格。
    // 两条链路（链路A 经 node call、链路B 浮窗）都经此 exolyt CS 入队，故在此统一开启（仿 nox setup）。
    startSyncWorker()
    void UiHelper.inject({onSearch, onDetail, onPackVideo, onPauseResume})
    // Sheets 健康门禁（仿 nox）：远程去重池是 exolyt 权威依赖，不可用则禁用全部按钮 + 告警，不等点下去才报错。
    void checkAppsScriptHealth().then((result) => {
        UiHelper.setSheetsAlive(result.ok)
        if (!result.ok) {
            alert(`Google Sheets 不可用，exolyt 采集功能已禁用\n原因：${result.error}`)
        }
    })
}
