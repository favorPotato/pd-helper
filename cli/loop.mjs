import {callPd} from './rpc.mjs'
import {CdpError} from './transport.mjs'
import {reconnectSession} from './attach.mjs'
import {emit, emitSynthetic, ttyLog, sleep} from './io.mjs'
import {exitFor} from './codes.mjs'

const TERMINAL_STATUS = new Set(['done', 'cancelled', 'error', 'orphaned'])

async function tryReconnect(session) {
    for (let i = 0; i < 3; i += 1) {
        const wait = 500 * (1 << i)
        ttyLog(`[pd-helper-cli] WS closed, reconnect attempt ${i + 1}/3 after ${wait}ms`)
        await sleep(wait)
        try {
            await reconnectSession(session)
            ttyLog(`[pd-helper-cli] reconnected (via=${session.via})`)
            return true
        } catch (e) {
            ttyLog(`[pd-helper-cli] reconnect failed: ${e.message}`)
        }
    }
    return false
}

async function ensureTaskAlive(session, taskId) {
    try {
        const list = await callPd(session, 'listTasks', [{all: true}])
        return list.some(t => t.taskId === taskId)
    } catch {
        return false
    }
}

// 共享轮询骨架：runCall（emit 流 + exit code）与 runCallAndCollect（return 业务数据 / throw）的唯一真源。
// 行为差异全由 handlers 注入，杜绝两份拷贝漂移：
//   onFrame(f) -> {done:true, value} 表示遇终态帧需结束循环并以 value 收尾；返回 falsy 继续吞帧。
//   onTerminal(kind, info) -> 必须 return 一个结束值或 throw；kind ∈
//     'timeout' | 'task_lost'(info.message) | 'status_terminal'(info.status/errorCode) | 'reconnect_failed'(info.code/message)。
//   onSeqSkip(info)（可选）：RingBuffer 溢出丢帧告警；info={expectedFrom,actualFirst,dropped}。
//   onLoopError(e)（可选）：循环体抛出非预期错误时的收尾（runCall 转 emit+exit；collect 直接 rethrow）。
// 三项硬能力（SIGINT→cancel、seq_skip 检测、3 次指数退避重连）一律内建，两个调用方共享。
async function pollTask(session, opts, handlers) {
    const callRes = await callPd(session, 'call', [opts.method, opts.params])
    const taskId = callRes.taskId
    ttyLog(`[pd-helper-cli] started taskId=${taskId} tabId=${callRes.tabId ?? 'n/a'}`)

    let lastSeq = 0
    let lastStatusAt = 0
    const startedAt = Date.now()
    const pollIntervalMs = opts.pollIntervalMs || 2000
    const statusIntervalMs = opts.statusIntervalMs || 30000
    let cancelSent = false

    const onSigint = async () => {
        if (cancelSent) {
            ttyLog('[pd-helper-cli] second SIGINT, force exit')
            process.exit(130)
        }
        cancelSent = true
        ttyLog('[pd-helper-cli] SIGINT → cancel')
        try { await call('cancel', [taskId]) } catch { /* ignore */ }
        // unref：收到 cancelled 帧后进程正常退出；仅卡住时 6s 兜底强退
        setTimeout(() => process.exit(130), 6000).unref()
    }
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigint)

    async function call(method, args) {
        try {
            return await callPd(session, method, args)
        } catch (e) {
            if (!(e instanceof CdpError)) throw e
            if (e.code !== 'CDP_DISCONNECTED') throw e
            if (!await tryReconnect(session)) throw e
            if (!await ensureTaskAlive(session, taskId)) {
                throw new CdpError('TASK_LOST', `task ${taskId} not found after reconnect`)
            }
            return await callPd(session, method, args)
        }
    }

    try {
        while (true) {
            if (Date.now() - startedAt > opts.timeoutMs) {
                try { await call('cancel', [taskId]) } catch { /* ignore */ }
                return handlers.onTerminal('timeout', {taskId, timeoutMs: opts.timeoutMs})
            }

            const tail = await call('tail', [taskId, lastSeq])

            // RingBuffer 溢出：buffer 最早帧 seq > lastSeq+1 表示老帧已被丢弃
            if (tail.firstSeq > 0 && tail.firstSeq > lastSeq + 1 && handlers.onSeqSkip) {
                handlers.onSeqSkip({
                    taskId,
                    expectedFrom: lastSeq + 1,
                    actualFirst: tail.firstSeq,
                    dropped: tail.firstSeq - lastSeq - 1
                })
            }

            for (const f of tail.logs) {
                const r = handlers.onFrame(f, taskId)
                if (r && r.done) { lastSeq = tail.nextSeq; return r.value }
            }
            lastSeq = tail.nextSeq

            if (tail.hasMore) continue

            if (Date.now() - lastStatusAt > statusIntervalMs) {
                try {
                    const status = await call('status', [taskId])
                    if ('error' in status) return handlers.onTerminal('task_lost', {taskId, message: status.error})
                    handlers.onStatus && handlers.onStatus(status, taskId)
                    // SW 重启后 orphaned 任务永远不会产帧，只能由 status 判退
                    if (TERMINAL_STATUS.has(status.status)) {
                        // done 但本轮 tail 未见 result 帧——多为「瞬时 done」竞态：CS 秒回（如候选 0 返 {detailed:0}），
                        // node 在 tail 取到 result 帧前就轮到 status 检查（首轮 lastStatusAt=0 尤甚）。SW 侧 finalizeTask
                        // 把 result 帧与 done 态同步入 buffer，故 done 后补一次 tail 必能取到迟到 result。
                        if (status.status === 'done') {
                            const finalTail = await call('tail', [taskId, lastSeq])
                            if (finalTail.firstSeq > 0 && finalTail.firstSeq > lastSeq + 1 && handlers.onSeqSkip) {
                                handlers.onSeqSkip({
                                    taskId,
                                    expectedFrom: lastSeq + 1,
                                    actualFirst: finalTail.firstSeq,
                                    dropped: finalTail.firstSeq - lastSeq - 1
                                })
                            }
                            for (const f of finalTail.logs) {
                                const r = handlers.onFrame(f, taskId)
                                if (r && r.done) { lastSeq = finalTail.nextSeq; return r.value }
                            }
                            lastSeq = finalTail.nextSeq
                        }
                        return handlers.onTerminal('status_terminal', {
                            taskId, status: status.status, errorCode: status.errorCode
                        })
                    }
                } catch (e) {
                    if (e instanceof CdpError) return handlers.onTerminal('reconnect_failed', {taskId, code: e.code, message: e.message})
                    throw e
                }
                lastStatusAt = Date.now()
            }

            await sleep(pollIntervalMs)
        }
    } catch (e) {
        if (handlers.onLoopError) return handlers.onLoopError(e, taskId)
        throw e
    } finally {
        process.off('SIGINT', onSigint)
        process.off('SIGTERM', onSigint)
    }
}

