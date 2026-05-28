import {callAppsScript} from './apps-script-client'
import {
    idbGetLastClaimAt,
    idbPutLastClaimAt,
    idbTkClaimQueueDelete,
    idbTkClaimQueueGetAll,
    idbTkClaimQueuePushBatch
} from './idb'
import {enqueueUpdateStatus} from './sheets-sync'
import {delay, sleepRandom} from './timing'
import {truncateError} from './errors'
import {safeSendMessage} from './messaging'
import {
    PREPARE_TK_TAB,
    TK_COLLECT_VIA_TAB,
    TK_PROFILE_METRICS_VIA_TAB,
    type PrepareTkTabResponse,
    type TkCollectViaTabResponse,
    type TkProfileMetricsResponse
} from './remote-collect'
import type {NoxInfluencer} from '../platforms/nox/types'

const CLAIM_THROTTLE_MS = 60_000

export const NO_QUALIFYING_VIDEO_ERROR = '当前博主没有符合要求的视频'

export class BatchAbortError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'BatchAbortError'
    }
}

export interface BatchCollectParams {
    batchSize: number
    fromTs: number
    toTs: number
    minLikeRate: number
    maxDurationSec: number
    sortType: 'hot' | 'recent'
    maxVideoCount: number
}

export interface CollectOneResult {
    filename?: string
    downloadSummary: { succeeded: number; attempted: number; failed: number }
}

export interface CollectExecutor {
    label(progress: string, influencer: NoxInfluencer): string
    log(message: string): void
    collectOne(influencer: NoxInfluencer, params: BatchCollectParams): Promise<CollectOneResult>
}

interface ClaimResp {
    ok: boolean
    items?: NoxInfluencer[]
    claimed?: number
    recycled?: number
}

export async function syncTkCollectSuccess(channelId: string, succeeded: number): Promise<void> {
    await enqueueUpdateStatus('tiktok', channelId, {
        status: 'used',
        lastError: '',
        archivedVideoCount: succeeded,
        updatedAt: new Date().toISOString()
    })
}

async function writeNoVideo(channelId: string): Promise<void> {
    await enqueueUpdateStatus('tiktok', channelId, {
        status: 'used',
        lastError: '',
        updatedAt: new Date().toISOString()
    }, {archivedVideoCount: 0})
}

async function writeFailed(channelId: string, errorMsg: string): Promise<void> {
    await enqueueUpdateStatus('tiktok', channelId, {
        status: 'failed',
        lastError: errorMsg.slice(0, 200),
        updatedAt: new Date().toISOString()
    })
}

async function loadPendingClaim(): Promise<NoxInfluencer[]> {
    const items = await idbTkClaimQueueGetAll<NoxInfluencer>()
    return items.filter(it => it && typeof it === 'object' && typeof (it as NoxInfluencer).channelId === 'string')
}

async function refillClaimQueue(executor: CollectExecutor, limit: number): Promise<NoxInfluencer[]> {
    const lastClaimAt = await idbGetLastClaimAt()
    if (typeof lastClaimAt === 'number') {
        const elapsed = Date.now() - lastClaimAt
        if (elapsed < CLAIM_THROTTLE_MS) {
            const wait = CLAIM_THROTTLE_MS - elapsed
            executor.log(`claim 节流冷却 ${Math.ceil(wait / 1000)}s ...`)
            await delay(wait)
        }
    }

    let claimResp: ClaimResp
    try {
        claimResp = await callAppsScript<ClaimResp>('claimUnusedBatch', {
            platform: 'tiktok',
            limit
        })
    } catch (e) {
        executor.log(`claim 失败: ${truncateError(e, 200)}`)
        return []
    }
    await idbPutLastClaimAt(Date.now())

    const claimed = claimResp.items || []
    if (claimed.length === 0) return []

    if (claimResp.recycled && claimResp.recycled > 0) {
        executor.log(`回收超时 using 博主 ${claimResp.recycled} 个`)
    }

    await idbTkClaimQueuePushBatch(claimed.map(inf => ({key: inf.channelId, value: inf})))
    return claimed
}

