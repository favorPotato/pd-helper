import {formatExtraData} from '../../shared/sheets-schema'

import type {SearchInfluencer} from './search-api'
import type {AudienceProfile} from './types'

const AGE_BUCKET_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+']

export type SearchExtra = Partial<Pick<
    SearchInfluencer,
    | 'interactiveRate'
    | 'tags'
    | 'estimateVideoPrice'
    | 'estimateVideoViews'
    | 'viewsFollowers'
    | 'followings'
    | 'isCelebrity'
    | 'isBrand'
    | 'ttseller'
    | 'language'
>>

export function classifyGender(femaleRatio: number, maleRatio: number): string {
    if (femaleRatio >= 0.70) return 'FF-'
    if (femaleRatio >= 0.55) return 'F-'
    if (maleRatio >= 0.70) return 'MM-'
    if (maleRatio >= 0.55) return 'M-'
    return 'N-'
}

export function extractSearchExtra(inf: SearchInfluencer): SearchExtra {
    return {
        interactiveRate: inf.interactiveRate,
        tags: inf.tags,
        estimateVideoPrice: inf.estimateVideoPrice,
        estimateVideoViews: inf.estimateVideoViews,
        viewsFollowers: inf.viewsFollowers,
        followings: inf.followings,
        isCelebrity: inf.isCelebrity,
        isBrand: inf.isBrand,
        ttseller: inf.ttseller,
        language: inf.language,
    }
}

function formatPercent(value: number, digits = 2): string {
    if (!Number.isFinite(value)) return ''
    return `${(value * 100).toFixed(digits)}%`
}

function formatNumber(value: unknown): string {
    const num = Number(value)
    if (!Number.isFinite(num)) return ''
    return String(num)
}

function boolLabel(value: boolean): string {
    return value ? '是' : '否'
}

function pickPrimaryLanguage(language: Record<string, number> | undefined): string {
    if (!language) return ''
    return Object.entries(language)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || ''
}

function formatRegions(regions: Record<string, number> | undefined): string {
    if (!regions) return ''
    return Object.entries(regions)
        .sort((a, b) => b[1] - a[1])
        .map(([key, value]) => `${key} ${formatPercent(value, 1)}`)
        .join(', ')
}

function formatAgeDistribution(ages: Record<string, number> | undefined): string {
    if (!ages) return ''
    return AGE_BUCKET_ORDER
        .filter((bucket) => ages[bucket] !== undefined)
        .map((bucket) => `${bucket} ${formatPercent(ages[bucket] || 0, 1)}`)
        .join(', ')
}

export function buildExtraDataFromProfile(profile: AudienceProfile, searchExtra: SearchExtra = {}): string {
    const interactiveRate = Number(searchExtra.interactiveRate) || 0
    const tags = Array.isArray(searchExtra.tags) ? searchExtra.tags.slice(0, 5).join(', ') : ''
    const estimateVideoPrice = Number(searchExtra.estimateVideoPrice) || 0
    const estimateVideoViews = Number(searchExtra.estimateVideoViews) || 0
    const viewsFollowers = Number(searchExtra.viewsFollowers) || 0
    const followings = Number(searchExtra.followings) || 0
    const audienceLang = pickPrimaryLanguage(profile.language)

    return formatExtraData({
        femaleRatio: formatPercent(profile.gender.female),
        topRegion: profile.topRegion,
        topAgeRange: profile.topAge,
        interactiveRate: formatPercent(interactiveRate),
        tags,
        estimateVideoPrice: estimateVideoPrice ? `${estimateVideoPrice} USD` : '',
        estimateVideoViews: formatNumber(estimateVideoViews),
        viewsFollowers: formatNumber(viewsFollowers),
        followings: formatNumber(followings),
        isCelebrity: searchExtra.isCelebrity === undefined ? '' : boolLabel(searchExtra.isCelebrity),
        isBrand: searchExtra.isBrand === undefined ? '' : boolLabel(searchExtra.isBrand),
        ttseller: searchExtra.ttseller === undefined ? '' : boolLabel(searchExtra.ttseller),
        language: audienceLang || searchExtra.language || '',
        topGender: profile.topGender,
        regions: formatRegions(profile.regions),
        maleAge: formatAgeDistribution(profile.maleAge),
        femaleAge: formatAgeDistribution(profile.femaleAge),
    })
}
