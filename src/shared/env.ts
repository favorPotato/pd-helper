declare const __SCRIPT_API_BASE__: string
declare const __SCRIPT_API_KEY__: string
declare const __MEDIA_PROMPT__: string

function normalizeBaseUrl(value: string): string {
    return value.replace(/\/+$/, '')
}

export const SCRIPT_API_BASE = normalizeBaseUrl(__SCRIPT_API_BASE__)
export const SCRIPT_API_KEY = __SCRIPT_API_KEY__.trim()
export const MEDIA_PROMPT = __MEDIA_PROMPT__
