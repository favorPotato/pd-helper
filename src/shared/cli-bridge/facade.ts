
import {delay} from '../timing'
import {RingBuffer} from './ring-buffer'
import {clearMeta, loadAllMeta, persistMeta} from './persistence'
import {registerBusinessDispatchers} from './business-dispatchers'
import type {
    DispatchContext,
    DispatchFn,
    FrameType,
    LogFrame,
    PdFacade,
    StatusSnapshot,
    TaskMeta,
    TaskStatus
} from './types'

const BUFFER_CAPACITY = 1000
const TAIL_MAX_FRAMES = 100
const TAIL_MAX_BYTES = 50 * 1024
const FRAME_MAX_BYTES = 500
const ALIVE_WINDOW_MS = 60_000
const TERMINAL_GC_MS = 5 * 60_000
const TAB_ID_WAIT_MS = 1000

type TerminalStatus = 'done' | 'error' | 'cancelled'
const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'error', 'cancelled', 'orphaned'])

interface TaskRuntime {
    meta: TaskMeta
    buffer: RingBuffer<LogFrame>
    cancelled: boolean
    resolveTabId?: (id: number | null) => void
}

const tasks = new Map<string, TaskRuntime>()
const dispatchTable = new Map<string, DispatchFn>()

const utf8 = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

function byteLen(s: string): number {
    if (utf8) return utf8.encode(s).length
    let n = 0
    for (let i = 0; i < s.length; i += 1) n += s.charCodeAt(i) < 128 ? 1 : 3
    return n
}

function genTaskId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
    }
    return 'task_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// buffer 是 seq 的唯一来源，meta.lastSeq 由此同步
function nextSeq(t: TaskRuntime): number {
    const next = t.buffer.lastSeq() + 1
    t.meta.lastSeq = next
    return next
}

function truncateData(data: Record<string, unknown>): Record<string, unknown> {
    let out: Record<string, unknown> | null = null
    for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string' && byteLen(v) > FRAME_MAX_BYTES) {
            out = out || {...data}
            let s = v.slice(0, FRAME_MAX_BYTES)
            while (byteLen(s) > FRAME_MAX_BYTES) s = s.slice(0, -1)
            out[k] = s + '…trunc'
        }
    }
    return out || data
}

function pushLog(taskId: string, type: FrameType, data: Record<string, unknown>): void {
    const t = tasks.get(taskId)
    if (!t) return

    let payload = truncateData(data)
    let frame: LogFrame = {
        v: 1,
        type,
        taskId,
        seq: nextSeq(t),
        ts: Date.now(),
        data: payload
    }

    if (byteLen(JSON.stringify(frame)) > FRAME_MAX_BYTES * 4) {
        payload = {__truncated: true, originalKeys: Object.keys(data)}
        frame = {...frame, data: payload}
    }

    t.buffer.push(frame)
    t.meta.lastActivityAt = Date.now()
}

function finalizeTask(taskId: string, status: TerminalStatus, frameType: FrameType, frameData: Record<string, unknown>): void {
    const t = tasks.get(taskId)
    if (!t) return
    if (TERMINAL.has(t.meta.status)) return  // 幂等

    t.meta.status = status
    if (status === 'done') {
        t.meta.result = frameData.result ?? frameData
    } else if (status === 'error') {
        t.meta.error = {
            code: String(frameData.code || 'UNKNOWN_ERROR'),
            message: String(frameData.message || '')
        }
    }
    pushLog(taskId, frameType, frameData)
    void persistMeta(t.meta)
    scheduleGc(taskId)
}

function scheduleGc(taskId: string): void {
    setTimeout(() => {
        const t = tasks.get(taskId)
        if (!t || !TERMINAL.has(t.meta.status)) return
        tasks.delete(taskId)
        void clearMeta(taskId)
    }, TERMINAL_GC_MS)
}

export function ingestRemoteLog(taskId: string, type: FrameType, data: Record<string, unknown>): void {
    pushLog(taskId, type, data)
}

export function ingestHeartbeat(taskId: string): void {
    const t = tasks.get(taskId)
    if (!t) return
    t.meta.lastActivityAt = Date.now()
    void persistMeta(t.meta, {throttle: true})
}

export function markTaskDone(taskId: string, success: boolean, payload: Record<string, unknown>): void {
    if (success) {
        finalizeTask(taskId, 'done', 'result', payload)
    } else {
        finalizeTask(taskId, 'error', 'error', payload)
    }
}

