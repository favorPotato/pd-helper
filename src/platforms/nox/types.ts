export type InfluencerPlatform = 'tiktok' | 'instagram'

export type InfluencerStatus = 'unused' | 'used' | 'failed'

export interface NoxInfluencer {
    channelId: string
    platform: InfluencerPlatform
    username: string
    name: string
    country?: string
    genderTag: string
    femaleRatio: number
    maleRatio: number
    status?: InfluencerStatus
    followers?: number
    totalVideos?: number
    noxScore?: number
    archivedVideoCount?: number
    qualifyingRate?: number
    postRate?: number
    lastError?: string
    extraData?: string
    createdAt?: string
    updatedAt?: string
}

export interface AudienceProfile {
    regions: Record<string, number>
    language: Record<string, number>
    gender: {female: number; male: number}
    maleAge: Record<string, number>
    femaleAge: Record<string, number>
    adults: number
    topRegion: string
    topGender: string
    topAge: string
}

export interface AudienceResponse {
    errorNum: number
    retData: {
        gender: {female: number; male: number}
        regions?: Record<string, number>
        language?: Record<string, number>
        maleAge?: Record<string, number>
        femaleAge?: Record<string, number>
        adults?: number
        topRegion?: string
        topGender?: string
        topAge?: string
        [key: string]: unknown
    }
}
