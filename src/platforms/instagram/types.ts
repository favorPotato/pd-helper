export interface CleanedMedia {
    id: string
    shortcode: string
    type: 'video' | 'image'
    media_url: string | null
    taken_at: number | null
    caption: string
    accessibility_caption: string
    like_count: number
    comment_count: number
    view_count: number | null
    comments_disabled: boolean
    counts_hidden: boolean
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
    }
}

export interface CleanedComment {
    id: string
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