export async function runTkBatchCollect(
    executor: CollectExecutor,
    params: BatchCollectParams
): Promise<void> {
    const {batchSize} = params
    let processedCount = 0
    let stopRequested = false
    let succeededCount = 0
    let noVideoCount = 0
    let failedCount = 0

    const residual = await loadPendingClaim()
    if (residual.length > 0) {
        executor.log(`检测到 IDB 残留 ${residual.length} 个未处理博主，先恢复消化`)
    }

    while (processedCount < batchSize && !stopRequested) {
        let pending = await loadPendingClaim()
        if (pending.length === 0) {
            const remaining = batchSize - processedCount
            pending = await refillClaimQueue(executor, remaining)
            if (pending.length === 0) {
                executor.log('Sheets 中没有更多 unused 博主，提前结束')
                break
            }
        }

        for (let i = 0; i < pending.length; i += 1) {
            if (processedCount >= batchSize || stopRequested) break
            const influencer = pending[i]
            processedCount += 1
            const progress = `[${processedCount}/${batchSize}]`
            const labelText = executor.label(progress, influencer)

            try {
                executor.log(`${progress} 开始采集 ${labelText}...`)
                const result = await executor.collectOne(influencer, params)
                await syncTkCollectSuccess(influencer.channelId, result.downloadSummary.succeeded)
                succeededCount += 1
                executor.log(`${progress} 完成: ${result.filename || ''} (下载 ${result.downloadSummary.succeeded}/${result.downloadSummary.attempted})`)
                await idbTkClaimQueueDelete(influencer.channelId)
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)

                if (msg === NO_QUALIFYING_VIDEO_ERROR) {
                    executor.log(`${progress} ${msg}，已标记为已采集`)
                    await writeNoVideo(influencer.channelId)
                    noVideoCount += 1
                    await idbTkClaimQueueDelete(influencer.channelId)
                } else if (error instanceof BatchAbortError || (error instanceof Error && error.name === 'BatchAbortError')) {
                    executor.log(`${progress} 整批中止：${msg}`)
                    await writeFailed(influencer.channelId, msg)
                    failedCount += 1
                    await idbTkClaimQueueDelete(influencer.channelId)
                    executor.log(`批量采集中止：处理 ${processedCount}，成功 ${succeededCount}，无视频 ${noVideoCount}，失败 ${failedCount}`)
                    throw error
                } else {
                    executor.log(`${progress} 采集失败: ${truncateError(msg, 200)}`)
                    await writeFailed(influencer.channelId, msg)
                    failedCount += 1
                    await idbTkClaimQueueDelete(influencer.channelId)
                }
            }

            if (processedCount < batchSize && !stopRequested) {
                executor.log('等待中...')
                await sleepRandom(5000, 8000)
            }
        }
    }

    executor.log(`批量采集结束：处理 ${processedCount}，成功 ${succeededCount}，无视频 ${noVideoCount}，失败 ${failedCount}`)
}

const CAPTCHA_MARKER = '[CAPTCHA]'
const CAPTCHA_ABORT_STREAK = 3

export interface TkExecutorHooks {
    log(message: string): void
    label(progress: string, influencer: NoxInfluencer): string
    throwIfCancelled?(): void
}

async function loadCollectedVideoIdSet(): Promise<Set<string>> {
    try {
        const resp = await safeSendMessage<{ok?: boolean; ids?: string[]}>({type: 'get_collected_video_ids', platform: 'tiktok'})
        const ids = Array.isArray(resp?.ids) ? resp.ids : []
        return new Set(ids.map(id => String(id)).filter(Boolean))
    } catch {
        return new Set<string>()
    }
}

function captchaError(message: string): Error {
    const e = new Error(message) as Error & {pdCode?: string}
    e.pdCode = 'CAPTCHA'
    return e
}

function isCaptchaErrorMessage(message: string): boolean {
    return message.includes(CAPTCHA_MARKER)
}

