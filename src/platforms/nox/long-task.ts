export interface LongTaskCheckpoint {
    id: string
    type: 'nox-auto-collect'
    state: 'running' | 'paused' | 'done' | 'failed'
    updatedAt: number
    params: NoxAutoCollectParams
}

export interface NoxAutoCollectParams {
    targetCount: number
    collectProfile: boolean
    baseParams: Record<string, unknown>
    startPageNum: number
}

let activeTask: LongTaskCheckpoint | null = null

export async function getCheckpoint(): Promise<LongTaskCheckpoint | null> {
    return activeTask
}

export async function patchCheckpoint(partial: Partial<LongTaskCheckpoint>): Promise<LongTaskCheckpoint | null> {
    if (!activeTask) return null
    activeTask = {
        ...activeTask,
        ...partial,
        updatedAt: Date.now(),
    }
    return activeTask
}

export async function startNoxAutoCollect(
    params: NoxAutoCollectParams
): Promise<{taskId: string} | {error: string}> {
    if (activeTask?.state === 'running' || activeTask?.state === 'paused') {
        return {error: '已有进行中的任务，请先暂停或中止'}
    }

    const taskId = `nox-auto-${Date.now()}`
    activeTask = {
        id: taskId,
        type: 'nox-auto-collect',
        state: 'running',
        updatedAt: Date.now(),
        params,
    }
    return {taskId}
}

export async function pauseLongTask(): Promise<void> {
    if (!activeTask) return
    activeTask = {...activeTask, state: 'paused', updatedAt: Date.now()}
}

export async function resumeLongTask(): Promise<void> {
    if (!activeTask || activeTask.state !== 'paused') return
    activeTask = {...activeTask, state: 'running', updatedAt: Date.now()}
}

export async function clearLongTask(): Promise<void> {
    activeTask = null
}
