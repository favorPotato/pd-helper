export interface LogFrame {
    v: 1
    type: 'meta' | 'progress' | 'result' | 'error' | 'cancelled' | 'heartbeat'
    taskId: string
    seq: number
    ts: number
    data: Record<string, unknown>
}

export function emit(frame: LogFrame): void {
    process.stdout.write(JSON.stringify(frame) + '\n')
}

export function emitSynthetic(taskId: string, type: LogFrame['type'], data: Record<string, unknown>): void {
    emit({v: 1, type, taskId, seq: -1, ts: Date.now(), data})
}

export function ttyLog(line: string): void {
    if (process.stderr.isTTY) {
        process.stderr.write(line + '\n')
    }
}
