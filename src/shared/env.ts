declare const __SCRIPT_API_BASE__: string
declare const __SCRIPT_API_KEY__: string
declare const __MEDIA_PROMPT__: string
declare const __TIKTOK_MIN_PLAY_COUNT__: string
declare const __TIKTOK_MIN_COMMENT_COUNT__: string
declare const __APPS_SCRIPT_URL__: string
declare const __APPS_SCRIPT_TOKEN__: string

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

export const SCRIPT_API_BASE = normalizeBaseUrl(__SCRIPT_API_BASE__)
export const SCRIPT_API_KEY = __SCRIPT_API_KEY__.trim()
export const MEDIA_PROMPT = __MEDIA_PROMPT__
export const TIKTOK_MIN_PLAY_COUNT = readInt('TIKTOK_MIN_PLAY_COUNT', __TIKTOK_MIN_PLAY_COUNT__)
export const TIKTOK_MIN_COMMENT_COUNT = readInt('TIKTOK_MIN_COMMENT_COUNT', __TIKTOK_MIN_COMMENT_COUNT__)
export const APPS_SCRIPT_URL = __APPS_SCRIPT_URL__.trim()
export const APPS_SCRIPT_TOKEN = __APPS_SCRIPT_TOKEN__.trim()
