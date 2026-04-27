const IDB_NAME = 'tiktok_ig_bridge_cache'
const IDB_STORE = 'videos'
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
        const req = indexedDB.open(IDB_NAME, 1)
        req.onerror = () => reject(new Error('IndexedDB open failed'))
        req.onsuccess = () => resolve(req.result)
        req.onupgradeneeded = (ev) => {
            const db = (ev.target as IDBOpenDBRequest).result
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE)
            }
        }
    })
}

export async function idbGet(key: string): Promise<CachedVideo | undefined> {
    const db = await openIdb()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly')
        const store = tx.objectStore(IDB_STORE)
        const req = store.get(key)
        req.onerror = () => reject(new Error('IndexedDB get failed'))
        req.onsuccess = () => resolve(req.result as CachedVideo | undefined)
    })
}

export async function idbPut(key: string, value: CachedVideo): Promise<void> {
    const db = await openIdb()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite')
        const store = tx.objectStore(IDB_STORE)
        const req = store.put(value, key)
        req.onerror = () => reject(new Error('IndexedDB put failed'))
        req.onsuccess = () => resolve()
    })
}

export async function idbDelete(key: string): Promise<void> {
    const db = await openIdb()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite')
        const store = tx.objectStore(IDB_STORE)
        const req = store.delete(key)
        req.onerror = () => reject(new Error('IndexedDB delete failed'))
        req.onsuccess = () => resolve()
    })
}

export async function clearStaleCache(): Promise<void> {
    try {
        await idbDelete(IDB_KEY)
    } catch {
    }
}
