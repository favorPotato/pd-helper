declare const __SCRIPT_API_BASE__: string
declare const __SCRIPT_API_KEY__: string
declare const __MEDIA_PROMPT__: string
declare const __TIKTOK_MIN_PLAY_COUNT__: string
declare const __TIKTOK_MIN_LIKE_RATE__: string
declare const __TIKTOK_MAX_VIDEO_DURATION__: string
declare const __TIKTOK_MIN_COMMENT_COUNT__: string

function normalizeBaseUrl(value: string): string {
    return value.replace(/\/+$/, '')
}

function readInt(name: string, value: string): number {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed)) {
        throw new Error(`${name} 必须是整数`)
    }
    return parsed
}

function readRate(name: string, value: string): number {
    const parsed = Number.parseFloat(value)
    if (!Number.isFinite(parsed)) {
        throw new Error(`${name} 必须是数字`)
    }
    return parsed > 1 ? parsed / 100 : parsed
}

export const SCRIPT_API_BASE = normalizeBaseUrl(__SCRIPT_API_BASE__)
export const SCRIPT_API_KEY = __SCRIPT_API_KEY__.trim()
export const MEDIA_PROMPT = __MEDIA_PROMPT__
export const TIKTOK_MIN_PLAY_COUNT = readInt('TIKTOK_MIN_PLAY_COUNT', __TIKTOK_MIN_PLAY_COUNT__)
export const TIKTOK_MIN_LIKE_RATE = readRate('TIKTOK_MIN_LIKE_RATE', __TIKTOK_MIN_LIKE_RATE__)
export const TIKTOK_MAX_VIDEO_DURATION = readInt('TIKTOK_MAX_VIDEO_DURATION', __TIKTOK_MAX_VIDEO_DURATION__)
export const TIKTOK_MIN_COMMENT_COUNT = readInt('TIKTOK_MIN_COMMENT_COUNT', __TIKTOK_MIN_COMMENT_COUNT__)