// 流式监控：每帧 emit，遇终态以 exit code 收尾。供 main.mjs 的 run 命令使用。
export async function runCall(session, opts) {
    return await pollTask(session, opts, {
        onSeqSkip: (info) => emitSynthetic(info.taskId, 'progress', {
            kind: 'seq_skip',
            expectedFrom: info.expectedFrom,
            actualFirst: info.actualFirst,
            dropped: info.dropped
        }),
        onFrame: (f) => {
            emit(f)
            if (f.type === 'result') return {done: true, value: 0}
            if (f.type === 'cancelled') return {done: true, value: exitFor('CANCELLED')}
            if (f.type === 'error') return {done: true, value: exitFor(String(f.data.code || 'UNKNOWN_ERROR'))}
            return null
        },
        onStatus: (status, taskId) => emitSynthetic(taskId, 'progress', {kind: 'status', ...status}),
        onTerminal: (kind, info) => {
            if (kind === 'timeout') {
                emitSynthetic(info.taskId, 'error', {code: 'TIMEOUT', message: `exceeded ${info.timeoutMs}ms`})
                return exitFor('TIMEOUT')
            }
            if (kind === 'task_lost') {
                emitSynthetic(info.taskId, 'error', {code: 'TASK_LOST', message: info.message})
                return exitFor('TASK_LOST')
            }
            if (kind === 'reconnect_failed') {
                emitSynthetic(info.taskId, 'error', {code: info.code, message: info.message})
                return exitFor(info.code)
            }
            // status_terminal
            if (info.status === 'orphaned') {
                emitSynthetic(info.taskId, 'error', {code: 'TASK_LOST', message: 'task became orphaned (SW restarted, buffer lost)'})
                return exitFor('TASK_LOST')
            }
            // tail 未收到终态帧（可能 buffer 溢出 / 瞬时 done 补 tail 仍空），用 status 兜底退出
            emitSynthetic(info.taskId, 'progress', {kind: 'terminal_without_frame', status: info.status})
            if (info.status === 'cancelled') return exitFor('CANCELLED')
            if (info.status === 'error') return exitFor(info.errorCode || 'UNKNOWN_ERROR')
            return 0
        },
        onLoopError: (e, taskId) => {
            const code = e instanceof CdpError ? e.code : 'UNKNOWN_ERROR'
            const msg = e instanceof Error ? e.message : String(e)
            emitSynthetic(taskId, 'error', {code, message: msg})
            return exitFor(code)
        }
    })
}

