import type {CsRuntime} from '../../shared/cli-bridge/cs-runtime'
import {runFireAndForget, withPdCode} from '../../shared/cli-bridge/cs-runtime'
import {EXOLYT_SEARCH_COLLECT_REMOTE, EXOLYT_MARK_COLLECTED_REMOTE} from '../../shared/remote-collect'
import {enqueueUpsertVideos, startSyncWorker} from '../../shared/sheets-sync'
import {collectExolyt, searchPhase, detailPhase} from './collector'
import {showDialog} from '../../shared/custom-dialog'
import {checkAppsScriptHealth} from '../../shared/apps-script-client'
import {delay} from '../../shared/timing'
import {UiHelper} from './helpers'
import * as collectState from './collect-state'
import type {ExolytRawSearchInput} from './types'

// import 红线（NFR-4/AC4）：仅 cs-runtime + remote-collect 常量 + sheets-sync（CS 安全，collector 已用）+ 同目录模块
// 严禁 facade/persistence/business-dispatchers（含 chrome.tabs/storage.session）——进 CS 即崩
// pd:invoke 仅经 chrome.runtime.sendMessage 发字符串 type + method 字面量，不 import 任何 SW 独占模块

declare const window: Window & {
    __EXOLYT_HANDLER_LOADED__?: boolean
}

// 异常是否已带 pdCode（withPdCode 挂在 error.pdCode）——已带则不被 main 兜底码覆盖，保 collector 的 INVALID_PARAM 上行
function hasPdCode(error: Error): boolean {
    return typeof (error as Error & {pdCode?: unknown}).pdCode === 'string'
}

function initExolytMessageHandler(): void {
    if (window.__EXOLYT_HANDLER_LOADED__) return
    window.__EXOLYT_HANDLER_LOADED__ = true

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return

        if (msg.type === EXOLYT_SEARCH_COLLECT_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) {
                sendResponse({ok: false, error: 'taskId required'})
                return true
            }

            // ack 协议：同步 ack → return true → 进度/结果全程经 runFireAndForget 上行，绝不在 ack 回业务结果
            sendResponse({ok: true, accepted: true})

            // dispatcher 透传两路径：rawUrl（粘前端筛选 URL，优先）或 input（9 字段 KV，条件表单/CLI）
            const rawUrl = typeof msg.rawUrl === 'string' && msg.rawUrl.length ? msg.rawUrl : undefined
            const input = msg.input && typeof msg.input === 'object' ? msg.input as ExolytRawSearchInput : undefined

            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                // 校验/组装在 collector → search-params（CS 就近），非法值已带 [INVALID_PARAM] pdCode
                try {
                    return await collectExolyt({rawUrl, input}, rt)
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error))
                    // 仅在异常未带 pdCode 时兜底 UNKNOWN_ERROR——不覆盖 collector 已打的 INVALID_PARAM 等码
                    return Promise.reject(hasPdCode(err) ? err : withPdCode(err, 'UNKNOWN_ERROR'))
                }
            })
            return true
        }

        // 链路A 下载后写回：node 在视频下载完成后逐条 call，把 videoId 入队远程去重表格。
        // 经此 exolyt CS（setup 已 startSyncWorker）入队即被 flush 到 Sheets。
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

// 详情段主体（onSearch 勾选「自动采集详情」与 onDetail 共用）：取 searched 态 ids →
// detailPhase 双门过滤 → 过门者 markDetailed、被剔者 removeItem。busy 态由调用方管理。
async function collectDetailPhase(rt: CsRuntime): Promise<void> {
    const ids = collectState.listByStatus('searched').map((it) => it.videoId)
    if (ids.length === 0) {
        UiHelper.log('[exolyt] 无待采详情条目')
        return
    }
    const result = await detailPhase(ids, rt)
    const passed = new Set<string>()
    for (const detail of result.items) {
        // 存 detail 整体 {videoId, raw}（非仅 detail.raw）——与链路A collect.mjs:140 落盘一致，
        // 供 zip 内 raws/exolyt/{id}.json 解压即落库 + Epic 3 index-gen 按同结构取数
        collectState.markDetailed(detail.videoId, detail)
        passed.add(detail.videoId)
    }
    // 中止（熔断/取消）下未处理的 id 既非过门也非被剔除——整段跳过 removeItem，
    // 保留未处理条目可续采（被双门真正剔除的本次不清也无妨，下次重试重新判定，不误删）。
    if (result.aborted) {
        const reasonMsg = result.reason instanceof Error ? result.reason.message : String(result.reason ?? '')
        UiHelper.log(`[exolyt] 采详情被中止：过门 ${passed.size} 条已采，未处理条目保留可续采；原因：${reasonMsg}`)
        return
    }
    // ids 中未在返回里出现的 = 被双门（时长/图文）剔除，摘出列表
    let dropped = 0
    for (const id of ids) {
        if (!passed.has(id)) {
            collectState.removeItem(id)
            dropped += 1
        }
    }
    UiHelper.log(`[exolyt] 采详情完成：过门 ${passed.size} 条、剔除 ${dropped} 条`)
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
                    collectState.markZipped(id)
                    await enqueueUpsertVideos('exolyt', [{videoId: id}])
                    okCount += 1
                    captchaStreak = 0  // 成功=环境活着，清零
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
