import {Downloader} from './downloader'
import type {BridgeResult, Mp4Meta} from './types'
import {truncateError} from '../../shared/errors'
import {safeSendMessage} from '../../shared/messaging'
import {PREPARE_IG_TAB, type PrepareIgTabResponse} from '../../shared/remote-collect'

export class Relay {
    static async executeDownloadAndBridge(caption = ''): Promise<BridgeResult> {
        try {
            const [videoData] = await Promise.all([
                Downloader.downloadTikTokVideo(),
                Relay.prepareIGTab()
            ])

            const storeResult = await Relay.storeVideoToCache({
                bytes: videoData.bytes,
                mime: videoData.mime,
                name: videoData.name,
                meta: videoData.meta
            })

            if (!storeResult?.ok) {
                return {ok: false, error: '视频缓存失败'}
            }

            const uploadResult = await safeSendMessage<{
                ok: boolean
                reason?: string
                error?: string
                uploadResult?: { ok: boolean; error?: string; status?: number; bodySnippet?: string }
            }>({
                type: 'open_ig_and_upload',
                caption
            })

            if (!uploadResult?.ok) {
                const reason = uploadResult?.reason || 'unknown_error'
                const detail = truncateError(uploadResult?.error || 'unknown', 500)
                const combined = detail ? `${reason}: ${detail}` : reason
                return {
                    ok: false,
                    error: combined,
                    size: videoData.bytes.byteLength,
                    meta: videoData.meta
                }
            }

            const innerResult = uploadResult.uploadResult
            if (!innerResult?.ok) {
                const err = innerResult?.error
                const status = innerResult?.status
                const body = String(innerResult?.bodySnippet || '')
                const detail = err
                    ? `upload_failed: ${truncateError(err, 500)}`
                    : (status || body)
                        ? `upload_failed: ${truncateError(`status=${status || 0} body=${body.slice(0, 120)}`, 500)}`
                        : 'upload_failed: unknown'

                return {
                    ok: false,
                    error: detail,
                    size: videoData.bytes.byteLength,
                    meta: videoData.meta,
                    uploadResult: innerResult
                }
            }

            return {
                ok: true,
                size: videoData.bytes.byteLength,
                meta: videoData.meta,
                uploadResult: innerResult
            }
        } catch (e) {
            return {ok: false, error: truncateError(e instanceof Error ? e.message : String(e), 500)}
        }
    }

    private static async storeVideoToCache(videoData: {
        bytes: ArrayBuffer
        mime: string
        name: string
        meta: Mp4Meta
    }): Promise<{ ok: boolean; error?: string }> {
        const sizeMB = videoData.bytes.byteLength / (1024 * 1024)
        if (sizeMB > 10) {
            console.warn(`[TikTok Bridge] Large video payload: ${sizeMB.toFixed(2)} MB - may impact performance`)
        }

        const bytesArray = Array.from(new Uint8Array(videoData.bytes))

        const result = await safeSendMessage<{ ok: boolean; error?: string }>({
            type: 'cache_store_whole',
            bytes: bytesArray,
            mime: videoData.mime,
            name: videoData.name,
            meta: videoData.meta
        })

        return result ?? {ok: false, error: 'No response from background'}
    }

    private static async prepareIGTab(): Promise<void> {
        const result = await safeSendMessage<PrepareIgTabResponse>({type: PREPARE_IG_TAB})
        if (!result?.ok) {
            const reason = result?.reason || 'prepare_ig_tab_failed'
            const detail = truncateError(result?.error || 'unknown', 500)
            throw new Error(`${reason}: ${detail}`)
        }
    }
}
