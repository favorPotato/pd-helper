// cli-bridge —— CS 端 fire-and-forget 通用 runner
// 由各平台 remote handler 复用：自动起心跳、监听 pd:cancel、推 pd:done、按需推 pd:log

export interface CsRuntime {
    readonly taskId: string
    isCancelled(): boolean
    log(message: string): void
    pushLog(data: Record<string, unknown>): void
    throwIfCancelled(): void
}

export type CsTask<R> = (rt: CsRuntime) => Promise<R>

const HEARTBEAT_INTERVAL_MS = 10_000

const cancelFlags = new Map<string, boolean>()
let cancelListenerInstalled = false

function ensureCancelListener(): void {
    if (cancelListenerInstalled) return
    cancelListenerInstalled = true
    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return
        if ((msg as {type?: unknown}).type !== 'pd:cancel') return
        const taskId = (msg as {taskId?: unknown}).taskId
        if (typeof taskId === 'string' && cancelFlags.has(taskId)) {
            cancelFlags.set(taskId, true)
        }
    })
}

function send(message: object): void {
    try {
        const p = chrome.runtime.sendMessage(message) as unknown
        if (p && typeof (p as Promise<unknown>).catch === 'function') {
            ;(p as Promise<unknown>).catch(() => { /* SW 可能挂起；忽略 */ })
        }
    } catch { /* SW 不可达；忽略 */ }
}

interface WithPdCode {
    pdCode?: string
}

export class CancelledError extends Error implements WithPdCode {
    public readonly pdCode = 'CANCELLED'
    constructor(message = 'cancelled by user') {
        super(message)
        this.name = 'CancelledError'
    }
}

// 业务可在异常上挂 pdCode 让 runFireAndForget 透传到 pd:done.error.code
export function withPdCode<E extends Error>(error: E, code: string): E {
    ;(error as E & WithPdCode).pdCode = code
    return error
}

function readPdCode(error: unknown): string | undefined {
    if (!(error instanceof Error)) return undefined
    const code = (error as Error & WithPdCode).pdCode
    return typeof code === 'string' ? code : undefined
}

/**
 * 在 CS 内以 fire-and-forget 模式跑一个任务。
 * - taskId：与 SW 端 dispatch 同步的 task UUID
 * - task：业务逻辑；通过 rt.log/pushLog 推进度，throwIfCancelled 主动响应取消
 * 返回时已自动推 pd:done（不抛错）；调用方无需 await（但 await 也无副作用）
 */
export function runFireAndForget<R>(taskId: string, task: CsTask<R>): Promise<void> {
    ensureCancelListener()
    cancelFlags.set(taskId, false)

    let seq = 0
    const log = (message: string): void => {
        seq += 1
        send({type: 'pd:log', taskId, seq, data: {message: String(message)}})
    }
    const pushLog = (data: Record<string, unknown>): void => {
        seq += 1
        send({type: 'pd:log', taskId, seq, data})
    }
    const heartbeat = (): void => {
        send({type: 'pd:heartbeat', taskId})
    }
    const timer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS)

    const rt: CsRuntime = {
        taskId,
        isCancelled: () => !!cancelFlags.get(taskId),
        log,
        pushLog,
        throwIfCancelled: () => {
            if (cancelFlags.get(taskId)) throw new CancelledError()
        }
    }

    // 屏蔽 alert/confirm/prompt 防止业务函数阻塞 fire-and-forget 链路（CLI 视角下没人能点确认）
    const win = (typeof window !== 'undefined' ? window : undefined) as (Window & typeof globalThis) | undefined
    const origAlert = win?.alert
    const origConfirm = win?.confirm
    const origPrompt = win?.prompt
    if (win) {
        win.alert = ((m?: unknown) => { log(`[alert suppressed] ${String(m ?? '')}`) }) as typeof window.alert
        win.confirm = ((m?: unknown) => { log(`[confirm suppressed -> true] ${String(m ?? '')}`); return true }) as typeof window.confirm
        win.prompt = ((m?: unknown) => { log(`[prompt suppressed -> null] ${String(m ?? '')}`); return null }) as typeof window.prompt
    }

    return (async () => {
        try {
            const result = await task(rt)
            seq += 1
            if (cancelFlags.get(taskId)) {
                send({
                    type: 'pd:done', taskId, seq,
                    success: false,
                    error: {code: 'CANCELLED', message: 'cancelled by user'}
                })
            } else {
                send({type: 'pd:done', taskId, seq, success: true, result})
            }
        } catch (error) {
            const cancelled = !!cancelFlags.get(taskId) || error instanceof CancelledError
            const code = cancelled ? 'CANCELLED' : (readPdCode(error) ?? 'UNKNOWN_ERROR')
            const message = error instanceof Error ? error.message : String(error)
            seq += 1
            send({
                type: 'pd:done', taskId, seq,
                success: false,
                error: {code, message}
            })
        } finally {
            clearInterval(timer)
            cancelFlags.delete(taskId)
            if (win) {
                if (origAlert) win.alert = origAlert
                if (origConfirm) win.confirm = origConfirm
                if (origPrompt) win.prompt = origPrompt
            }
        }
    })()
}
