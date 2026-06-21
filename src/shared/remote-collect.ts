import {safeSendMessage} from './messaging'

export const PREPARE_TK_TAB = 'prepare_tk_tab'
export const PREPARE_IG_TAB = 'prepare_ig_tab'
export const TK_PROFILE_METRICS_VIA_TAB = 'tk_profile_metrics_via_tab'
export const TK_PROFILE_METRICS_REMOTE = 'tk_profile_metrics_remote'
export const TK_COLLECT_VIA_TAB = 'tk_collect_via_tab'
export const TK_COLLECT_REMOTE = 'tk_collect_remote'
export const TK_FETCH_VIDEO_REMOTE = 'tk_fetch_video_remote'
export const TK_COLLECT_PROGRESS = 'tk_collect_progress'
export const TK_PREPARE_PAGE_CONTEXT = 'tk_prepare_page_context'
export const NOX_LOG = 'nox_log'
export const PD_RUNTIME_DISPATCH = 'pd_runtime_dispatch'
export const PD_RUNTIME_PING = 'pd_runtime_ping'

export const TK_BATCH_COLLECT_REMOTE = 'tk_batch_collect_remote'
export const TK_DOWNLOAD_VIDEO_REMOTE = 'tk_download_video_remote'
export const TK_BRIDGE_TO_IG_REMOTE = 'tk_bridge_to_ig_remote'
export const IG_COLLECT_REELS_REMOTE = 'ig_collect_reels_remote'
export const IG_MANUAL_ANALYZE_REMOTE = 'ig_manual_analyze_remote'
export const IG_GENERATE_SCRIPT_REMOTE = 'ig_generate_script_remote'
export const NOX_AUTO_COLLECT_REMOTE = 'nox_auto_collect_remote'
export const NOX_COLLECT_AUDIENCE_REMOTE = 'nox_collect_audience_remote'
export const NOX_BACKFILL_PROFILES_REMOTE = 'nox_backfill_profiles_remote'
export const NOX_COLLECT_TIKTOK_POOL_REMOTE = 'nox_collect_tiktok_pool_remote'
export const NOX_PAUSE_AUTO_COLLECT_REMOTE = 'nox_pause_auto_collect_remote'
export const NOX_RESUME_AUTO_COLLECT_REMOTE = 'nox_resume_auto_collect_remote'
export const EXOLYT_PACK_VIDEO_REMOTE = 'exolyt_pack_video_remote'
// search/detail 解耦：search 结果累积进 CS 内存（collect-state），detail 逐条流式回传 node。
export const EXOLYT_SEARCH_REMOTE = 'exolyt_search_remote'
export const EXOLYT_DETAIL_REMOTE = 'exolyt_detail_remote'
// 链路A：node 在视频下载完成后逐条 call，将 videoId 写回远程去重表格（与链路B 口径一致：下载完成才写）
export const EXOLYT_MARK_COLLECTED_REMOTE = 'exolyt_mark_collected_remote'

interface RemoteDownloadSummary {
    succeeded: number
    failed: number
    attempted: number
}

export interface PrepareTkTabResponse {
    ok: boolean
    tabId?: number
    href?: string
    error?: string
}

export interface PrepareIgTabResponse {
    ok: boolean
    tabId?: number
    reason?: string
    error?: string
}

export interface PrepareTkPageContextResponse {
    ok: boolean
    href?: string
    error?: string
}

export interface TkCollectViaTabResponse {
    ok: boolean
    filename?: string
    videoCount?: number
    collectedVideoIds?: string[]
    downloadSummary?: RemoteDownloadSummary
    error?: string
}

export interface TkProfileMetricsResponse {
    ok: boolean
    qualifyingRate?: number
    postRate?: number
    error?: string
}

export interface PdRuntimeDispatchResponse {
    ok: boolean
    accepted?: boolean
    error?: string
}

interface TkCollectProgressResponse {
    ok: boolean
    error?: string
}

interface NoxLogMessage {
    type: typeof NOX_LOG
    message: string
}

export function isNoxLogMessage(message: unknown): message is NoxLogMessage {
    return !!message
        && typeof message === 'object'
        && (message as {type?: unknown}).type === NOX_LOG
        && typeof (message as {message?: unknown}).message === 'string'
}

export async function reportRemoteCollectProgress(clientTabId: number, message: string): Promise<void> {
    if (!clientTabId || !message.trim()) return
    try {
        await safeSendMessage<TkCollectProgressResponse>({
            type: TK_COLLECT_PROGRESS,
            clientTabId,
            message
        })
    } catch {
    }
}
