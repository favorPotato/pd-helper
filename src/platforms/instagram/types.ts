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
    comments_disabled: boolean
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
