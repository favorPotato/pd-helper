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
                    stopRequested = true
                    break
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
