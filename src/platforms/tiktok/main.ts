import {Downloader} from './downloader'
import {Collector, fetchVideoComments, type CollectFilterOptions, type SortType} from './collector'
import {ensureTikTokPageContextReady} from './client'
import {parseVideoDetailFromHtml, pruneItemStruct} from './video-detail'
import {Relay} from './relay'
import {UiHelper, UrlHelper} from './helpers'
import {showDialog} from '../../shared/custom-dialog'
import {createJsonArchiveFile, createZipBlob, downloadBlob, type ArchiveFile} from '../../shared/archive'
import {TK_BATCH_COLLECT_FIELDS, TK_SINGLE_COLLECT_FIELDS} from '../../shared/tk-collect-fields'
import {truncateError} from '../../shared/errors'

import {callAppsScript} from '../../shared/apps-script-client'
import {enqueueUpdateStatus} from '../../shared/sheets-sync'
import {
    runTkBatchCollect,
    syncTkCollectSuccess,
    NO_QUALIFYING_VIDEO_ERROR,
    createTkBatchExecutor
} from '../../shared/tk-batch-collect'
import type {NoxInfluencer} from '../nox/types'
import {
    reportRemoteCollectProgress,
    type PrepareTkPageContextResponse,
    TK_BATCH_COLLECT_REMOTE,
    TK_BRIDGE_TO_IG_REMOTE,
    TK_DOWNLOAD_VIDEO_REMOTE,
    TK_PROFILE_METRICS_REMOTE,
    TK_COLLECT_REMOTE,
    TK_FETCH_VIDEO_REMOTE,
    TK_PREPARE_PAGE_CONTEXT
} from '../../shared/remote-collect'
import {runFireAndForget} from '../../shared/cli-bridge/cs-runtime'

declare const window: Window & {
    __TT_BRIDGE_HANDLER_LOADED__?: boolean
}

async function loadCollectedVideoIdSet(): Promise<Set<string>> {
    try {
        const resp = await chrome.runtime.sendMessage({type: 'get_collected_video_ids', platform: 'tiktok'}) as {ok?: boolean; ids?: string[]} | undefined
        const ids = Array.isArray(resp?.ids) ? resp.ids : []
        return new Set(ids.map(id => String(id)))
    } catch (error) {
        console.warn('[TikTok] loadCollectedVideoIdSet failed, fallback to empty set', error)
        return new Set<string>()
    }
}

// 下载并落盘，返回下载结果；可传入已读取的 HTML 复用，免对同一大页面重复整页序列化
async function saveCurrentVideo(html?: string) {
    const videoData = await Downloader.downloadTikTokVideo(html)
    await downloadBlob(videoData.name, new Blob([videoData.bytes], {type: videoData.mime}))
    return videoData
}

let downloadInProgress = false
let bridgeInProgress = false
let collectInProgress = false
let batchCollectInProgress = false

