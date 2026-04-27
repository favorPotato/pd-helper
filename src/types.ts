import type {CleanedComment, CleanedMedia} from './platforms/instagram/types'

export type ScriptApiEndpoint = '/health' | '/precheck' | '/generate-script'

export interface ScriptApiUploadFile {
    filename: string
    mimeType: string
    bytes: number[]
}

export interface ScriptApiRequestMessage {
    type: 'script_api_request'
    endpoint: ScriptApiEndpoint
    method?: 'GET' | 'POST'
    body?: unknown
    bodyType?: 'json' | 'multipart'
    files?: ScriptApiUploadFile[]
}

export interface ScriptApiResponse {
    ok: boolean
    status: number
    data: unknown
    error?: string
}

export interface AppsScriptRequestMessage {
    type: 'apps_script_request'
    action: string
    payload: unknown
}

export interface AppsScriptResponse {
    ok: boolean
    status: number
    data: unknown
    error?: string
}

export interface DownloadMessage {
    action: 'download'
    url: string
    filename: string
}

export interface NoxSearchRequestMessage {
    type: 'nox_search_request'
    url: string
}

export interface NoxSearchResponse {
    ok: boolean
    status: number
    data: Record<string, unknown> | null
    error?: string
}

interface MediaAnalysis {
    description: string
    per_image_notes: string[] | null
    visual_tags: string[]
    tone: string
    hook_points: string[]
    text_in_image: string | null
    opening_hook: string | null
    turning_point: string | null
    highlight_moment: string | null
}

export interface ExtractResult {
    media: CleanedMedia | null
    comments: CleanedComment[]
    media_analysis: MediaAnalysis
}
