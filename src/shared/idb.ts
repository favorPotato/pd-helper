const IDB_NAME = 'tiktok_ig_bridge_cache'
const IDB_VERSION = 5
const VIDEO_STORE = 'videos'
const SHEETS_SYNC_STORE = 'sheets_sync_payloads'
const SHEETS_SYNC_STATE_STORE = 'sheets_sync_state'
const COLLECTED_VIDEO_IDS_STORE = 'collected_video_ids'
const TK_CLAIM_QUEUE_STORE = 'tk_claim_queue'
const TK_CLAIM_META_STORE = 'tk_claim_meta'
const SHEETS_SYNC_STATE_KEY = 'current'
const TK_CLAIM_META_LAST_AT_KEY = 'last_claim_at'
const COLLECTED_VIDEO_IDS_META_SUFFIX = ':meta'
export const IDB_KEY = 'current'

export interface VideoMeta {
    width: number
    height: number
    durationSec: number
}

export interface CachedVideo {
    bytes: ArrayBuffer
    mime: string
    name: string
    meta: VideoMeta
    createdAt: number
}

export function parseVideoMeta(input: unknown): VideoMeta {
    if (input && typeof input === 'object') {
        const obj = input as Record<string, unknown>
        const w = Number(obj.width)
        const h = Number(obj.height)
        const d = Number(obj.durationSec)
        return {
            width: Number.isFinite(w) && w >= 0 ? w : 0,
            height: Number.isFinite(h) && h >= 0 ? h : 0,
            durationSec: Number.isFinite(d) && d >= 0 ? d : 0
        }
    }
    return {width: 0, height: 0, durationSec: 0}
}

function openIdb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION)
        req.onerror = () => reject(new Error('IndexedDB open failed'))
        req.onsuccess = () => resolve(req.result)
        req.onupgradeneeded = (ev) => {
            const db = (ev.target as IDBOpenDBRequest).result
            if (!db.objectStoreNames.contains(VIDEO_STORE)) {
                db.createObjectStore(VIDEO_STORE)
            }
            if (!db.objectStoreNames.contains(SHEETS_SYNC_STORE)) {
                db.createObjectStore(SHEETS_SYNC_STORE)
            }
            if (!db.objectStoreNames.contains(SHEETS_SYNC_STATE_STORE)) {
                db.createObjectStore(SHEETS_SYNC_STATE_STORE)
            }
            if (!db.objectStoreNames.contains(COLLECTED_VIDEO_IDS_STORE)) {
                db.createObjectStore(COLLECTED_VIDEO_IDS_STORE)
            }
            if (!db.objectStoreNames.contains(TK_CLAIM_QUEUE_STORE)) {
                db.createObjectStore(TK_CLAIM_QUEUE_STORE)
            }
            if (!db.objectStoreNames.contains(TK_CLAIM_META_STORE)) {
                db.createObjectStore(TK_CLAIM_META_STORE)
            }
        }
    })
}

function idbStoreGetAllValues<T>(storeName: string): Promise<T[]> {
    return openIdb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const req = store.getAll()
        req.onerror = () => reject(new Error('IndexedDB getAll failed'))
        req.onsuccess = () => resolve(req.result as T[])
    }))
}

function idbStoreCount(storeName: string): Promise<number> {
    return openIdb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const req = store.count()
        req.onerror = () => reject(new Error('IndexedDB count failed'))
        req.onsuccess = () => resolve(req.result)
    }))
}

function idbStoreClear(storeName: string): Promise<void> {
    return openIdb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        const store = tx.objectStore(storeName)
        const req = store.clear()
        req.onerror = () => reject(new Error('IndexedDB clear failed'))
        req.onsuccess = () => resolve()
    }))
}

function idbStoreGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    return openIdb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const req = store.get(key)
        req.onerror = () => reject(new Error('IndexedDB get failed'))
        req.onsuccess = () => resolve(req.result as T | undefined)
    }))
}

function idbStorePut(storeName: string, key: IDBValidKey, value: unknown): Promise<void> {
    return openIdb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        const store = tx.objectStore(storeName)
        const req = store.put(value, key)
        req.onerror = () => reject(new Error('IndexedDB put failed'))
        req.onsuccess = () => resolve()
    }))
}

function idbStoreDelete(storeName: string, key: IDBValidKey): Promise<void> {
    return openIdb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        const store = tx.objectStore(storeName)
        const req = store.delete(key)
        req.onerror = () => reject(new Error('IndexedDB delete failed'))
        req.onsuccess = () => resolve()
    }))
}

