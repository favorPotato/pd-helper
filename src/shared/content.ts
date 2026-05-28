import type {Mp4Meta, UploadResult} from '../platforms/instagram/uploader'
import type {HeaderValues} from './header-cache'
import {truncateError} from './errors'
import {runFireAndForget} from './cli-bridge/cs-runtime'
import {delay} from './timing'

type ExecuteUploadFn = (
    videoBlob: Blob,
    meta: Mp4Meta,
    caption: string,
    headersCaptured: HeaderValues
) => Promise<UploadResult>

declare const window: Window & {
    __IG_BRIDGE_CS_LOADED__?: boolean
    __IG_SETUP_LOADED__?: boolean
    __TT_SETUP_LOADED__?: boolean
    __NOX_SETUP_LOADED__?: boolean
    __IG_HELPER_PING_HANDLER_LOADED__?: boolean
}

void start()

async function start(): Promise<void> {
    if (window.top !== window) return

    if (!window.__IG_HELPER_PING_HANDLER_LOADED__) {
        window.__IG_HELPER_PING_HANDLER_LOADED__ = true
        chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
            if (msg?.type === 'ping') {
                sendResponse({ok: true, from: 'content_script', href: location.href})
                return
            }

            if (msg?.type === 'pd:csTest' && typeof msg.taskId === 'string') {
                const taskId = msg.taskId
                const count = Math.max(1, Math.min(5, Number(msg.count) || 3))
                sendResponse({ok: true, accepted: true})
                void runFireAndForget(taskId, async (rt) => {
                    for (let i = 1; i <= count; i += 1) {
                        rt.throwIfCancelled()
                        await delay(300)
                        rt.log(`cs tick ${i}/${count}`)
                    }
                    return {from: 'content_script', href: location.href, ticks: count}
                })
                return true
            }
        })
    }

    const hostname = window.location.hostname

    if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) {
        if (!window.__IG_BRIDGE_CS_LOADED__) {
            window.__IG_BRIDGE_CS_LOADED__ = true
            const {executeUpload} = await import('../platforms/instagram/uploader')
            initUploadHandler(executeUpload)
        }

        if (!window.__IG_SETUP_LOADED__) {
            window.__IG_SETUP_LOADED__ = true
            const {setup: setupInstagram} = await import('../platforms/instagram/main')
            setupInstagram()
        }
        return
    }

    if (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com')) {
        if (window.__TT_SETUP_LOADED__) return
        window.__TT_SETUP_LOADED__ = true
        const {setup: setupTikTok} = await import('../platforms/tiktok/main')
        setupTikTok()
        return
    }

    if (hostname.endsWith('.noxinfluencer.com')) {
        if (window.__NOX_SETUP_LOADED__) return
        window.__NOX_SETUP_LOADED__ = true
        const {setup: setupNox} = await import('../platforms/nox/main')
        setupNox()
        return
    }
}

function initUploadHandler(executeUpload: ExecuteUploadFn): void {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.type !== 'start_upload') return

        ;(async () => {
            try {
                const headersCaptured = (await chrome.runtime.sendMessage({type: 'get_header_values'})) as HeaderValues

                const cacheResult = await chrome.runtime.sendMessage({type: 'cache_get_whole'})
                if (!cacheResult?.ok) {
                    sendResponse({
                        ok: false,
                        error: truncateError(cacheResult?.reason || cacheResult?.error || 'Failed to get video from cache', 500)
                    })
                    return
                }

                const bytes = new Uint8Array(cacheResult.bytes)
                const videoBlob = new Blob([bytes], {type: cacheResult.mime || 'video/mp4'})
                const meta: Mp4Meta = cacheResult.meta || {width: 0, height: 0, durationSec: 0}

                const result = await executeUpload(videoBlob, meta, msg.caption || '', headersCaptured)

                await chrome.runtime.sendMessage({type: 'cache_clear'}).catch(() => undefined)

                sendResponse(result)
            } catch (e) {
                await chrome.runtime.sendMessage({type: 'cache_clear'}).catch(() => undefined)
                sendResponse({ok: false, error: truncateError(String(e), 500)})
            }
        })()

        return true
    })
}
