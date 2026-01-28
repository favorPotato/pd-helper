export interface BitrateInfo {
    GearName: string
    Bitrate: number
    CodecType?: string
    PlayAddr?: {
        UrlList?: string[]
    }
}

export interface TikTokVideo {
    bitrateInfo?: BitrateInfo[]
    duration?: number
    width?: number
    height?: number
}

export interface TikTokAuthor {
    id: string
    uniqueId: string
    nickname: string
    avatarThumb?: string
    signature?: string
}

export interface TikTokItemStruct {
    id: string
    desc: string
    createTime?: number
    video?: TikTokVideo
    author?: TikTokAuthor
    stats?: {
        diggCount?: number
        shareCount?: number
        commentCount?: number
        playCount?: number
    }
}

export interface TikTokPageData {
    __DEFAULT_SCOPE__?: {
        'webapp.video-detail'?: {
            itemInfo?: {
                itemStruct?: TikTokItemStruct
            }
        }
    }
}

export interface VideoCandidate {
    index: string
    gearName: string
    resolution: string
    bitrate: number
    codec: string
    url: string
}

export interface CleanedTikTokMedia {
    id: string
    description: string
    created_at: number | null
    duration: number | null
    width: number | null
    height: number | null
    video_url: string | null
    stats: {
        digg_count: number
        share_count: number
        comment_count: number
        play_count: number
    }
    author: {
        id: string | null
        unique_id: string | null
        nickname: string
    } | null
}

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

export interface CacheStoreMessage {
    type: 'cache_store_whole'
    bytes: number[]
    mime: string
    name: string
    meta: Mp4Meta
}

export interface CacheGetMessage {
    type: 'cache_get_whole'
}

export interface CacheClearMessage {
    type: 'cache_clear'
}

export interface OpenIgAndUploadMessage {
    type: 'open_ig_and_upload'
    caption: string
}

export type BridgeMessage = CacheStoreMessage | CacheGetMessage | CacheClearMessage | OpenIgAndUploadMessage