function initTikTokMessageHandler(): void {
    if (window.__TT_BRIDGE_HANDLER_LOADED__) return
    window.__TT_BRIDGE_HANDLER_LOADED__ = true

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return

        if (msg.type === TK_COLLECT_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            const clientTabId = typeof msg.clientTabId === 'number' ? msg.clientTabId : 0
            const username = typeof msg.username === 'string' ? msg.username : ''
            const maxVideoCount = typeof msg.maxVideoCount === 'number' ? msg.maxVideoCount : 10
            const now = Date.now()
            const defaultFromTs = now - 90 * 24 * 60 * 60 * 1000
            const fromTs = typeof msg.fromTs === 'number' ? msg.fromTs : (typeof msg.startYear === 'number' ? new Date(msg.startYear, 0, 1).getTime() : defaultFromTs)
            const toTs = typeof msg.toTs === 'number' ? msg.toTs : (typeof msg.endYear === 'number' ? new Date(msg.endYear, 11, 31, 23, 59, 59).getTime() : now)
            const filters: CollectFilterOptions = {
                minLikeRate: typeof msg.minLikeRate === 'number' ? msg.minLikeRate : 0.02,
                maxDurationSec: typeof msg.maxDurationSec === 'number' ? msg.maxDurationSec : 60
            }
            const filenamePrefix = typeof msg.filenamePrefix === 'string' ? msg.filenamePrefix : ''
            const remoteSortType: SortType = msg.sortType === 'hot' ? 'hot' : 'recent'

            // cli-bridge 路径：fire-and-forget，立即 ack，进度走 pd:log，结果走 pd:done
            if (taskId) {
                sendResponse({ok: true, accepted: true})
                void runFireAndForget(taskId, async (rt) => {
                    rt.throwIfCancelled()
                    const excludeVideoIds = await loadCollectedVideoIdSet()
                    rt.log(`已加载 ${excludeVideoIds.size} 个已采视频 ID 用于去重`)
                    const onSelectedCount = (selectedCount: number, targetCount: number) => rt.log(`入选 ${selectedCount}/${targetCount}`)
                    const onDownloadProgress = (downloadedCount: number, selectedCount: number, targetCount: number) => rt.log(`下载 ${downloadedCount}/${selectedCount}（目标 ${targetCount} 入选 ${selectedCount}）`)
                    const onDownloadFailed = (videoId: string) => rt.log(`下载失败：${videoId}，已跳过`)
                    const onLog = (message: string) => rt.log(message)

                    const result = username
                        ? await Collector.collectProfileByUsername(username, maxVideoCount, fromTs, toTs, filters, onSelectedCount, onDownloadProgress, onDownloadFailed, filenamePrefix, onLog, excludeVideoIds, remoteSortType)
                        : await Collector.collectCurrentProfile(maxVideoCount, fromTs, toTs, filters, onSelectedCount, onDownloadProgress, onDownloadFailed, filenamePrefix, onLog, excludeVideoIds, remoteSortType)

                    rt.throwIfCancelled()
                    return {
                        filename: result.filename,
                        videoCount: result.output.videos?.length || 0,
                        downloadSummary: result.downloadSummary
                    }
                })
                return true
            }

            // 原 nox 联动路径：保留 await + sendResponse 模式
            ;(async () => {
                try {
                    const onSelectedCount = (selectedCount: number, targetCount: number) => reportRemoteCollectProgress(clientTabId, `入选 ${selectedCount}/${targetCount}`)
                    const onDownloadProgress = (downloadedCount: number, selectedCount: number, targetCount: number) => reportRemoteCollectProgress(clientTabId, `下载 ${downloadedCount}/${selectedCount}（目标 ${targetCount} 入选 ${selectedCount}）`)
                    const onDownloadFailed = (videoId: string) => reportRemoteCollectProgress(clientTabId, `下载失败：${videoId}，已跳过`)
                    const onLog = (message: string) => reportRemoteCollectProgress(clientTabId, message)

                    const hasRemoteExcludeVideoIds = Array.isArray(msg.excludeVideoIds)
                    const excludeVideoIds: Set<string> = hasRemoteExcludeVideoIds
                        ? new Set<string>((msg.excludeVideoIds as unknown[]).map((id) => String(id)).filter(Boolean))
                        : await loadCollectedVideoIdSet()
                    if (!hasRemoteExcludeVideoIds) onLog(`已加载 ${excludeVideoIds.size} 个已采视频 ID 用于去重`)

                    const result = username
                        ? await Collector.collectProfileByUsername(username, maxVideoCount, fromTs, toTs, filters, onSelectedCount, onDownloadProgress, onDownloadFailed, filenamePrefix, onLog, excludeVideoIds, remoteSortType)
                        : await Collector.collectCurrentProfile(maxVideoCount, fromTs, toTs, filters, onSelectedCount, onDownloadProgress, onDownloadFailed, filenamePrefix, onLog, excludeVideoIds, remoteSortType)
                    const collectedVideoIds = (result.output.videos || []).map(v => v.videoId).filter(Boolean)

                    sendResponse({
                        ok: true,
                        filename: result.filename,
                        videoCount: result.output.videos?.length || 0,
                        collectedVideoIds,
                        downloadSummary: result.downloadSummary
                    })
                } catch (error) {
                    sendResponse({ok: false, error: Collector.formatError(error)})
                }
            })()
            return true
        }

        if (msg.type === TK_FETCH_VIDEO_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            const withComments = msg.comments === true
            if (!taskId) {
                sendResponse({ok: false, error: 'taskId required'})
                return true
            }

            // 浮窗采单视频→就地组 zip 分支：payload 带 exolytRaw+packZip 时，采 tk raw + 视频字节就地组 zip 落盘
            // 视频字节几 MB，绝不走 pd:done 帧（500 字节截断），不回传浮窗；zip 内目录靠 ArchiveFile.filename 前缀
            if (msg.packZip === true && msg.exolytRaw !== undefined && msg.exolytRaw !== null) {
                const exolytRaw = msg.exolytRaw
                const videoId = typeof msg.videoId === 'string' && msg.videoId ? msg.videoId : ''
                sendResponse({ok: true, accepted: true})
                void runFireAndForget(taskId, async (rt) => {
                    rt.throwIfCancelled()
                    const html = document.documentElement.outerHTML
                    const detail = parseVideoDetailFromHtml(html)
                    if (!detail) throw new Error('详情页未就绪（请重试）')
                    const itemStruct = detail.itemStruct
                    const id = videoId || String(itemStruct.id)
                    // 评论与视频字节并行采（与非 packZip 分支同款 best-effort）——浮窗链路无条件采首页评论并入 comments，
                    // 失败仅记日志不连累 zip 落盘；不补这步则 comments 保持 itemStruct 原生空数组
                    const commentsJob = (async () => {
                        try {
                            const authorId = String((itemStruct.author as {id?: unknown})?.id ?? '')
                            const {comments} = await fetchVideoComments(String(itemStruct.id), authorId, detail.requestEnv, window.location.href)
                            itemStruct.comments = comments
                            rt.log(`已采评论 ${comments.length} 条`)
                        } catch (error) {
                            rt.log(`评论采集失败（itemStruct 已采）: ${error instanceof Error ? error.message : String(error)}`)
                        }
                    })()
                    const videoData = await Downloader.downloadTikTokVideo(html)
                    rt.log(`视频已取字节: ${videoData.bytes.byteLength} bytes`)
                    await commentsJob
                    pruneItemStruct(itemStruct)
                    rt.throwIfCancelled()
                    const files: ArchiveFile[] = [
                        createJsonArchiveFile(`raws/exolyt/${id}.json`, exolytRaw),
                        createJsonArchiveFile(`raws/tiktok/${id}.json`, itemStruct),
                        {filename: `videos/${id}.mp4`, bytes: videoData.bytes}
                    ]
                    const zipBlob = createZipBlob(files)
                    await downloadBlob(`${id}.zip`, zipBlob)
                    rt.log(`zip 已落盘: ${id}.zip (${zipBlob.size} bytes)`)
                    return {videoId: id, zipSize: zipBlob.size}
                })
                return true
            }

            sendResponse({ok: true, accepted: true})
            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                const html = document.documentElement.outerHTML
                // GONE/AUTH_WALL 由 parseVideoDetailFromHtml 抛带 pdCode 的终态错误；null 仅为 PENDING（页面尚未就绪）
                const detail = parseVideoDetailFromHtml(html)
                if (!detail) throw new Error('详情页未就绪（请重试）')
                const itemStruct = detail.itemStruct
                // 评论采集与视频下载互不依赖，并行跑；二者皆 best-effort，失败仅记日志不连累 itemStruct 回传
                const jobs: Promise<void>[] = []
                if (withComments) {
                    // 可选评论采集：塞进 itemStruct 原生 comments 字段
                    jobs.push((async () => {
                        try {
                            const authorId = String((itemStruct.author as {id?: unknown})?.id ?? '')
                            const {comments} = await fetchVideoComments(String(itemStruct.id), authorId, detail.requestEnv, window.location.href)
                            itemStruct.comments = comments
                            rt.log(`已采评论 ${comments.length} 条`)
                        } catch (error) {
                            rt.log(`评论采集失败（itemStruct 已采）: ${error instanceof Error ? error.message : String(error)}`)
                        }
                    })())
                }
                jobs.push((async () => {
                    try {
                        const videoData = await saveCurrentVideo(html)
                        rt.log(`视频已落盘: ${videoData.name} (${videoData.bytes.byteLength} bytes)`)
                    } catch (error) {
                        rt.log(`视频落盘失败（itemStruct 已采）: ${error instanceof Error ? error.message : String(error)}`)
                    }
                })())
                await Promise.all(jobs)
                pruneItemStruct(itemStruct)
                rt.throwIfCancelled()
                return itemStruct
            })
            return true
        }

        if (msg.type === TK_PROFILE_METRICS_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            const clientTabId = typeof msg.clientTabId === 'number' ? msg.clientTabId : 0
            const username = typeof msg.username === 'string' ? msg.username : ''
            const filters: CollectFilterOptions = {
                minLikeRate: typeof msg.minLikeRate === 'number' ? msg.minLikeRate : 0.02,
                maxDurationSec: typeof msg.maxDurationSec === 'number' ? msg.maxDurationSec : 60
            }

            if (taskId) {
                sendResponse({ok: true, accepted: true})
                void runFireAndForget(taskId, async (rt) => {
                    rt.throwIfCancelled()
                    const metrics = await Collector.computeProfileMetricsByUsername(username, filters, (m) => rt.log(m))
                    rt.throwIfCancelled()
                    return metrics
                })
                return true
            }

            ;(async () => {
                try {
                    const onLog = (message: string) => reportRemoteCollectProgress(clientTabId, message)
                    const metrics = await Collector.computeProfileMetricsByUsername(username, filters, onLog)
                    sendResponse({ok: true, ...metrics})
                } catch (error) {
                    sendResponse({ok: false, error: Collector.formatError(error)})
                }
            })()
            return true
        }

        if (msg.type === TK_BATCH_COLLECT_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) {
                sendResponse({ok: false, error: 'taskId required'})
                return true
            }
            const batchSize = typeof msg.batchSize === 'number' ? msg.batchSize : 500
            const maxVideoCount = typeof msg.maxVideoCount === 'number' ? msg.maxVideoCount : 50
            const sortType: SortType = msg.sortType === 'hot' ? 'hot' : 'recent'
            const minLikeRate = typeof msg.minLikeRate === 'number' ? msg.minLikeRate : 0.02
            const maxDurationSec = typeof msg.maxDurationSec === 'number' ? msg.maxDurationSec : 60
            const now = Date.now()
            const defaultFromTs = new Date(new Date().getFullYear(), 0, 1).getTime()
            const fromTs = typeof msg.fromTs === 'number' ? msg.fromTs : defaultFromTs
            const toTs = typeof msg.toTs === 'number' ? msg.toTs : now

            sendResponse({ok: true, accepted: true})
            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                const tkExecutor = createTkBatchExecutor({
                    log: (m) => rt.log(m),
                    label: (_progress, inf) => `${inf.genderTag}${inf.name || `@${inf.username}`}`,
                    throwIfCancelled: () => rt.throwIfCancelled()
                })
                await runTkBatchCollect(tkExecutor, {
                    batchSize, fromTs, toTs, minLikeRate, maxDurationSec, sortType, maxVideoCount
                })
                return {batchSize, completed: true}
            })
            return true
        }

        if (msg.type === TK_DOWNLOAD_VIDEO_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) {
                sendResponse({ok: false, error: 'taskId required'})
                return true
            }
            sendResponse({ok: true, accepted: true})
            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                rt.log('开始下载当前视频...')
                const videoData = await saveCurrentVideo()
                rt.log(`视频下载完成: ${videoData.name}`)
                return {filename: videoData.name, size: videoData.bytes.byteLength, mime: videoData.mime}
            })
            return true
        }

        if (msg.type === TK_BRIDGE_TO_IG_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) {
                sendResponse({ok: false, error: 'taskId required'})
                return true
            }
            const caption = typeof msg.caption === 'string' ? msg.caption : ''
            sendResponse({ok: true, accepted: true})
            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                rt.log('开始转发到 Instagram...')
                const result = await Relay.executeDownloadAndBridge(caption)
                if (!result.ok) {
                    throw new Error(`转发失败: ${result.error || '未知错误'}`)
                }
                rt.log('转发成功')
                return {size: result.size, meta: result.meta, uploadResult: result.uploadResult}
            })
            return true
        }

        if (msg.type === TK_PREPARE_PAGE_CONTEXT) {
            ;(async () => {
                try {
                    await ensureTikTokPageContextReady()
                    const response: PrepareTkPageContextResponse = {ok: true, href: location.href}
                    sendResponse(response)
                } catch (error) {
                    const response: PrepareTkPageContextResponse = {ok: false, error: Collector.formatError(error)}
                    sendResponse(response)
                }
            })()
            return true
        }
    })
}

