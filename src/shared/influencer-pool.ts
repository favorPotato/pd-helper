import type {NoxInfluencer, InfluencerPlatform} from '../platforms/nox/types'

const STORAGE_KEYS: Record<InfluencerPlatform, string> = {
    tiktok: 'nox_influencer_pool_tiktok',
    instagram: 'nox_influencer_pool_instagram'
}

function toNumber(value: unknown): number {
    const num = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(num) ? num : 0
}

function normalizePlatform(value: unknown): InfluencerPlatform {
    return value === 'instagram' ? 'instagram' : 'tiktok'
}

function normalizeInfluencer(value: unknown): NoxInfluencer | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null

    const record = value as Record<string, unknown>
    const channelId = String(record.channelId || '').trim()
    const username = String(record.username || '').trim().replace(/^@/, '')
    if (!channelId || !username) return null

    return {
        channelId,
        platform: normalizePlatform(record.platform),
        username,
        name: String(record.name || '').trim(),
        genderTag: String(record.genderTag || 'N-').trim() || 'N-',
        femaleRatio: toNumber(record.femaleRatio),
        maleRatio: toNumber(record.maleRatio)
    }
}

async function savePool(platform: InfluencerPlatform, influencers: NoxInfluencer[]): Promise<void> {
    await chrome.storage.local.set({[STORAGE_KEYS[platform]]: influencers})
}

export async function loadInfluencerPool(platform: InfluencerPlatform): Promise<NoxInfluencer[]> {
    const key = STORAGE_KEYS[platform]
    const data = await chrome.storage.local.get(key)
    const raw = Array.isArray(data[key]) ? data[key] : []
    return raw.map(normalizeInfluencer).filter((item): item is NoxInfluencer => item !== null && item.platform === platform)
}

export async function getInfluencerPoolCount(platform: InfluencerPlatform): Promise<number> {
    const influencers = await loadInfluencerPool(platform)
    return influencers.length
}

export async function upsertInfluencerPool(platform: InfluencerPlatform, incoming: NoxInfluencer[]): Promise<{total: number; added: number; updated: number}> {
    const scopedIncoming = incoming.filter((item) => item.platform === platform)
    const existing = await loadInfluencerPool(platform)
    const next = existing.slice()
    const indexMap = new Map<string, number>()

    existing.forEach((item, index) => {
        indexMap.set(item.channelId, index)
    })

    let added = 0
    let updated = 0

    for (const influencer of scopedIncoming) {
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

    await savePool(platform, next)
    return {total: next.length, added, updated}
}

export async function removeInfluencersFromPool(platform: InfluencerPlatform, channelIds: string[]): Promise<{total: number; removed: number}> {
    if (channelIds.length === 0) {
        return {total: await getInfluencerPoolCount(platform), removed: 0}
    }

    const idSet = new Set(channelIds)
    const existing = await loadInfluencerPool(platform)
    const next = existing.filter((item) => !idSet.has(item.channelId))
    await savePool(platform, next)
    return {total: next.length, removed: existing.length - next.length}
}

export async function clearInfluencerPool(platform: InfluencerPlatform): Promise<{removed: number}> {
    const existing = await loadInfluencerPool(platform)
    await chrome.storage.local.remove(STORAGE_KEYS[platform])
    return {removed: existing.length}
}
