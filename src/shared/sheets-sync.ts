import {callAppsScript} from './apps-script-client'
import {showAlarm} from './alarm'

interface QueueItem {
    id: number
    op: 'upsertInfluencers' | 'updateInfluencerStatus' | 'upsertVideos' | 'upsertNoxPage'
}

interface SyncState {
    queue: QueueItem[]
    nextId: number
    upsertedInfluencers: number
    upsertedAudienceProfiles: number
}

interface SyncStatus {
    pendingQueueSize: number
    upsertedInfluencers: number
    upsertedAudienceProfiles: number
}

const HARD_WATERMARK = 2000

let workerTimer: number | null = null
let workerStarted = false
let retryDelay = 1000
let consecutiveFailures = 0
let isProcessing = false

async function requestPayloadStore<T>(message: Record<string, unknown>): Promise<T | undefined> {
    const response = await chrome.runtime.sendMessage(message) as {ok?: boolean; payload?: T; error?: string} | undefined
    if (!response?.ok) throw new Error(response?.error || 'sheets_sync_payload_store_failed')
    return response.payload
}

async function getPayload(id: number): Promise<unknown | undefined> {
    return requestPayloadStore({type: 'sheets_sync_payload_get', id})
}

async function deletePayload(id: number): Promise<void> {
    await requestPayloadStore({type: 'sheets_sync_payload_delete', id})
}

async function loadQueueState(): Promise<SyncState | undefined> {
    return requestPayloadStore<SyncState>({type: 'sheets_sync_state_get'})
}

async function saveQueueState(state: SyncState): Promise<void> {
    await requestPayloadStore({type: 'sheets_sync_state_put', state})
}

function isQueueOp(value: unknown): value is QueueItem['op'] {
    return value === 'upsertInfluencers' || value === 'updateInfluencerStatus' || value === 'upsertVideos' || value === 'upsertNoxPage'
}

async function loadState(): Promise<SyncState> {
    const raw = await loadQueueState()
    if (raw && typeof raw === 'object' && Array.isArray(raw.queue)) {
        const queue = raw.queue.filter(item => Number.isFinite(Number(item.id)) && isQueueOp(item.op))
        return {
            queue,
            nextId: Number(raw.nextId) || queue.reduce((max, item) => Math.max(max, item.id + 1), 1),
            upsertedInfluencers: Number(raw.upsertedInfluencers) || 0,
            upsertedAudienceProfiles: Number(raw.upsertedAudienceProfiles) || 0,
        }
    }
    return {queue: [], nextId: 1, upsertedInfluencers: 0, upsertedAudienceProfiles: 0}
}

function clearWorkerTimer(): void {
    if (workerTimer !== null) {
        clearTimeout(workerTimer)
        workerTimer = null
    }
}

function scheduleWorker(delay: number): void {
    if (!workerStarted) return
    clearWorkerTimer()
    workerTimer = self.setTimeout(() => {
        workerTimer = null
        void runWorkerCycle()
    }, Math.max(0, delay)) as unknown as number
}

async function saveState(state: SyncState): Promise<void> {
    await saveQueueState(state)
}

async function atomicEnqueue(id: number, payload: unknown, state: SyncState): Promise<void> {
    const response = await chrome.runtime.sendMessage({
        type: 'sheets_sync_atomic_enqueue',
        id,
        payload,
        state
    }) as {ok?: boolean; error?: string} | undefined
    if (!response?.ok) throw new Error(response?.error || 'sheets_sync_atomic_enqueue_failed')
}

async function enqueue(item: Omit<QueueItem, 'id'> & {payload: unknown}): Promise<void> {
    const state = await loadState()
    const newItem: QueueItem = {id: state.nextId, op: item.op}
    state.nextId += 1
    state.queue.push(newItem)
    await atomicEnqueue(newItem.id, item.payload, state)
    checkWatermark(state.queue.length)
    if (workerStarted) scheduleWorker(0)
}

function checkWatermark(queueSize: number): void {
    if (queueSize > HARD_WATERMARK) {
        showAlarm(`Sheets 同步阻塞（队列 ${queueSize} 条），请检查网络/token`, 20_000)
    }
}

export async function enqueueUpsertInfluencers(platform: string, items: unknown[]): Promise<void> {
    await enqueue({op: 'upsertInfluencers', payload: {platform, influencers: items}})
}

export async function enqueueUpdateStatus(
    platform: string,
    channelId: string,
    patch: Record<string, unknown>,
    increment?: Record<string, number>
): Promise<void> {
    const payload: UpdateStatusPayload = {platform, channelId, patch}
    if (increment && Object.keys(increment).length > 0) payload.increment = increment
    await enqueue({op: 'updateInfluencerStatus', payload})
}

export async function enqueueUpsertVideos(platform: string, videos: unknown[]): Promise<void> {
    if (videos.length === 0) return
    await enqueue({op: 'upsertVideos', payload: {platform, videos}})
}

export async function enqueueUpsertNoxPage(url: string, pageNum: number): Promise<void> {
    await enqueue({op: 'upsertNoxPage', payload: {url, pageNum}})
}

const BATCH_MAX = 200

interface UpdateStatusPayload {
    platform?: string
    channelId: string
    patch: Record<string, unknown>
    increment?: Record<string, number>
}

function handleProcessError(error: unknown): void {
    consecutiveFailures += 1
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('429') || msg.includes('quota')) {
        retryDelay = 60_000
    } else {
        retryDelay = Math.min(retryDelay * 2, 30_000)
    }
    if (consecutiveFailures >= 10) {
        showAlarm('Sheets 同步连续失败 10 次，已暂停', 20_000)
    }
}