function buildContext(t: TaskRuntime): DispatchContext {
    const taskId = t.meta.taskId
    return {
        taskId,
        pushLog: (type, data) => pushLog(taskId, type, data),
        markPhase: (phase) => {
            t.meta.phase = phase
            if (t.meta.status === 'starting') t.meta.status = 'running'
        },
        markProgress: (done, total) => {
            t.meta.done = done
            if (total !== undefined) t.meta.total = total
        },
        setTabId: (id) => {
            if (t.meta.tabId === null) t.meta.tabId = id
            if (t.resolveTabId) {
                t.resolveTabId(id)
                t.resolveTabId = undefined
            }
        },
        finish: (result) => finalizeTask(taskId, 'done', 'result', {result}),
        fail: (code, message) => finalizeTask(taskId, 'error', 'error', {code, message}),
        isCancelled: () => t.cancelled
    }
}

const builtinCsTest: DispatchFn = async (params, ctx) => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query || !chrome.tabs?.sendMessage) {
        ctx.setTabId(null)
        ctx.fail('UNKNOWN_ERROR', 'chrome.tabs API not available')
        return
    }
    ctx.markPhase('locating_cs_tab')
    const candidates = await chrome.tabs.query({url: ['*://*.tiktok.com/*', '*://*.instagram.com/*', '*://*.noxinfluencer.com/*']})
    const tab = candidates[0]
    if (!tab?.id) {
        ctx.setTabId(null)
        ctx.fail('TAB_CLOSED', '未找到 pd-helper CS 注入的 tab')
        return
    }
    ctx.setTabId(tab.id)
    ctx.markPhase('messaging_cs')
    const count = paramNumber(params.count, 3, 1, 5)
    try {
        const ack = await chrome.tabs.sendMessage(tab.id, {type: 'pd:csTest', taskId: ctx.taskId, count})
        ctx.pushLog('progress', {message: `cs acked: ${JSON.stringify(ack)}`})
    } catch (e) {
        ctx.fail('UNKNOWN_ERROR', `cs sendMessage failed: ${e instanceof Error ? e.message : String(e)}`)
        return
    }
}

const builtinPing: DispatchFn = async (params, ctx) => {
    ctx.setTabId(null)
    const count = paramNumber(params.count, 3, 1, 20)
    const intervalMs = paramNumber(params.interval, 500, 100, 5000)

    ctx.markPhase('pinging')
    ctx.markProgress(0, count)
    for (let i = 1; i <= count; i += 1) {
        if (ctx.isCancelled()) {
            ctx.pushLog('cancelled', {reason: 'user_cancelled', at: i})
            return
        }
        await delay(intervalMs)
        ctx.pushLog('progress', {message: `ping ${i}/${count}`})
        ctx.markProgress(i, count)
    }
    ctx.finish({echo: params, count, ts: Date.now()})
}

// 保留 0 作为合法值（避免 falsy-zero 陷阱），undefined/null/'' 才回落默认
function paramNumber(raw: unknown, fallback: number, lo: number, hi: number): number {
    const n = raw === undefined || raw === null || raw === '' ? fallback : Number(raw)
    const v = Number.isFinite(n) ? n : fallback
    return Math.max(lo, Math.min(hi, v))
}

class PdError extends Error {
    constructor(public code: string, message: string) {
        super(`[${code}] ${message}`)
    }
}

