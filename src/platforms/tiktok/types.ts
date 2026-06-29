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

export interface TikTokUser {
    userId: string
    secUid: string
    username: string
    nickname: string
    signature: string
    avatarUrl: string
    verified: boolean
    privateAccount: boolean
    secret: boolean
    language: string
    signupAt: number
    followerCount: number
    followingCount: number
    heartCount: number
    videoCount: number
    diggCount: number
    friendCount: number
}

export interface TikTokCommentUser {
    userId: string
    secUid: string
    username: string
    nickname: string
}

export interface TikTokComment {
    commentId: string
    text: string
    language: string
    createAt: number
    diggCount: number
    replyCount: number
    authorLiked: boolean
    isTop: boolean
    user: TikTokCommentUser
}

export interface TikTokCommentSummary {
    total: number
    fetched: number
    hasMore: boolean
    cursor: number
    hasFilteredComments: boolean
}

export type TikTokUserListType = 'followers' | 'following'

export interface TikTokListUser {
    id: string
    uniqueId: string
    secUid: string
    nickname: string
    signature: string
    avatarMedium: string
    verified: boolean
    privateAccount: boolean
    secret: boolean
    ttSeller: boolean
    relation: number
    followerCount: number
    followingCount: number
    heartCount: number
    videoCount: number
    diggCount: number
    friendCount: number
}

export interface TikTokUserListResult {
    users: TikTokListUser[]
    total: number
    count: number
    hasMore: boolean
    truncatedByMaxCount: boolean
    apiTruncated: boolean
    listType: TikTokUserListType
}

export interface TikTokVideo {
    videoId: string
    desc: string
    createAt: number
    videoDuration: number
    videoUrl: string
    hashtags: string[]
    playCount: number
    diggCount: number
    commentCount: number
    shareCount: number
    collectCount: number
    repostCount: number
    privateItem: boolean
    secret: boolean
    commentSummary: TikTokCommentSummary
    comments: TikTokComment[]
}

export interface TikTokProfileCollection {
    user: TikTokUser
    videos: TikTokVideo[]
}
