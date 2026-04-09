export interface NoxInfluencer {
    channelId: string
    tiktokUsername: string
    name: string
    genderTag: string
    femaleRatio: number
    maleRatio: number
}

export interface AudienceGender {
    female: number
    male: number
}

export interface AudienceResponse {
    errorNum: number
    retData: {
        gender: AudienceGender
        [key: string]: unknown
    }
}
