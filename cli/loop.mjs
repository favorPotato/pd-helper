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

export async function runCall(session, opts) {
    const callRes = await callPd(session, 'call', [opts.method, opts.params])
    const taskId = callRes.taskId
    ttyLog(`[pd-helper-cli] started taskId=${taskId} tabId=${callRes.tabId ?? 'n/a'}`)

    let lastSeq = 0
    let lastStatusAt = 0
    const startedAt = Date.now()
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
                emitSynthetic(taskId, 'error', {code: 'TIMEOUT', message: `exceeded ${opts.timeoutMs}ms`})
                return exitFor('TIMEOUT')
            }

            const tail = await call('tail', [taskId, lastSeq])

            // RingBuffer 溢出：buffer 最早帧 seq > lastSeq+1 表示老帧已被丢弃
            if (tail.firstSeq > 0 && tail.firstSeq > lastSeq + 1) {
                emitSynthetic(taskId, 'progress', {
                    kind: 'seq_skip',
                    expectedFrom: lastSeq + 1,
                    actualFirst: tail.firstSeq,
                    dropped: tail.firstSeq - lastSeq - 1
                })
            }

            for (const f of tail.logs) {
                emit(f)
                if (f.type === 'result') return 0
                if (f.type === 'cancelled') return exitFor('CANCELLED')
                if (f.type === 'error') {
                    const code = String(f.data.code || 'UNKNOWN_ERROR')
                    return exitFor(code)
                }
            }
            lastSeq = tail.nextSeq

            if (tail.hasMore) continue

            if (Date.now() - lastStatusAt > opts.statusIntervalMs) {
                try {
                    const status = await call('status', [taskId])
                    if ('error' in status) {
                        emitSynthetic(taskId, 'error', {code: 'TASK_LOST', message: status.error})
                        return exitFor('TASK_LOST')
                    }
                    emitSynthetic(taskId, 'progress', {kind: 'status', ...status})
                    // SW 重启后 orphaned 任务永远不会产帧，只能由 status 判退
                    if (TERMINAL_STATUS.has(status.status)) {
                        if (status.status === 'orphaned') {
                            emitSynthetic(taskId, 'error', {code: 'TASK_LOST', message: 'task became orphaned (SW restarted, buffer lost)'})
                            return exitFor('TASK_LOST')
                        }
                        // tail 未收到终态帧（可能 buffer 溢出），用 status 兜底退出
                        emitSynthetic(taskId, 'progress', {kind: 'terminal_without_frame', status: status.status})
                        if (status.status === 'cancelled') return exitFor('CANCELLED')
                        if (status.status === 'error') return exitFor(status.errorCode || 'UNKNOWN_ERROR')
                        return 0
                    }
                } catch (e) {
                    if (e instanceof CdpError) {
                        emitSynthetic(taskId, 'error', {code: e.code, message: e.message})
                        return exitFor(e.code)
                    }
                    throw e
                }
                lastStatusAt = Date.now()
            }

            await sleep(opts.pollIntervalMs)
        }
    } catch (e) {
        const code = e instanceof CdpError ? e.code : 'UNKNOWN_ERROR'
        const msg = e instanceof Error ? e.message : String(e)
        emitSynthetic(taskId, 'error', {code, message: msg})
        return exitFor(code)
    } finally {
        process.off('SIGINT', onSigint)
        process.off('SIGTERM', onSigint)
    }
}