export function createTkBatchExecutor(deps: TkExecutorHooks): CollectExecutor {
    let tkTabId = 0
    let consecutiveCaptcha = 0
    let sharedExcludeVideoIds: Set<string> | null = null

    const ensureTabAt = async (username: string): Promise<void> => {
        const profileUrl = `https://www.tiktok.com/@${username}`
        const prepared = await safeSendMessage<PrepareTkTabResponse>({type: PREPARE_TK_TAB, url: profileUrl})
        if (!prepared?.ok || !prepared.tabId) {
            throw new Error(`TikTok 执行页不可用: ${prepared?.error || '未知错误'}`)
        }
        tkTabId = prepared.tabId
        deps.log(`TikTok 执行页就绪: ${prepared.href || profileUrl}`)
    }

    const getSharedExcludeVideoIds = async (): Promise<Set<string>> => {
        if (!sharedExcludeVideoIds) {
            sharedExcludeVideoIds = await loadCollectedVideoIdSet()
            deps.log(`已加载 ${sharedExcludeVideoIds.size} 个已采视频 ID 用于去重（全批共享）`)
        }
        return sharedExcludeVideoIds
    }

    const resetTkTab = async (username: string): Promise<void> => {
        if (tkTabId) {
            const resetResult = await safeSendMessage<{ok: boolean; error?: string}>({type: 'reset_tk_tab', tabId: tkTabId})
            if (!resetResult?.ok) throw new Error(`TK tab 重建失败: ${resetResult?.error || 'reset_tk_tab 无响应'}`)
            deps.log('TK tab 重建完成')
        }
        tkTabId = 0
        await ensureTabAt(username)
    }

    const onCaptcha = async (username: string, message: string): Promise<void> => {
        consecutiveCaptcha += 1
        if (consecutiveCaptcha >= CAPTCHA_ABORT_STREAK) {
            const e = new BatchAbortError(`连续 ${consecutiveCaptcha} 次人机验证，疑似 IP 被风控，已中止整批：${message}`) as BatchAbortError & {pdCode?: string}
            e.pdCode = 'CAPTCHA'
            throw e
        }
        deps.log(`命中人机验证（连续第 ${consecutiveCaptcha}/${CAPTCHA_ABORT_STREAK} 次），清理 cookie 并重建 TK tab 后重试：${message}`)
        await resetTkTab(username)
    }

    return {
        label: deps.label,
        log: deps.log,
        collectOne: async (influencer, p): Promise<CollectOneResult> => {
            deps.throwIfCancelled?.()
            if (!tkTabId) await ensureTabAt(influencer.username)
            const excludeVideoIds = await getSharedExcludeVideoIds()

            const runMetrics = async () => safeSendMessage<TkProfileMetricsResponse>({
                type: TK_PROFILE_METRICS_VIA_TAB,
                tabId: tkTabId,
                username: influencer.username,
                minLikeRate: p.minLikeRate,
                maxDurationSec: p.maxDurationSec
            })

            let metricsResult = await runMetrics()
            if (!metricsResult?.ok) {
                const errorMsg = metricsResult?.error || '指标预估失败'
                if (isCaptchaErrorMessage(errorMsg)) {
                    await onCaptcha(influencer.username, errorMsg)
                    metricsResult = await runMetrics()
                    if (!metricsResult?.ok) {
                        const retryMsg = metricsResult?.error || errorMsg
                        if (isCaptchaErrorMessage(retryMsg)) {
                            await onCaptcha(influencer.username, retryMsg)
                            throw captchaError(retryMsg)
                        }
                        consecutiveCaptcha = 0
                        throw new Error(`指标预估重试仍失败：${retryMsg}`)
                    }
                } else {
                    consecutiveCaptcha = 0
                    if (errorMsg.includes('当前博主已关闭评论功能')) throw new Error(errorMsg)
                    deps.log(`${errorMsg}，重建 TK tab 后重试...`)
                    await resetTkTab(influencer.username)
                    metricsResult = await runMetrics()
                    if (!metricsResult?.ok) {
                        const retryMsg = metricsResult?.error || errorMsg
                        if (isCaptchaErrorMessage(retryMsg)) {
                            await onCaptcha(influencer.username, retryMsg)
                            throw captchaError(retryMsg)
                        }
                        throw new Error(`指标预估重试仍失败：${retryMsg}`)
                    }
                }
            }

            const metricsSummary = metricsResult.qualifyingRate != null ? `${(metricsResult.qualifyingRate * 100).toFixed(1)}%` : ''
            await enqueueUpdateStatus('tiktok', influencer.channelId, {
                qualifyingRate: metricsResult.qualifyingRate,
                postRate: metricsResult.postRate ?? '',
                updatedAt: new Date().toISOString()
            })

            const runCollect = async () => safeSendMessage<TkCollectViaTabResponse>({
                type: TK_COLLECT_VIA_TAB,
                tabId: tkTabId,
                username: influencer.username,
                maxVideoCount: p.maxVideoCount,
                fromTs: p.fromTs,
                toTs: p.toTs,
                minLikeRate: p.minLikeRate,
                maxDurationSec: p.maxDurationSec,
                filenamePrefix: influencer.genderTag,
                sortType: p.sortType,
                excludeVideoIds: Array.from(excludeVideoIds)
            })
            let collectResult = await runCollect()
            if (!collectResult?.ok) {
                const cmsg = collectResult?.error || '采集失败'
                if (isCaptchaErrorMessage(cmsg)) {
                    await onCaptcha(influencer.username, cmsg)
                    collectResult = await runCollect()
                    if (!collectResult?.ok) {
                        const retryMsg = collectResult?.error || cmsg
                        if (isCaptchaErrorMessage(retryMsg)) {
                            await onCaptcha(influencer.username, retryMsg)
                            throw captchaError(retryMsg)
                        }
                        consecutiveCaptcha = 0
                        throw new Error(retryMsg)
                    }
                } else {
                    consecutiveCaptcha = 0
                    throw new Error(cmsg)
                }
            }
            consecutiveCaptcha = 0
            for (const videoId of collectResult.collectedVideoIds || []) {
                const s = String(videoId || '')
                if (s) excludeVideoIds.add(s)
            }
            if (metricsSummary) deps.log(`合格率 ${metricsSummary}`)
            return {
                filename: collectResult.filename,
                downloadSummary: collectResult.downloadSummary || {succeeded: 0, attempted: 0, failed: 0}
            }
        }
    }
}