export async function idbGet(key: string): Promise<CachedVideo | undefined> {
    return idbStoreGet<CachedVideo>(VIDEO_STORE, key)
}

export async function idbPut(key: string, value: CachedVideo): Promise<void> {
    await idbStorePut(VIDEO_STORE, key, value)
}

export async function idbDelete(key: string): Promise<void> {
    await idbStoreDelete(VIDEO_STORE, key)
}

export async function idbGetSheetsSyncPayload<T = unknown>(id: number): Promise<T | undefined> {
    return idbStoreGet<T>(SHEETS_SYNC_STORE, id)
}

export async function idbPutSheetsSyncPayload(id: number, payload: unknown): Promise<void> {
    await idbStorePut(SHEETS_SYNC_STORE, id, payload)
}

export async function idbDeleteSheetsSyncPayload(id: number): Promise<void> {
    await idbStoreDelete(SHEETS_SYNC_STORE, id)
}

export async function idbGetSheetsSyncState<T = unknown>(): Promise<T | undefined> {
    return idbStoreGet<T>(SHEETS_SYNC_STATE_STORE, SHEETS_SYNC_STATE_KEY)
}

export async function idbPutSheetsSyncState(state: unknown): Promise<void> {
    await idbStorePut(SHEETS_SYNC_STATE_STORE, SHEETS_SYNC_STATE_KEY, state)
}

export async function idbAtomicEnqueueSheetsSync(id: number, payload: unknown, state: unknown): Promise<void> {
    const db = await openIdb()
    return new Promise((resolve, reject) => {
        const tx = db.transaction([SHEETS_SYNC_STORE, SHEETS_SYNC_STATE_STORE], 'readwrite')
        tx.objectStore(SHEETS_SYNC_STORE).put(payload, id)
        tx.objectStore(SHEETS_SYNC_STATE_STORE).put(state, SHEETS_SYNC_STATE_KEY)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(new Error('IndexedDB atomic enqueue failed'))
        tx.onabort = () => reject(new Error('IndexedDB atomic enqueue aborted'))
    })
}

export async function idbGetCollectedVideoIds(platform: string): Promise<string[] | undefined> {
    return idbStoreGet<string[]>(COLLECTED_VIDEO_IDS_STORE, platform)
}

export async function idbPutCollectedVideoIds(platform: string, ids: string[]): Promise<void> {
    await idbStorePut(COLLECTED_VIDEO_IDS_STORE, platform, ids)
}

export async function idbGetCollectedVideoIdsLastSync(platform: string): Promise<number | undefined> {
    return idbStoreGet<number>(COLLECTED_VIDEO_IDS_STORE, platform + COLLECTED_VIDEO_IDS_META_SUFFIX)
}

export async function idbPutCollectedVideoIdsLastSync(platform: string, ts: number): Promise<void> {
    await idbStorePut(COLLECTED_VIDEO_IDS_STORE, platform + COLLECTED_VIDEO_IDS_META_SUFFIX, ts)
}

export async function idbTkClaimQueuePushBatch<T>(items: Array<{key: string; value: T}>): Promise<void> {
    if (items.length === 0) return
    const db = await openIdb()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(TK_CLAIM_QUEUE_STORE, 'readwrite')
        const store = tx.objectStore(TK_CLAIM_QUEUE_STORE)
        for (const it of items) store.put(it.value, it.key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(new Error('IndexedDB tk_claim_queue push failed'))
        tx.onabort = () => reject(new Error('IndexedDB tk_claim_queue push aborted'))
    })
}

export async function idbTkClaimQueueGetAll<T>(): Promise<T[]> {
    return idbStoreGetAllValues<T>(TK_CLAIM_QUEUE_STORE)
}

export async function idbTkClaimQueueDelete(key: string): Promise<void> {
    await idbStoreDelete(TK_CLAIM_QUEUE_STORE, key)
}

export async function idbTkClaimQueueCount(): Promise<number> {
    return idbStoreCount(TK_CLAIM_QUEUE_STORE)
}

export async function idbTkClaimQueueClear(): Promise<void> {
    await idbStoreClear(TK_CLAIM_QUEUE_STORE)
}

export async function idbGetLastClaimAt(): Promise<number | undefined> {
    return idbStoreGet<number>(TK_CLAIM_META_STORE, TK_CLAIM_META_LAST_AT_KEY)
}

export async function idbPutLastClaimAt(ts: number): Promise<void> {
    await idbStorePut(TK_CLAIM_META_STORE, TK_CLAIM_META_LAST_AT_KEY, ts)
}

export async function clearStaleCache(): Promise<void> {
    try {
        await idbDelete(IDB_KEY)
    } catch {
    }
}
