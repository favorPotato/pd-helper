import type {CleanedComment, CleanedMedia, CommentsResult} from './platforms/instagram/types'

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

export interface Platform {
    name: string
    isMatch: (hostname: string) => boolean
    injectButton: () => void
    extract: () => Promise<ExtractResult>
}

export interface ExtractResult {
    media: CleanedMedia | null
    comments: CleanedComment[]
    pagination: CommentsResult['pagination']
    media_analysis: string
}