async function downloadVideo(): Promise<void> {
    if (downloadInProgress) return

    try {
        UiHelper.log('开始下载视频...')
        downloadInProgress = true

        await saveCurrentVideo()
        UiHelper.log('视频下载完成')
    } catch (e) {
        const msg = truncateError(e instanceof Error ? e.message : String(e), 500)
        alert(`下载失败: ${msg}`)
        UiHelper.log(`下载失败: ${msg}`)
    } finally {
        downloadInProgress = false
    }
}

async function bridgeToInstagram(): Promise<void> {
    if (bridgeInProgress) return

    try {
        UiHelper.log('开始转发到Instagram...')
        bridgeInProgress = true

        const result = await Relay.executeDownloadAndBridge()

        if (result.ok) {
            alert('转发成功！视频已发布到 Instagram Reels')
            UiHelper.log('转发成功')
        } else {
            const msg = truncateError(result.error || '未知错误', 500)
            alert(`转发失败: ${msg}`)
            UiHelper.log(`转发失败: ${msg}`)
        }
    } catch (e) {
        const msg = truncateError(e instanceof Error ? e.message : String(e), 500)
        alert(`转发失败: ${msg}`)
        UiHelper.log(`转发失败: ${msg}`)
    } finally {
        bridgeInProgress = false
    }
}

