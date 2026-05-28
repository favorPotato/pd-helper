// 错误码 → exit code 映射，与 cli-extension-bridge.md §7.3 对齐
export const ERROR_EXIT: Record<string, number> = {
    UNKNOWN_ERROR: 1,
    LOGIN_REQUIRED: 2,
    RATE_LIMITED: 3,
    TAB_CLOSED: 4,
    INVALID_PARAM: 5,
    SW_DEAD: 10,
    CDP_DISCONNECTED: 11,
    TIMEOUT: 12,
    CHROME_NOT_FOUND: 13,
    TASK_LOST: 14,
    CAPTCHA: 15,
    CANCELLED: 130
}

export function exitFor(code: string): number {
    const c = ERROR_EXIT[code]
    return typeof c === 'number' ? c : 1
}