// runCall 的「采集」变体：收到 result 帧 return 业务数据（落盘用），error/cancelled/timeout 一律抛 CdpError 由调用方归类。
// 复用 pollTask 共享骨架 → 自动获得 SIGINT→cancel、seq_skip 丢帧告警、3 次指数退避重连。
// result payload = {result: <CS 返回值>}（见 background.ts），故 f.data.result 即业务数据；?? f.data 兜底防 payload 形态变动。
// onProgress：流式进度帧回调（如 exolytDetail 边采边落）；仅 progress 帧、传了回调时触发，未传时零变化。
export async function runCallAndCollect(session, opts) {
    return await pollTask(session, opts, {
        onSeqSkip: (info) => {
            // 本变体用于流式落盘：丢帧=那 N 条 raw 静默不落盘，无法补回。至少告警让操作者重跑续采。
            ttyLog(`[pd-helper-cli] ⚠ RingBuffer 溢出丢帧：task=${info.taskId} 漏 seq ${info.expectedFrom}..${info.actualFirst - 1}（共 ${info.dropped} 帧），这些 raw 未落盘，请重跑续采补齐`)
        },
        onFrame: (f) => {
            if (f.type === 'result') return {done: true, value: f.data.result ?? f.data}
            if (f.type === 'cancelled') throw new CdpError('CANCELLED', `task ${f.taskId} cancelled`)
            if (f.type === 'error') {
                throw new CdpError(String(f.data.code || 'UNKNOWN_ERROR'), String(f.data.message || 'task error'))
            }
            if (opts.onProgress && f.type === 'progress' && f.data) opts.onProgress(f.data)
            return null
        },
        onTerminal: (kind, info) => {
            if (kind === 'timeout') throw new CdpError('TIMEOUT', `exceeded ${info.timeoutMs}ms`)
            if (kind === 'task_lost') throw new CdpError('TASK_LOST', String(info.message))
            if (kind === 'reconnect_failed') throw new CdpError(info.code, info.message)
            // status_terminal
            if (info.status === 'cancelled') throw new CdpError('CANCELLED', `task ${info.taskId} cancelled`)
            if (info.status === 'error') throw new CdpError(info.errorCode || 'UNKNOWN_ERROR', 'task error')
            if (info.status === 'orphaned') throw new CdpError('TASK_LOST', 'task became orphaned')
            // done 且补 tail 仍未取到 result 帧 → 真 buffer 溢出无 result
            throw new CdpError('TASK_LOST', 'task done without result frame')
        }
        // 无 onLoopError：非预期错误直接 rethrow，由调用方 try/catch 归类（保持原 runCallAndCollect 语义）
    })
}
