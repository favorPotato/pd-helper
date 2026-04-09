import {Downloader} from './downloader'
import {Collector} from './collector'
import {Relay} from './relay'
import {UiHelper, UrlHelper} from './helpers'
import {truncateError} from '../../shared/errors'

declare const window: Window & {
    __TT_BRIDGE_HANDLER_LOADED__?: boolean
}

let downloadInProgress = false
let bridgeInProgress = false
let collectInProgress = false

interface CollectYearRange {
    startYear: number
    endYear: number
    label: string
}

function requestCollectVideoCount(): number | null {
    const input = window.prompt('请输入采集视频数量（默认 10）', '')
    if (input === null) return null

    const trimmed = input.trim()
    if (!trimmed) return 10

    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return 10
    return parsed
}

function parseCollectYearRange(input: string): CollectYearRange {
    const trimmed = input.trim()
    const normalized = trimmed || '2025-2026'
    const single = normalized.match(/^(\d{4})$/)
    if (single) {
        const year = Number.parseInt(single[1], 10)
        return {startYear: year, endYear: year, label: String(year)}
    }

    const range = normalized.match(/^(\d{4})\s*-\s*(\d{4})$/)
    if (range) {
        const left = Number.parseInt(range[1], 10)
        const right = Number.parseInt(range[2], 10)
        const startYear = Math.min(left, right)
        const endYear = Math.max(left, right)
        return {startYear, endYear, label: `${startYear}-${endYear}`}
    }

    return {startYear: 2025, endYear: 2026, label: '2025-2026'}
}

function requestCollectYearRange(): CollectYearRange | null {
    const input = window.prompt('请输入采集年份（默认 2025-2026）', '')
    if (input === null) return null
    return parseCollectYearRange(input)
}

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
