import {Downloader} from './downloader'
import {Relay} from './relay'
import {UiHelper} from './helpers'
import {truncateError} from '../../shared/errors'

declare const window: Window & {
    __TT_BRIDGE_HANDLER_LOADED__?: boolean
}

let downloadInProgress = false
let bridgeInProgress = false

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

export function setup(): void {
    initTikTokMessageHandler()
    // 初始化UI
    void UiHelper.inject({
        onDownload: downloadVideo,
        onBridge: bridgeToInstagram
    })
}