async function collectProfile(): Promise<void> {
    if (collectInProgress) return
    if (!UrlHelper.isProfilePage()) return

    const username = UrlHelper.getUsernameFromProfilePage()
    if (!username) return

    let sheetsInfluencer: NoxInfluencer | null = null
    try {
        const resp = await callAppsScript<{ok: boolean; items: NoxInfluencer[]}>('loadInfluencersByField', {
            platform: 'tiktok',
            field: 'username',
            operator: 'eq',
            value: username
        })
        if (resp.items && resp.items.length > 0) {
            sheetsInfluencer = resp.items[0]
        }
    } catch (e) {
        UiHelper.log(`Sheets 查询失败: ${truncateError(e, 200)}`)
    }

    const params = await showDialog({
        title: '采集设置',
        fields: TK_SINGLE_COLLECT_FIELDS
    })
    if (!params) return

    const maxVideoCount = Number(params.videoCount) || 50
    const sortType: SortType = params.sortType === 'hot' ? 'hot' : 'recent'
    const filters: CollectFilterOptions = {
        minLikeRate: Number(params.minLikeRate) || 0.02,
        maxDurationSec: Number(params.maxDurationSec) || 60
    }
    const today = new Date()
    const defaultFrom = new Date(today.getFullYear(), 0, 1)
    const fromTs = params.startDate ? new Date(params.startDate as string).getTime() : defaultFrom.getTime()
    const toTs = params.endDate ? new Date(params.endDate as string + 'T23:59:59').getTime() : today.getTime()

    collectInProgress = true
    try {
        if (sheetsInfluencer) {
            const influencer = sheetsInfluencer
            const displayName = influencer.name || `@${influencer.username}`
            UiHelper.log(`开始采集 ${displayName}（已在 Sheets）...`)

            let metrics: { qualifyingRate: number; postRate: number } | null = null
            try {
                metrics = await Collector.computeProfileMetricsByUsername(
                    username,
                    filters,
                    (msg) => UiHelper.log(msg)
                )
                await enqueueUpdateStatus('tiktok', influencer.channelId, {
                    qualifyingRate: metrics.qualifyingRate,
                    postRate: metrics.postRate,
                    updatedAt: new Date().toISOString()
                })
            } catch (error) {
                const errorMsg = truncateError(error instanceof Error ? error.message : String(error), 200)
                UiHelper.log(`指标预估失败: ${errorMsg}，刷新页面后跳过`)
                await enqueueUpdateStatus('tiktok', influencer.channelId, {
                    status: 'failed',
                    lastError: errorMsg,
                    updatedAt: new Date().toISOString()
                })
                await chrome.runtime.sendMessage({type: 'reset_tk_tab'})
                return
            }

            const excludeVideoIds = await loadCollectedVideoIdSet()
            UiHelper.log(`已加载 ${excludeVideoIds.size} 个已采视频 ID 用于去重`)

            const result = await Collector.collectProfileByUsername(
                username,
                maxVideoCount,
                fromTs,
                toTs,
                filters,
                (selectedCount, targetCount) => UiHelper.log(`入选 ${selectedCount}/${targetCount}`),
                (downloadedCount, selectedCount) => UiHelper.log(`下载 ${downloadedCount}/${selectedCount}`),
                (videoId) => UiHelper.log(`下载失败：${videoId}，已跳过`),
                influencer.genderTag,
                (msg) => UiHelper.log(msg),
                excludeVideoIds,
                sortType
            )

            await syncTkCollectSuccess(influencer.channelId, result.downloadSummary.succeeded)

            UiHelper.log(`采集完成：${result.filename}${metrics ? `，合格率 ${(metrics.qualifyingRate * 100).toFixed(1)}%` : ''}，下载 ${result.downloadSummary.succeeded}/${result.downloadSummary.attempted}`)
            alert(`采集完成，已生成归档包：${result.filename}`)
        } else {
            UiHelper.log(`开始采集博主页数据... 数量=${maxVideoCount}，${new Date(fromTs).toISOString().slice(0,10)}~${new Date(toTs).toISOString().slice(0,10)}`)

            const excludeVideoIds = await loadCollectedVideoIdSet()
            UiHelper.log(`已加载 ${excludeVideoIds.size} 个已采视频 ID 用于去重`)

            const result = await Collector.collectCurrentProfile(
                maxVideoCount,
                fromTs,
                toTs,
                filters,
                (selectedCount: number, targetCount: number) => {
                    UiHelper.log(`入选 ${selectedCount}/${targetCount}`)
                },
                (downloadedCount: number, selectedCount: number, targetCount: number) => {
                    UiHelper.log(`下载 ${downloadedCount}/${selectedCount}（目标 ${targetCount} 入选 ${selectedCount}）`)
                },
                (videoId: string) => {
                    UiHelper.log(`下载失败：${videoId}，已跳过`)
                },
                undefined,
                undefined,
                excludeVideoIds,
                sortType
            )
            UiHelper.log(`采集完成，已生成归档包：${result.filename}`)
            const actualVideoCount = Array.isArray(result.output.videos) ? result.output.videos.length : 0
            if (actualVideoCount < maxVideoCount) {
                UiHelper.log(`符合条件的视频只有 ${actualVideoCount} 个，少于目标数量 ${maxVideoCount}`)
            }
            UiHelper.log(`视频下载成功 ${result.downloadSummary.succeeded}/${result.downloadSummary.attempted}`)
            if (result.downloadSummary.failed > 0) {
                UiHelper.log(`视频下载失败 ${result.downloadSummary.failed} 个：${result.downloadSummary.failedVideoIds.join(', ')}`)
            }

            const failedDownloadText = result.downloadSummary.failed > 0
                ? `\n视频下载成功 ${result.downloadSummary.succeeded}/${result.downloadSummary.attempted}，失败 ${result.downloadSummary.failed}`
                    + `\n失败的 videoId: ${result.downloadSummary.failedVideoIds.join(', ')}`
                : `\n视频下载成功 ${result.downloadSummary.succeeded}/${result.downloadSummary.attempted}`
            if (actualVideoCount < maxVideoCount) {
                alert(`采集完成，已生成归档包：${result.filename}\n符合条件的视频只有 ${actualVideoCount} 个，少于目标数量 ${maxVideoCount}${failedDownloadText}`)
            } else {
                alert(`采集完成，已生成归档包：${result.filename}${failedDownloadText}`)
            }
        }
    } catch (error) {
        const msg = Collector.formatError(error)
        if (sheetsInfluencer && msg === NO_QUALIFYING_VIDEO_ERROR) {
            UiHelper.log(`${msg}，已标记为已采集`)
            await enqueueUpdateStatus('tiktok', sheetsInfluencer.channelId, {
                status: 'used',
                archivedVideoCount: 0,
                lastError: '',
                updatedAt: new Date().toISOString()
            })
        } else {
            UiHelper.log(`采集失败: ${msg}`)
            alert(`采集失败: ${msg}`)
        }
    } finally {
        collectInProgress = false
    }
}