function createFacade(): PdFacade {
    return {
        async call(method, params) {
            const fn = dispatchTable.get(method)
            if (!fn) throw new PdError('INVALID_PARAM', `unknown_method: ${method}`)

            const taskId = genTaskId()
            const meta: TaskMeta = {
                taskId,
                method,
                params: params || {},
                tabId: null,
                status: 'starting',
                startedAt: Date.now(),
                lastActivityAt: Date.now(),
                lastSeq: 0,
                phase: 'starting',
                done: 0,
                total: null,
                errors: 0
            }
            const t: TaskRuntime = {meta, buffer: new RingBuffer<LogFrame>(BUFFER_CAPACITY), cancelled: false}
            tasks.set(taskId, t)
            pushLog(taskId, 'meta', {method, params})
            void persistMeta(meta)

            // tabId race：等 dispatch 首次 setTabId 或结束（1s 上限）后再返回
            let tabIdResolved = false
            const tabIdReady = new Promise<number | null>((resolve) => {
                t.resolveTabId = (id) => {
                    if (tabIdResolved) return
                    tabIdResolved = true
                    resolve(id)
                }
            })

            // fire-and-forget：若 dispatch 未调 finish/fail，状态留 running，CLI 通过 isAlive 探测
            void (async () => {
                try {
                    // probe 模式（__probe=true）：不执行业务，只验证 method 已注册，零副作用
                    if (params && (params as Record<string, unknown>).__probe === true) {
                        const ctx = buildContext(t)
                        ctx.setTabId(null)
                        ctx.markPhase('probe')
                        ctx.pushLog('progress', {message: `probe ok: method='${method}' is registered & callable`})
                        ctx.finish({probe: true, method, paramsEcho: params})
                        return
                    }
                    await fn(params || {}, buildContext(t))
                    if (meta.status === 'starting') meta.status = 'running'
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    const code = e instanceof PdError ? e.code : 'UNKNOWN_ERROR'
                    finalizeTask(taskId, 'error', 'error', {code, message: msg})
                } finally {
                    if (t.resolveTabId) {
                        t.resolveTabId(meta.tabId)
                        t.resolveTabId = undefined
                    }
                }
            })()

            const tabId = await Promise.race([
                tabIdReady,
                delay(TAB_ID_WAIT_MS).then(() => meta.tabId)
            ])
            return {taskId, tabId}
        },

        async tail(taskId, sinceSeq) {
            const t = tasks.get(taskId)
            if (!t) return {logs: [], hasMore: false, nextSeq: sinceSeq, firstSeq: 0}
            const all = t.buffer.sliceAfter(sinceSeq)
            const out: LogFrame[] = []
            let bytes = 0
            for (const f of all) {
                if (out.length >= TAIL_MAX_FRAMES) break
                const size = byteLen(JSON.stringify(f))
                if (bytes + size > TAIL_MAX_BYTES && out.length > 0) break
                out.push(f)
                bytes += size
            }
            const hasMore = out.length < all.length
            const nextSeq = out.length ? out[out.length - 1].seq : sinceSeq
            return {logs: out, hasMore, nextSeq, firstSeq: t.buffer.firstSeq()}
        },

        async status(taskId) {
            const t = tasks.get(taskId)
            if (!t) return {error: 'not_found'}
            const lastProgress = t.buffer.findLast(f => f.type === 'progress')
            let lastLog = ''
            if (lastProgress) {
                const m = (lastProgress.data as {message?: unknown}).message
                if (typeof m === 'string') lastLog = m.slice(0, 100)
            }
            if (!lastLog && t.buffer.size() > 0) {
                lastLog = `[${t.meta.status}]`
            }
            const snap: StatusSnapshot = {
                status: t.meta.status,
                phase: t.meta.phase || '',
                done: t.meta.done || 0,
                total: t.meta.total ?? null,
                errors: t.meta.errors || 0,
                etaSeconds: null,
                isAlive: Date.now() - t.meta.lastActivityAt < ALIVE_WINDOW_MS,
                lastLog,
                lastSeq: t.meta.lastSeq
            }
            return snap
        },

        async cancel(taskId) {
            const t = tasks.get(taskId)
            if (!t) return {ok: false}
            if (t.cancelled || TERMINAL.has(t.meta.status)) return {ok: true}
            t.cancelled = true
            finalizeTask(taskId, 'cancelled', 'cancelled', {reason: 'user_cancelled'})
            if (t.meta.tabId != null && typeof chrome !== 'undefined' && chrome.tabs?.sendMessage) {
                try {
                    await chrome.tabs.sendMessage(t.meta.tabId, {type: 'pd:cancel', taskId})
                } catch {
                    // CS 可能已退出，忽略
                }
            }
            return {ok: true}
        },

        async listTasks(opts) {
            const includeAll = !!opts?.all
            const out: TaskMeta[] = []
            for (const t of tasks.values()) {
                if (!includeAll && TERMINAL.has(t.meta.status)) continue
                out.push(t.meta)
            }
            return out
        },

        methods() {
            return Array.from(dispatchTable.keys()).sort()
        },

        register(method, fn) {
            dispatchTable.set(method, fn)
        }
    }
}

export function installPdFacade(): PdFacade {
    if (globalThis.__pd) return globalThis.__pd
    const facade = createFacade()
    facade.register('ping', builtinPing)
    facade.register('csTest', builtinCsTest)
    registerBusinessDispatchers(facade)
    globalThis.__pd = facade

    void (async () => {
        const persisted = await loadAllMeta()
        for (const meta of persisted) {
            if (tasks.has(meta.taskId)) continue
            const m: TaskMeta = {...meta}
            if (m.status === 'running' || m.status === 'starting') {
                m.status = 'orphaned'
            }
            const t: TaskRuntime = {meta: m, buffer: new RingBuffer<LogFrame>(BUFFER_CAPACITY), cancelled: false}
            tasks.set(m.taskId, t)
            if (TERMINAL.has(m.status)) {
                void clearMeta(m.taskId)
                scheduleGc(m.taskId)
            }
        }
    })()

    return facade
}
