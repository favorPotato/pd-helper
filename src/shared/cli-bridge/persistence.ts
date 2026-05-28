// chrome.storage.session 兜底持久化：仅元数据，不存日志
// 用途：SW 被杀重启后能识别 orphaned 任务

import type {TaskMeta} from './types'

const KEY_PREFIX = 'pd_task_'
const HEARTBEAT_THROTTLE_MS = 5_000

const lastWriteAt = new Map<string, number>()

export async function persistMeta(meta: TaskMeta, opts?: {throttle?: boolean}): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return
    if (opts?.throttle) {
        const last = lastWriteAt.get(meta.taskId) || 0
        if (Date.now() - last < HEARTBEAT_THROTTLE_MS) return
    }
    lastWriteAt.set(meta.taskId, Date.now())
    try {
        await chrome.storage.session.set({[KEY_PREFIX + meta.taskId]: meta})
    } catch {
        // ignore: session 不可写时直接放弃，不影响主流程
    }
}

export async function loadAllMeta(): Promise<TaskMeta[]> {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return []
    try {
        const all = await chrome.storage.session.get(null)
        const out: TaskMeta[] = []
        for (const [k, v] of Object.entries(all)) {
            if (!k.startsWith(KEY_PREFIX)) continue
            const meta = v as TaskMeta
            if (meta && typeof meta.taskId === 'string') out.push(meta)
        }
        return out
    } catch {
        return []
    }
}

export async function clearMeta(taskId: string): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return
    try {
        await chrome.storage.session.remove(KEY_PREFIX + taskId)
    } catch {
        // ignore
    }
}
