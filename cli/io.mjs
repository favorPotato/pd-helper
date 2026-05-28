import {exitFor} from './codes.mjs'

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export function numFlag(value, fallback, min = undefined) {
    if (value === undefined || value === '') return fallback
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    if ((min !== undefined && n < min) || n > Number.MAX_SAFE_INTEGER) {
        console.error(`invalid numeric flag value: ${value}` + (min !== undefined ? ` (expected a number >= ${min})` : ''))
        process.exit(exitFor('INVALID_PARAM'))
    }
    return n
}

export function emit(frame) {
    process.stdout.write(JSON.stringify(frame) + '\n')
}

export function emitSynthetic(taskId, type, data) {
    emit({v: 1, type, taskId, seq: -1, ts: Date.now(), data})
}

export function ttyLog(line) {
    if (process.stderr.isTTY || process.env.PD_HELPER_DEBUG) {
        process.stderr.write(line + '\n')
    }
}