async function batchCollectFromPool(): Promise<void> {
    if (batchCollectInProgress || collectInProgress) return

    const params = await showDialog({
        title: 'TK批量采集',
        fields: TK_BATCH_COLLECT_FIELDS
    })
    if (!params) return

    const batchSize = Number(params.batchSize) || 500
    const maxVideoCount = Number(params.videoCount) || 50
    const sortType: SortType = params.sortType === 'hot' ? 'hot' : 'recent'
    const minLikeRate = Number(params.minLikeRate) || 0.02
    const maxDurationSec = Number(params.maxDurationSec) || 60
    const today2 = new Date()
    const defaultFrom2 = new Date(today2.getFullYear(), 0, 1)
    const fromTs = params.startDate ? new Date(params.startDate as string).getTime() : defaultFrom2.getTime()
    const toTs = params.endDate ? new Date(params.endDate as string + 'T23:59:59').getTime() : today2.getTime()

    batchCollectInProgress = true
    await UiHelper.setBatchCollecting(true)
    try {
        UiHelper.log(`开始批量采集，目标 ${batchSize} 个博主，${new Date(fromTs).toISOString().slice(0,10)}~${new Date(toTs).toISOString().slice(0,10)}`)

        const tkExecutor = createTkBatchExecutor({
            log: (m) => UiHelper.log(m),
            label: (_progress, inf) => `${inf.genderTag}${inf.name || `@${inf.username}`}`
        })

        await runTkBatchCollect(tkExecutor, {
            batchSize,
            fromTs,
            toTs,
            minLikeRate,
            maxDurationSec,
            sortType,
            maxVideoCount
        })
    } catch (error) {
        UiHelper.log(`批量采集异常: ${truncateError(error instanceof Error ? error.message : String(error), 300)}`)
    } finally {
        batchCollectInProgress = false
        await UiHelper.setBatchCollecting(false)
    }
}

export function setup(): void {
    initTikTokMessageHandler()
    void UiHelper.inject({
        onDownload: downloadVideo,
        onBridge: bridgeToInstagram,
        onCollect: collectProfile,
        onBatchCollect: batchCollectFromPool
    })
}
