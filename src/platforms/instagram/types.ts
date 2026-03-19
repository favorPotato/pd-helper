export type MediaRouteKind = 'p' | 'reels'

export interface CleanedMedia {
    id: string
    shortcode: string
    media_type: 'post' | 'carousel' | 'reels'
    type: 'video' | 'image'
    media_url: string | null
    media_urls: string[] | null
    taken_at: number | null
    caption: string
    mentions: string[]
    hashtags: string[]
    is_collaboration: boolean
    collaborators: string[]
    is_carousel: boolean
    carousel_count: number | null
    accessibility_caption: string | null
    like_count: number
    comment_count: number
    view_count: number | null
    video_duration: number | null
    thumbnail_url: string | null
    music_id?: string | null
    music_title?: string | null
    music_artist?: string | null
    is_original_audio?: boolean | null
    comments_disabled: boolean | null
    counts_hidden: boolean
    like_and_view_counts_disabled: boolean
    location: {
        name: string
        lat: number | null
        lng: number | null
    } | null
    author: {
        id: string | null
        username: string | null
        full_name: string
        is_verified: boolean
        followers_count: number | null
        account_location: string | null
        joined_date: string | null
        bio: string | null
    }
}

export interface CleanedComment {
    comment_id?: string | null
    text: string
    created_at: number
    like_count: number
    reply_count: number
    author: {
        username: string | null
        is_verified: boolean
    }
}

export interface CommentsResult {
    comments: CleanedComment[]
    pagination: {
        has_next_page: boolean
        end_cursor: string | null
    }
}

export interface ReelsPageItem {
    id: string
    shortcode: string
}

export interface ReelsPageResult {
    items: ReelsPageItem[]
    pageInfo: {
        has_next_page: boolean
        end_cursor: string | null
    }
}

export interface AccountOutput {
    username: string
    full_name: string | null
    bio: string | null
    external_url: string[]
    followers_count: number | null
    following_count: number | null
    post_count: number | null
    is_verified: boolean | null
    is_business_account: boolean | null
    account_location?: string | null
    joined_date?: string | null
    profile_pic_url: string | null
}

export interface PostOutput {
    id?: string
    shortcode?: string
    taken_at?: number | null
    media_type?: 'reels' | 'image' | 'carousel'
    view_count?: number | null
    like_count?: number | null
    comment_count?: number | null
    video_duration?: number | null
    caption?: string | null
    hashtags?: string[]
    mentions?: string[]
    thumbnail_url?: string | null
    media_url?: string | null
    music_id?: string | null
    music_title?: string | null
    music_artist?: string | null
    is_original_audio?: boolean | null
    location?: string | null
    is_collaboration?: boolean
    comments_disabled?: boolean | null
    comments?: CommentOutput[]
    error?: string
}

export interface CommentOutput {
    comment_id?: string | null
    username: string | null
    text: string
    created_at: number
    like_count: number
}

export interface CollectorOutput {
    account: AccountOutput
    posts: PostOutput[]
    meta: {
        crawled_at: string
        total_posts: number
        has_incomplete: boolean
    }
}
