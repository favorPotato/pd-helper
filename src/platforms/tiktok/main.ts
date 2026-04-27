import {Downloader} from './downloader'
import {Collector, type CollectFilterOptions} from './collector'
import {ensureTikTokPageContextReady} from './client'
import {Relay} from './relay'
import {UiHelper, UrlHelper} from './helpers'
import {showDialog} from '../../shared/custom-dialog'
import {truncateError} from '../../shared/errors'

import {sleepRandom} from '../../shared/timing'
import {callAppsScript} from '../../shared/apps-script-client'
import {enqueueUpdateStatus, enqueueUpsertVideos} from '../../shared/sheets-sync'
import type {NoxInfluencer} from '../nox/types'
import {
    reportRemoteCollectProgress,
    type PrepareTkPageContextResponse,
    TK_PROFILE_METRICS_REMOTE,
    TK_COLLECT_REMOTE,
    TK_PREPARE_PAGE_CONTEXT
} from '../../shared/remote-collect'

declare const window: Window & {
    __TT_BRIDGE_HANDLER_LOADED__?: boolean
}

async function syncCollectResult(channelId: string, result: { downloadSummary: { succeeded: number }; output: { videos: { videoId: string }[] } }): Promise<void> {
    await enqueueUpdateStatus('tiktok', channelId, {
        status: 'used',
        archivedVideoCount: result.downloadSummary.succeeded,
        lastError: '',
        updatedAt: new Date().toISOString()
    })
    if (result.output.videos.length > 0) {
        const videoRows = result.output.videos.map(v => ({
            videoId: v.videoId,
            videoJson: JSON.stringify(v)
        }))
        await enqueueUpsertVideos('tiktok', videoRows)
    }
}

let downloadInProgress = false
let bridgeInProgress = false
let collectInProgress = false
let batchCollectInProgress = false

const NO_QUALIFYING_VIDEO_ERROR = '当前博主没有符合要求的视频'

