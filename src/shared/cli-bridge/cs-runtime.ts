
export interface CsRuntime {
    readonly taskId: string
    isCancelled(): boolean
    log(message: string): void
    pushLog(data: Record<string, unknown>): void
    throwIfCancelled(): void
    // 可选挂起点：暂停态时轮询等待恢复（浮窗链路实现，CLI 链路不提供=不挂起）。
    // 与 throwIfCancelled（取消=抛错中止）正交：暂停=挂起等待，不取消已采。
    waitWhilePaused?(): Promise<void>
}

export type CsTask<R> = (rt: CsRuntime) => Promise<R>

export interface RunFireAndForgetOptions {
    onLog?(message: string): void
}

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

// 在异常上挂 pdCode，runFireAndForget 会将其透传到 pd:done.error.code
export function withPdCode<E extends Error>(error: E, code: string): E {
    ;(error as E & WithPdCode).pdCode = code
    return error
}

function readPdCode(error: unknown): string | undefined {
    if (!(error instanceof Error)) return undefined
    const code = (error as Error & WithPdCode).pdCode
    return typeof code === 'string' ? code : undefined
}

// 返回时已自动推 pd:done（不抛错），调用方无需 await
export function runFireAndForget<R>(taskId: string, task: CsTask<R>, options: RunFireAndForgetOptions = {}): Promise<void> {
    ensureCancelListener()
    cancelFlags.set(taskId, false)

    let seq = 0
    const log = (message: string): void => {
        options.onLog?.(String(message))
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

    // CLI 无人交互，屏蔽 alert/confirm/prompt 防止阻塞
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
