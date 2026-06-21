// chrome.storage.session 兜底持久化（仅元数据）：SW 重启后识别 orphaned 任务

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
    // 持久化副本剔除 result：本兜底持久化仅供 SW 重启后识别 orphaned 任务（只读 taskId/status），不需结果体。
    // 单采整份 itemStruct 约 100–200KB，留着会无谓挤占 chrome.storage.session 配额（10MB 硬上限）。
    // 必须浅拷贝后剔除——meta 是 runtime 内存对象引用，原地 delete 会误伤 callAndWait/listTasks 读的真 result。
    const persisted: TaskMeta = {...meta, result: undefined}
    try {
        await chrome.storage.session.set({[KEY_PREFIX + meta.taskId]: persisted})
    } catch (e) {
        // session 不可写（多为配额超限）时放弃，不影响主流程；记一行便于日后诊断配额，不再静默吞
        console.warn(`[pd-helper] persistMeta 写入失败（taskId=${meta.taskId}）：`, e)
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
