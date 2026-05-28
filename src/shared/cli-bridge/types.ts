// 与 cli/ndjson.ts 中的 schema 保持一致

export type TaskStatus = 'starting' | 'running' | 'done' | 'cancelled' | 'error' | 'orphaned'

export type FrameType = 'meta' | 'progress' | 'result' | 'error' | 'cancelled' | 'heartbeat'

export interface LogFrame {
    v: 1
    type: FrameType
    taskId: string
    seq: number
    ts: number
    data: Record<string, unknown>
}

export interface TaskMeta {
    taskId: string
    method: string
    params: Record<string, unknown>
    tabId: number | null
    status: TaskStatus
    startedAt: number
    lastActivityAt: number
    lastSeq: number
    phase?: string
    done?: number
    total?: number | null
    errors?: number
    result?: unknown
    error?: { code: string; message: string }
}

export interface TailResult {
    logs: LogFrame[]
    hasMore: boolean
    nextSeq: number
    // RingBuffer 溢出丢老帧时，最早一帧的 seq；CLI 比对 sinceSeq 即可侦测跳号
    firstSeq: number
}

export interface StatusSnapshot {
    status: TaskStatus
    phase: string
    done: number
    total: number | null
    errors: number
    etaSeconds: number | null
    isAlive: boolean
    lastLog: string
    lastSeq: number
}

export interface DispatchContext {
    taskId: string
    pushLog: (type: FrameType, data: Record<string, unknown>) => void
    markPhase: (phase: string) => void
    markProgress: (done: number, total?: number | null) => void
    setTabId: (tabId: number | null) => void
    finish: (result: unknown) => void
    fail: (code: string, message: string) => void
    isCancelled: () => boolean
}

export type DispatchFn = (params: Record<string, unknown>, ctx: DispatchContext) => Promise<void>

export interface PdFacade {
    call: (method: string, params: Record<string, unknown>) => Promise<{ taskId: string; tabId: number | null }>
    tail: (taskId: string, sinceSeq: number) => Promise<TailResult>
    status: (taskId: string) => Promise<StatusSnapshot | { error: 'not_found' }>
    cancel: (taskId: string) => Promise<{ ok: boolean }>
    listTasks: (opts?: {all?: boolean}) => Promise<TaskMeta[]>
    methods: () => string[]
    register: (method: string, fn: DispatchFn) => void
}

// declare global 里只能用 var，let/const 语义不对
declare global {
    // noinspection ES6ConvertVarToLetConst
    // eslint-disable-next-line no-var
    var __pd: PdFacade | undefined
}
