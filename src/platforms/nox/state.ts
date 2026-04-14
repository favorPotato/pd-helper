import type {NoxInfluencer} from './types'

const STORAGE_KEY = 'nox_influencer_pool_v1'

function toNumber(value: unknown): number {
    const num = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(num) ? num : 0
}

function normalizeInfluencer(value: unknown): NoxInfluencer | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null

    const record = value as Record<string, unknown>
    const channelId = String(record.channelId || '').trim()
    const tiktokUsername = String(record.tiktokUsername || '').trim().replace(/^@/, '')
    if (!channelId || !tiktokUsername) return null

    return {
        channelId,
        tiktokUsername,
        name: String(record.name || '').trim(),
        genderTag: String(record.genderTag || 'N-').trim() || 'N-',
        femaleRatio: toNumber(record.femaleRatio),
        maleRatio: toNumber(record.maleRatio)
    }
}

async function saveNoxInfluencerPool(influencers: NoxInfluencer[]): Promise<void> {
    await chrome.storage.local.set({[STORAGE_KEY]: influencers})
}

export async function loadNoxInfluencerPool(): Promise<NoxInfluencer[]> {
    const data = await chrome.storage.local.get(STORAGE_KEY)
    const raw = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : []
    return raw.map(normalizeInfluencer).filter((item): item is NoxInfluencer => item !== null)
}

export async function getNoxInfluencerPoolCount(): Promise<number> {
    const influencers = await loadNoxInfluencerPool()
    return influencers.length
}

export async function upsertNoxInfluencerPool(incoming: NoxInfluencer[]): Promise<{total: number; added: number; updated: number}> {
    const existing = await loadNoxInfluencerPool()
    const next = existing.slice()
    const indexMap = new Map<string, number>()

    existing.forEach((item, index) => {
        indexMap.set(item.channelId, index)
    })

    let added = 0
    let updated = 0

    for (const influencer of incoming) {
        const existingIndex = indexMap.get(influencer.channelId)
        if (existingIndex === undefined) {
            indexMap.set(influencer.channelId, next.length)
            next.push(influencer)
            added += 1
            continue
        }

        next[existingIndex] = influencer
        updated += 1
    }

    await saveNoxInfluencerPool(next)
    return {total: next.length, added, updated}
}

export async function removeNoxInfluencersFromPool(channelIds: string[]): Promise<{total: number; removed: number}> {
    if (channelIds.length === 0) {
        return {total: await getNoxInfluencerPoolCount(), removed: 0}
    }

    const idSet = new Set(channelIds)
    const existing = await loadNoxInfluencerPool()
    const next = existing.filter((item) => !idSet.has(item.channelId))
    await saveNoxInfluencerPool(next)
    return {total: next.length, removed: existing.length - next.length}
}