function initTikTokMessageHandler(): void {
    if (window.__TT_BRIDGE_HANDLER_LOADED__) return
    window.__TT_BRIDGE_HANDLER_LOADED__ = true

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return

        if (msg.type === TK_COLLECT_REMOTE) {
            ;(async () => {
                try {
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
                    const onSelectedCount = (selectedCount: number, targetCount: number) => reportRemoteCollectProgress(clientTabId, `入选 ${selectedCount}/${targetCount}`)
                    const onDownloadProgress = (downloadedCount: number, selectedCount: number, targetCount: number) => reportRemoteCollectProgress(clientTabId, `下载 ${downloadedCount}/${selectedCount}（目标 ${targetCount} 入选 ${selectedCount}）`)
                    const onDownloadFailed = (videoId: string) => reportRemoteCollectProgress(clientTabId, `下载失败：${videoId}，已跳过`)
                    const onLog = (message: string) => reportRemoteCollectProgress(clientTabId, message)

                    const result = username
                        ? await Collector.collectProfileByUsername(
                            username,
                            maxVideoCount,
                            fromTs,
                            toTs,
                            filters,
                            onSelectedCount,
                            onDownloadProgress,
                            onDownloadFailed,
                            filenamePrefix,
                            onLog
                        )
                        : await Collector.collectCurrentProfile(
                            maxVideoCount,
                            fromTs,
                            toTs,
                            filters,
                            onSelectedCount,
                            onDownloadProgress,
                            onDownloadFailed,
                            filenamePrefix,
                            onLog
                        )

                    const videoRows = (result.output.videos || []).map((video) => ({
                        videoId: video.videoId,
                        videoJson: JSON.stringify(video)
                    }))
                    if (videoRows.length > 0) {
                        await enqueueUpsertVideos('tiktok', videoRows)
                    }

                    sendResponse({
                        ok: true,
                        filename: result.filename,
                        videoCount: result.output.videos?.length || 0,
                        downloadSummary: result.downloadSummary
                    })
                } catch (error) {
                    sendResponse({ok: false, error: Collector.formatError(error)})
                }
            })()
            return true
        }

        if (msg.type === TK_PROFILE_METRICS_REMOTE) {
            ;(async () => {
                try {
                    const clientTabId = typeof msg.clientTabId === 'number' ? msg.clientTabId : 0
                    const username = typeof msg.username === 'string' ? msg.username : ''
                    const filters: CollectFilterOptions = {
                        minLikeRate: typeof msg.minLikeRate === 'number' ? msg.minLikeRate : 0.02,
                        maxDurationSec: typeof msg.maxDurationSec === 'number' ? msg.maxDurationSec : 60
                    }
                    const onLog = (message: string) => reportRemoteCollectProgress(clientTabId, message)
                    const metrics = await Collector.computeProfileMetricsByUsername(username, filters, onLog)
                    sendResponse({ok: true, ...metrics})
                } catch (error) {
                    sendResponse({ok: false, error: Collector.formatError(error)})
                }
            })()
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

        const videoData = await Downloader.downloadTikTokVideo()
        const blob = new Blob([videoData.bytes], {type: videoData.mime})
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = videoData.name
        a.click()
        URL.revokeObjectURL(url)
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
        fields: [
            {key: 'videoCount', label: '视频数量', type: 'number', value: 20, min: 1},
            {key: 'minLikeRate', label: '最低点赞率 (0~1)', type: 'number', value: 0.02, step: 0.01, min: 0, max: 1, group: '过滤条件'},
            {key: 'maxDurationSec', label: '最长视频时长（秒）', type: 'number', value: 60, step: 1, min: 1, group: '过滤条件'},
            {key: 'startDate', label: '起始日期', type: 'date'},
            {key: 'endDate', label: '截止日期', type: 'date'}
        ]
    })
    if (!params) return

    const maxVideoCount = Number(params.videoCount) || 20
    const filters: CollectFilterOptions = {
        minLikeRate: Number(params.minLikeRate) || 0.02,
        maxDurationSec: Number(params.maxDurationSec) || 60
    }
    const today = new Date()
    const defaultFrom = new Date(today); defaultFrom.setMonth(defaultFrom.getMonth() - 3)
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
                (msg) => UiHelper.log(msg)
            )

            await syncCollectResult(influencer.channelId, result)

            UiHelper.log(`采集完成：${result.filename}${metrics ? `，合格率 ${(metrics.qualifyingRate * 100).toFixed(1)}%` : ''}，下载 ${result.downloadSummary.succeeded}/${result.downloadSummary.attempted}`)
            alert(`采集完成，已生成归档包：${result.filename}`)
        } else {
            UiHelper.log(`开始采集博主页数据... 数量=${maxVideoCount}，${new Date(fromTs).toISOString().slice(0,10)}~${new Date(toTs).toISOString().slice(0,10)}`)

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
                }
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
        fields: [
            {key: 'batchSize', label: '采集博主数', type: 'number', value: 500, min: 1},
            {key: 'videoCount', label: '每博主视频数', type: 'number', value: 20, min: 1},
            {key: 'minLikeRate', label: '最低点赞率 (0~1)', type: 'number', value: 0.02, step: 0.01, min: 0, max: 1, group: '过滤条件'},
            {key: 'maxDurationSec', label: '最长视频时长（秒）', type: 'number', value: 60, step: 1, min: 1, group: '过滤条件'},
            {key: 'startDate', label: '起始日期', type: 'date'},
            {key: 'endDate', label: '截止日期', type: 'date'}
        ]
    })
    if (!params) return

    const batchSize = Number(params.batchSize) || 500
    const maxVideoCount = Number(params.videoCount) || 20
    const filters: CollectFilterOptions = {
        minLikeRate: Number(params.minLikeRate) || 0.02,
        maxDurationSec: Number(params.maxDurationSec) || 60
    }
    const today2 = new Date()
    const defaultFrom2 = new Date(today2); defaultFrom2.setMonth(defaultFrom2.getMonth() - 3)
    const fromTs = params.startDate ? new Date(params.startDate as string).getTime() : defaultFrom2.getTime()
    const toTs = params.endDate ? new Date(params.endDate as string + 'T23:59:59').getTime() : today2.getTime()

    let influencers: NoxInfluencer[]
    try {
        const sheetsResp = await callAppsScript<{ok: boolean; items: NoxInfluencer[]}>('loadInfluencersByStatus', {
            platform: 'tiktok',
            status: 'unused',
            limit: batchSize
        })
        influencers = sheetsResp.items || []
        UiHelper.log(`从 Sheets 拉取 ${influencers.length} 个未采博主`)
        
    } catch (e) {
        UiHelper.log(`从 Sheets 拉取失败: ${truncateError(e, 200)}`)
        return
    }

    if (influencers.length === 0) {
        UiHelper.log('Sheets 中没有未采博主')
        return
    }

    batchCollectInProgress = true
    await UiHelper.setBatchCollecting(true)
    try {
        UiHelper.log(`开始批量采集 ${influencers.length} 个博主，${new Date(fromTs).toISOString().slice(0,10)}~${new Date(toTs).toISOString().slice(0,10)}`)
        const succeededChannelIds: string[] = []
        const noVideoChannelIds: string[] = []

        for (let index = 0; index < influencers.length; index += 1) {
            const influencer = influencers[index]
            const progress = `[${index + 1}/${influencers.length}]`
            const displayName = influencer.name || `@${influencer.username}`

            try {
                UiHelper.log(`${progress} 开始采集 ${influencer.genderTag}${displayName}...`)
                let metrics: { qualifyingRate: number; postRate: number } | null = null
                try {
                    metrics = await Collector.computeProfileMetricsByUsername(
                        influencer.username,
                        filters,
                        (message) => UiHelper.log(`${progress} ${message}`)
                    )
                    await enqueueUpdateStatus('tiktok', influencer.channelId, {
                        qualifyingRate: metrics.qualifyingRate,
                        postRate: metrics.postRate,
                        updatedAt: new Date().toISOString()
                    })
                } catch (error) {
                    const errorMsg = truncateError(error instanceof Error ? error.message : String(error), 200)
                    UiHelper.log(`${progress} 指标预估失败: ${errorMsg}，刷新页面后跳过`)
                    await enqueueUpdateStatus('tiktok', influencer.channelId, {
                        status: 'failed',
                        lastError: errorMsg,
                        updatedAt: new Date().toISOString()
                    })
                    await chrome.runtime.sendMessage({type: 'reset_tk_tab'})
                    return
                }
                const result = await Collector.collectProfileByUsername(
                    influencer.username,
                    maxVideoCount,
                    fromTs,
                    toTs,
                    filters,
                    (selectedCount, targetCount) => UiHelper.log(`${progress} 入选 ${selectedCount}/${targetCount}`),
                    (downloadedCount, selectedCount) => UiHelper.log(`${progress} 下载 ${downloadedCount}/${selectedCount}`),
                    (videoId) => UiHelper.log(`${progress} 下载失败：${videoId}，已跳过`),
                    influencer.genderTag,
                    (message) => UiHelper.log(`${progress} ${message}`)
                )
                succeededChannelIds.push(influencer.channelId)
                UiHelper.log(`${progress} 完成: ${result.filename} (${metrics ? `合格率 ${(metrics.qualifyingRate * 100).toFixed(1)}%, ` : ''}下载 ${result.downloadSummary.succeeded}/${result.downloadSummary.attempted})`)
                await syncCollectResult(influencer.channelId, result)
            } catch (error) {
                const msg = Collector.formatError(error)
                UiHelper.log(`${progress} 采集失败: ${msg}`)
                if (msg === NO_QUALIFYING_VIDEO_ERROR) {
                    noVideoChannelIds.push(influencer.channelId)
                    await enqueueUpdateStatus('tiktok', influencer.channelId, {
                        status: 'used',
                        archivedVideoCount: 0,
                        lastError: '',
                        updatedAt: new Date().toISOString()
                    })
                } else {
                    await enqueueUpdateStatus('tiktok', influencer.channelId, {
                        status: 'failed',
                        lastError: msg.slice(0, 200),
                        updatedAt: new Date().toISOString()
                    })
                }
            }

            if (index < influencers.length - 1) {
                UiHelper.log('等待中...')
                await sleepRandom(5000, 8000)
            }
        }

        UiHelper.log(`批量采集结束：成功 ${succeededChannelIds.length}，无视频 ${noVideoChannelIds.length}，状态已推送 Sheets`)
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
