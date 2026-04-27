import {getSyncStatus, HARD_WATERMARK} from '../../shared/sheets-sync'
import {showAlarm} from '../../shared/alarm'

import type {SearchExtra} from './profile-mapping'

export interface LongTaskCheckpoint {
    id: string
    type: 'nox-auto-collect'
    state: 'running' | 'paused' | 'done' | 'failed'
    createdAt: number
    updatedAt: number
    params: {
        targetCount: number
        collectProfile: boolean
        baseParams: Record<string, unknown>
        startPageNum: number
    }
    paging: {
        status: 'pending' | 'running' | 'done'
        nextPageNum: number
        totalPages: number
        pagedCount: number
        newChannelIds: string[]
        searchData: Record<string, SearchExtra>
    }
    profiling: {
        status: 'pending' | 'running' | 'done' | 'skipped'
        cursor: number
        succeededCount: number
        failedCount: number
        lastFailedReason?: string
    }
    sync: {
        upsertedInfluencers: number
        upsertedAudienceProfiles: number
        pendingQueueSize: number
    }
    error?: {
        kind: 'session-expired' | 'network' | 'cloudflare' | 'apps-script' | 'unknown'
        message: string
        at: number
    }
}

export interface NoxAutoCollectParams {
    targetCount: number
    collectProfile: boolean
    baseParams: Record<string, unknown>
    startPageNum: number
}

const CHECKPOINT_KEY = 'long_task_checkpoint_v1'

export async function getCheckpoint(): Promise<LongTaskCheckpoint | null> {
    const data = await chrome.storage.local.get(CHECKPOINT_KEY)
    return (data[CHECKPOINT_KEY] as LongTaskCheckpoint) || null
}

async function saveCheckpoint(cp: LongTaskCheckpoint): Promise<void> {
    await chrome.storage.local.set({[CHECKPOINT_KEY]: cp})
}

export async function patchCheckpoint(partial: Partial<LongTaskCheckpoint>): Promise<LongTaskCheckpoint | null> {
    const cp = await getCheckpoint()
    if (!cp) return null
    const syncStatus = await getSyncStatus()
    const updated: LongTaskCheckpoint = {
        ...cp,
        ...partial,
        updatedAt: Date.now(),
        sync: {
            upsertedInfluencers: syncStatus.upsertedInfluencers,
            upsertedAudienceProfiles: syncStatus.upsertedAudienceProfiles,
            pendingQueueSize: syncStatus.pendingQueueSize,
        }
    }
    await saveCheckpoint(updated)

    if (syncStatus.pendingQueueSize > HARD_WATERMARK) {
        updated.state = 'paused'
        await saveCheckpoint(updated)
        showAlarm('Sheets 同步阻塞，任务已暂停', 20_000)
    }

    return updated
}

export async function startNoxAutoCollect(
    params: NoxAutoCollectParams
): Promise<{taskId: string} | {error: string}> {
    const existing = await getCheckpoint()
    if (existing && existing.state === 'running') {
        return {error: '已有进行中的任务，请先暂停或中止'}
    }

    const taskId = `nox-auto-${Date.now()}`
    const cp: LongTaskCheckpoint = {
        id: taskId,
        type: 'nox-auto-collect',
        state: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        params,
        paging: {status: 'pending', nextPageNum: params.startPageNum, totalPages: 0, pagedCount: 0, newChannelIds: [], searchData: {}},
        profiling: {status: 'pending', cursor: 0, succeededCount: 0, failedCount: 0},
        sync: {upsertedInfluencers: 0, upsertedAudienceProfiles: 0, pendingQueueSize: 0}
    }
    await saveCheckpoint(cp)
    return {taskId}
}

export async function pauseLongTask(): Promise<void> {
    const cp = await getCheckpoint()
    if (!cp) return
    cp.state = 'paused'
    cp.updatedAt = Date.now()
    await saveCheckpoint(cp)
}

export async function resumeLongTask(): Promise<void> {
    const cp = await getCheckpoint()
    if (!cp || cp.state !== 'paused') return
    cp.state = 'running'
    cp.updatedAt = Date.now()
    await saveCheckpoint(cp)
}


