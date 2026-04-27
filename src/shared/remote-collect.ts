import {safeSendMessage} from './messaging'

export const PREPARE_TK_TAB = 'prepare_tk_tab'
export const PREPARE_IG_TAB = 'prepare_ig_tab'
export const TK_PROFILE_METRICS_VIA_TAB = 'tk_profile_metrics_via_tab'
export const TK_PROFILE_METRICS_REMOTE = 'tk_profile_metrics_remote'
export const TK_COLLECT_VIA_TAB = 'tk_collect_via_tab'
export const TK_COLLECT_REMOTE = 'tk_collect_remote'
export const TK_COLLECT_PROGRESS = 'tk_collect_progress'
export const TK_PREPARE_PAGE_CONTEXT = 'tk_prepare_page_context'
export const NOX_LOG = 'nox_log'

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
    downloadSummary?: RemoteDownloadSummary
    error?: string
}

export interface TkProfileMetricsResponse {
    ok: boolean
    qualifyingRate?: number
    postRate?: number
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
