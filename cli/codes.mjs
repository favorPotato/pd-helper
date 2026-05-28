const CODE_EXIT = {
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
    RUNTIME_TAB_ERROR: 16,
    CANCELLED: 130
}

export function exitFor(code) {
    const c = CODE_EXIT[code]
    return typeof c === 'number' ? c : 1
}

export const KNOWN_CODES = new Set(Object.keys(CODE_EXIT))

// SW 端用 PdError 抛 `[CODE] message` 格式；优先解析前缀，否则退回字符串匹配
const PD_CODE_RE = /\[([A-Z_]+)]/

export function classifyEvalError(desc) {
    const m = desc.match(PD_CODE_RE)
    if (m && KNOWN_CODES.has(m[1])) return m[1]
    return 'UNKNOWN_ERROR'
}
