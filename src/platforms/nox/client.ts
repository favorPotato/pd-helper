import {encodeP} from '../../shared/p-codec'
import type {AudienceProfile, AudienceResponse} from './types'

function extractName(value: unknown): string {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>
        if (typeof obj.name === 'string') return obj.name
    }
    return ''
}

export async function fetchAudienceProfile(channelId: string): Promise<AudienceProfile> {
    const p = encodeP({channelId, subSite: 'cn', t: 1021})
    const url = `https://cn.noxinfluencer.com/ws/v2/tiktok/star/audience?p=${p}`
    const response = await fetch(url, {
        credentials: 'include',
        headers: {accept: 'application/json'}
    })

    if (!response.ok) {
        throw new Error(`audience API 请求失败: ${response.status}`)
    }

    const data = await response.json() as AudienceResponse
    if (data.errorNum !== 0) {
        throw new Error(`audience API 业务错误: ${data.errorNum}`)
    }

    const r = data.retData
    return {
        gender: r.gender,
        regions: (r.regions as Record<string, number>) || {},
        language: (r.language as Record<string, number>) || {},
        maleAge: (r.maleAge as Record<string, number>) || {},
        femaleAge: (r.femaleAge as Record<string, number>) || {},
        adults: typeof r.adults === 'number' ? r.adults : 0,
        topRegion: extractName(r.topRegion),
        topGender: extractName(r.topGender),
        topAge: extractName(r.topAge),
    }
}
