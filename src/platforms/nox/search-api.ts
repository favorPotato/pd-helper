import {decodeP, encodeP} from '../../shared/p-codec'
import {safeSendMessage} from '../../shared/messaging'
import type {NoxSearchResponse} from '../../types'

export interface SearchInfluencer {
    id: string
    alias: string
    nickName: string
    country: string
    followers: number
    totalVideos: number
    noxScore: number
    interactiveRate: number
    tags: string[]
    estimateVideoPrice: number
    estimateVideoViews: number
    viewsFollowers: number
    followings: number
    isCelebrity: boolean
    isBrand: boolean
    ttseller: boolean
    language: string
    [key: string]: unknown
}

export interface SearchPageResult {
    totalSize: number
    totalPage: number
    pageNum: number
    pageSize: number
    influencers: SearchInfluencer[]
    errorNum: number
}

export function readBaseParamsFromUrl(): Record<string, unknown> {
    const p = new URLSearchParams(window.location.search).get('p')
    if (!p) return {pageSize: 100}
    try {
        return decodeP(p) as Record<string, unknown>
    } catch {
        return {pageSize: 100}
    }
}

function toTags(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String).filter(Boolean)
    if (typeof value === 'string' && value) return [value]
    return []
}

export async function fetchSearchPage(
    baseParams: Record<string, unknown>,
    pageNum: number
): Promise<SearchPageResult> {
    const params = {...baseParams, pageNum, pageSize: baseParams.pageSize || 100}
    const p = encodeP(params)
    const url = `https://cn.noxinfluencer.com/ws/v2/tiktok/star/search?p=${p}`

    const result = await safeSendMessage<NoxSearchResponse>({type: 'nox_search_request', url})
    if (!result || !result.ok) {
        throw new Error(`search API 请求失败: ${result?.status || 'no_response'}`)
    }

    const data = result.data
    if (!data || Number(data.errorNum) !== 0) {
        throw new Error(`search API 业务错误: ${data?.errorNum ?? 'null'}`)
    }

    const list = Array.isArray(data.retDataList) ? data.retDataList : []

    const influencers: SearchInfluencer[] = list.map((item) => {
        const r = item as Record<string, unknown>
        return {
            ...r,
            id: String(r.id || ''),
            alias: String(r.alias || ''),
            nickName: String(r.nickName || ''),
            country: String(r.country || ''),
            followers: Number(r.followers) || 0,
            totalVideos: Number(r.totalVideos) || 0,
            noxScore: Number(r.noxScore) || 0,
            interactiveRate: Number(r.interactiveRate) || 0,
            tags: toTags(r.tags),
            estimateVideoPrice: Number(r.estimateVideoPrice) || 0,
            estimateVideoViews: Number(r.estimateVideoViews) || 0,
            viewsFollowers: Number(r.viewsFollowers) || 0,
            followings: Number(r.followings) || 0,
            isCelebrity: r.isCelebrity === true || r.isCelebrity === 1,
            isBrand: r.isBrand === true || r.isBrand === 1,
            ttseller: r.ttseller === true || r.ttseller === 1,
            language: typeof r.language === 'string' ? r.language : '',
        }
    }).filter(inf => inf.id && inf.alias)

    return {
        totalSize: Number(data.totalSize) || 0,
        totalPage: Number(data.totalPage) || 1,
        pageNum: Number(data.pageNum) || pageNum,
        pageSize: Number(data.pageSize) || 100,
        influencers,
        errorNum: Number(data.errorNum)
    }
}
