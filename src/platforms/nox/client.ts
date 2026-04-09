import {zlibSync} from 'fflate'
import type {AudienceGender, AudienceResponse} from './types'

function bytesToBase64(bytes: Uint8Array): string {
    let binary = ''
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize)
        binary += String.fromCharCode(...chunk)
    }
    return btoa(binary)
}

function encodeAudienceParam(channelId: string, subSite = 'cn', t = 1021): string {
    const json = JSON.stringify({channelId, subSite, t})
    const urlEncoded = encodeURIComponent(json)
    const compressed = zlibSync(new TextEncoder().encode(urlEncoded), {level: 9})
    return bytesToBase64(compressed).replace(/=+$/, '')
}

export async function fetchAudienceGender(channelId: string): Promise<AudienceGender> {
    const p = encodeAudienceParam(channelId)
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

    return data.retData.gender
}
