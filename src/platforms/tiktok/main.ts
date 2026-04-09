import {Downloader} from './downloader'
import {Collector} from './collector'
import {ensureTikTokPageContextReady} from './client'
import {Relay} from './relay'
import {UiHelper, UrlHelper} from './helpers'
import {requestCollectVideoCount, requestCollectYearRange} from '../../shared/collect-params'
import {truncateError} from '../../shared/errors'
import {
    reportRemoteCollectProgress,
    type PrepareTkPageContextResponse,
    TK_COLLECT_REMOTE,
    TK_PREPARE_PAGE_CONTEXT
} from '../../shared/remote-collect'

declare const window: Window & {
    __TT_BRIDGE_HANDLER_LOADED__?: boolean
}

let downloadInProgress = false
let bridgeInProgress = false
let collectInProgress = false

function initTikTokMessageHandler(): void {
    if (window.__TT_BRIDGE_HANDLER_LOADED__) return
    window.__TT_BRIDGE_HANDLER_LOADED__ = true

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return

        if (msg.type === 'tiktok_download') {
            ;(async () => {
                try {
                    const caption = typeof msg.caption === 'string' ? msg.caption : ''
                    const result = await Relay.executeDownloadAndBridge(caption)

                    sendResponse({
                        ok: result.ok,
                        size: result.size,
                        meta: result.meta,
                        error: result.error,
                        uploadResult: result.ok
                            ? {ok: true, uploadResult: result.uploadResult}
                            : {ok: false, error: result.error || 'upload_failed'}
                    })
                } catch (e) {
                    sendResponse({ok: false, error: e instanceof Error ? e.message : String(e)})
                }
            })()
            return true
        }

        if (msg.type === TK_COLLECT_REMOTE) {
            ;(async () => {
                try {
                    const clientTabId = typeof msg.clientTabId === 'number' ? msg.clientTabId : 0
                    const username = typeof msg.username === 'string' ? msg.username : ''
                    const maxVideoCount = typeof msg.maxVideoCount === 'number' ? msg.maxVideoCount : 10
                    const startYear = typeof msg.startYear === 'number' ? msg.startYear : 2025
                    const endYear = typeof msg.endYear === 'number' ? msg.endYear : 2026
                    const filenamePrefix = typeof msg.filenamePrefix === 'string' ? msg.filenamePrefix : ''
                    const onSelectedCount = (selectedCount: number, targetCount: number) => reportRemoteCollectProgress(clientTabId, `入选 ${selectedCount}/${targetCount}`)
                    const onDownloadProgress = (downloadedCount: number, selectedCount: number, targetCount: number) => reportRemoteCollectProgress(clientTabId, `下载 ${downloadedCount}/${selectedCount}（目标 ${targetCount} 入选 ${selectedCount}）`)
                    const onDownloadFailed = (videoId: string) => reportRemoteCollectProgress(clientTabId, `下载失败：${videoId}，已跳过`)
                    const onLog = (message: string) => reportRemoteCollectProgress(clientTabId, message)

                    const result = username
                        ? await Collector.collectProfileByUsername(
                            username,
                            maxVideoCount,
                            startYear,
                            endYear,
                            onSelectedCount,
                            onDownloadProgress,
                            onDownloadFailed,
                            filenamePrefix,
                            onLog
                        )
                        : await Collector.collectCurrentProfile(
                            maxVideoCount,
                            startYear,
                            endYear,
                            onSelectedCount,
                            onDownloadProgress,
                            onDownloadFailed,
                            filenamePrefix,
                            onLog
                        )

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

    const maxVideoCount = requestCollectVideoCount()
    if (maxVideoCount === null) return
    const yearRange = requestCollectYearRange()
    if (yearRange === null) return

    try {
        UiHelper.log(`开始采集博主页数据... 数量=${maxVideoCount}，年份=${yearRange.label}`)
        collectInProgress = true

        const result = await Collector.collectCurrentProfile(
            maxVideoCount,
            yearRange.startYear,
            yearRange.endYear,
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
    } catch (error) {
        const msg = Collector.formatError(error)
        if (msg === '当前博主没有符合要求的视频') {
            UiHelper.log(msg)
            alert(msg)
        } else {
            UiHelper.log(`采集失败: ${msg}`)
            alert(`采集失败: ${msg}`)
        }
    } finally {
        collectInProgress = false
    }
}

export function setup(): void {
    initTikTokMessageHandler()
    // 初始化UI
    void UiHelper.inject({
        onDownload: downloadVideo,
        onBridge: bridgeToInstagram,
        onCollect: collectProfile
    })
}
