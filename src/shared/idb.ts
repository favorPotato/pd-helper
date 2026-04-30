const IDB_NAME = 'tiktok_ig_bridge_cache'
const IDB_VERSION = 3
const VIDEO_STORE = 'videos'
const SHEETS_SYNC_STORE = 'sheets_sync_payloads'
const SHEETS_SYNC_STATE_STORE = 'sheets_sync_state'
const SHEETS_SYNC_STATE_KEY = 'current'
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
        }
    })
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

export async function clearStaleCache(): Promise<void> {
    try {
        await idbDelete(IDB_KEY)
    } catch {
    }
}
