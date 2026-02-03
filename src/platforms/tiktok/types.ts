
export interface Mp4Meta {
    width: number
    height: number
    durationSec: number
}

export interface DownloadedVideo {
    bytes: ArrayBuffer
    mime: string
    name: string
    meta: Mp4Meta
}

export interface UploadResult {
    ok: boolean
    status?: number
    bodySnippet?: string
    error?: string
}

export interface BridgeResult {
    ok: boolean
    size?: number
    meta?: Mp4Meta
    error?: string
    uploadResult?: UploadResult
}

