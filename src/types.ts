import type {CleanedComment, CleanedMedia} from './platforms/instagram/types'

export interface ApiConfig {
    url: string
    key: string
    model: string
    timeout: number
}

export interface DownloadMessage {
    action: 'download'
    url: string
    filename: string
}

export interface MediaAnalysis {
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