async function processStatusBatch(state: SyncState): Promise<boolean> {
    const batch: QueueItem[] = []
    for (let i = 0; i < state.queue.length && batch.length < BATCH_MAX; i++) {
        if (state.queue[i].op !== 'updateInfluencerStatus') break
        batch.push(state.queue[i])
    }
    if (batch.length < 2) return false

    try {
        const updates: Array<{channelId: string; patch: Record<string, unknown>; increment?: Record<string, number>}> = []
        let platform = 'tiktok'
        const missingIds: number[] = []
        for (const it of batch) {
            const p = await getPayload(it.id) as UpdateStatusPayload | undefined
            if (!p || !p.channelId) { missingIds.push(it.id); continue }
            if (p.platform) platform = p.platform
            const update: {channelId: string; patch: Record<string, unknown>; increment?: Record<string, number>} = {
                channelId: p.channelId,
                patch: p.patch || {}
            }
            if (p.increment && Object.keys(p.increment).length > 0) update.increment = p.increment
            updates.push(update)
        }

        if (updates.length > 0) {
            await callAppsScript('updateInfluencerStatusBatch', {platform, updates})
        }

        const fresh = await loadState()
        const batchIds = new Set(batch.map(b => b.id))
        fresh.queue = fresh.queue.filter(q => !batchIds.has(q.id))
        for (const it of batch) await deletePayload(it.id)
        fresh.upsertedAudienceProfiles += updates.length
        await saveState(fresh)
        retryDelay = 1000
        consecutiveFailures = 0
        return fresh.queue.length > 0
    } catch (error) {
        handleProcessError(error)
        return false
    }
}

async function processVideoBatch(state: SyncState): Promise<boolean> {
    const batch: QueueItem[] = []
    const collected: Array<{platform: string; videos: unknown[]}> = []
    let firstPlatform: string | null = null

    for (let i = 0; i < state.queue.length && batch.length < BATCH_MAX; i++) {
        const it = state.queue[i]
        if (it.op !== 'upsertVideos') break
        const p = await getPayload(it.id) as {platform?: string; videos?: unknown[]} | undefined
        if (!p || !Array.isArray(p.videos)) break
        const platform = String(p.platform || 'tiktok')
        if (firstPlatform === null) firstPlatform = platform
        else if (platform !== firstPlatform) break
        batch.push(it)
        collected.push({platform, videos: p.videos})
    }
    if (batch.length < 2 || !firstPlatform) return false

    try {
        const allVideos: unknown[] = []
        for (const c of collected) {
            for (const v of c.videos) allVideos.push(v)
        }

        if (allVideos.length > 0) {
            await callAppsScript('upsertVideos', {platform: firstPlatform, videos: allVideos})
        }

        const fresh = await loadState()
        const batchIds = new Set(batch.map(b => b.id))
        fresh.queue = fresh.queue.filter(q => !batchIds.has(q.id))
        for (const it of batch) await deletePayload(it.id)
        await saveState(fresh)
        retryDelay = 1000
        consecutiveFailures = 0
        return fresh.queue.length > 0
    } catch (error) {
        handleProcessError(error)
        return false
    }
}

async function processSingle(state: SyncState): Promise<boolean> {
    const item = state.queue[0]
    try {
        const payload = await getPayload(item.id)
        if (payload === undefined) {
            const fresh = await loadState()
            fresh.queue = fresh.queue.filter(q => q.id !== item.id)
            await saveState(fresh)
            return fresh.queue.length > 0
        }

        await callAppsScript(item.op, payload)
        const fresh = await loadState()
        fresh.queue = fresh.queue.filter(q => q.id !== item.id)
        await deletePayload(item.id)
        if (item.op === 'upsertInfluencers') fresh.upsertedInfluencers += 1
        if (item.op === 'updateInfluencerStatus') fresh.upsertedAudienceProfiles += 1
        await saveState(fresh)
        retryDelay = 1000
        consecutiveFailures = 0
        return fresh.queue.length > 0
    } catch (error) {
        handleProcessError(error)
        return false
    }
}

async function processNext(): Promise<boolean> {
    const state = await loadState()
    if (state.queue.length === 0) return false
    const head = state.queue[0]
    if (head.op === 'updateInfluencerStatus' && state.queue.length >= 2 && state.queue[1].op === 'updateInfluencerStatus') {
        return processStatusBatch(state)
    }
    if (head.op === 'upsertVideos' && state.queue.length >= 2 && state.queue[1].op === 'upsertVideos') {
        return processVideoBatch(state)
    }
    return processSingle(state)
}

async function runWorkerCycle(): Promise<void> {
    if (isProcessing) return
    isProcessing = true
    try {
        let hasMore = true
        while (hasMore) {
            hasMore = await processNext()
            if (hasMore) await new Promise(r => setTimeout(r, 200))
        }
    } finally {
        isProcessing = false
        const state = await loadState()
        if (workerStarted && state.queue.length > 0) {
            scheduleWorker(consecutiveFailures > 0 ? retryDelay : 200)
        }
    }
}

export async function getSyncStatus(): Promise<SyncStatus> {
    const state = await loadState()
    return {
        pendingQueueSize: state.queue.length,
        upsertedInfluencers: state.upsertedInfluencers,
        upsertedAudienceProfiles: state.upsertedAudienceProfiles,
    }
}

export function startSyncWorker(): void {
    if (workerStarted) return
    workerStarted = true
    scheduleWorker(0)
}

export {HARD_WATERMARK}
