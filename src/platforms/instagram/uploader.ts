import type {HeaderValues} from '../../shared/header-cache'

export interface Mp4Meta {
    width: number
    height: number
    durationSec: number
}

interface VideoEditParams {
    crop_width: number
    crop_height: number
    crop_x1: number
    crop_y1: number
    mute: boolean
    trim_start: number
    trim_end: number
}

interface FetchTextResult {
    status: number
    ok: boolean
    text: string
}

export interface UploadResult {
    ok: boolean
    status: number
    bodySnippet: string
    blobDebug?: {
        size: number
        type: string
    }
    error?: string
}

async function fetchText(url: string, init: RequestInit): Promise<FetchTextResult> {
    const res = await fetch(url, init)
    const text = await res.text()
    return {status: res.status, ok: res.ok, text}
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function getCookieValue(name: string): string {
    const raw = String(document.cookie || '')
    const parts = raw.split(/;\s*/)
    for (const p of parts) {
        const eq = p.indexOf('=')
        if (eq < 0) continue
        const k = p.slice(0, eq)
        if (k === name) return decodeURIComponent(p.slice(eq + 1))
    }
    return ''
}

function generateJazoest(value: string): string {
    const s = String(value || '')
    let amount = 0
    for (let i = 0; i < s.length; i += 1) amount += s.charCodeAt(i)
    return '2' + String(amount)
}

function isTranscodeNotFinished(result: FetchTextResult | null): boolean {
    try {
        if (!result || result.status !== 202) return false
        const text = String(result.text || '')
        const j = JSON.parse(text)
        return (
            j &&
            j.status === 'fail' &&
            typeof j.message === 'string' &&
            j.message.toLowerCase().includes('transcode not finished')
        )
    } catch {
        return false
    }
}

function computeVideoEditParams(meta: Mp4Meta): VideoEditParams {
    const w = Number(meta?.width) || 0
    const h = Number(meta?.height) || 0
    const crop = Math.max(0, Math.min(w, h))
    return {
        crop_width: crop,
        crop_height: crop,
        crop_x1: crop ? Math.max(0, Math.floor((w - crop) / 2)) : 0,
        crop_y1: crop ? Math.max(0, Math.floor((h - crop) / 2)) : 0,
        mute: false,
        trim_start: 0,
        trim_end: Number(meta?.durationSec) || 0
    }
}

export async function captureCoverJpegFromBlob(videoBlob: Blob, meta: Mp4Meta): Promise<ArrayBuffer> {
    const url = URL.createObjectURL(videoBlob)
    try {
        const video = document.createElement('video')
        video.preload = 'auto'
        video.muted = true
        video.playsInline = true
        video.src = url

        await new Promise<void>((resolve, reject) => {
            video.addEventListener('loadeddata', () => resolve(), {once: true})
            video.addEventListener('error', () => reject(new Error('video load error')), {once: true})
        })

        const duration = Number(meta?.durationSec) || Number(video.duration) || 0
        const minT = Math.max(0, Math.min(duration, Math.max(1, duration * 0.15)))
        const maxT = Math.max(minT, Math.min(duration, duration * 0.85))
        const t = minT + Math.random() * (maxT - minT)
        try {
            video.currentTime = t
        } catch {
        }
        await new Promise<void>((resolve) => {
            video.addEventListener('seeked', () => resolve(), {once: true})
            setTimeout(resolve, 800)
        })

        const vw = Number(meta?.width) || Number(video.videoWidth) || 0
        const vh = Number(meta?.height) || Number(video.videoHeight) || 0
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, vw)
        canvas.height = Math.max(1, vh)
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('canvas ctx missing')
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

        const quality = 0.85 + Math.random() * 0.12
        const jpg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
        if (!jpg) throw new Error('cover toBlob failed')
        return await jpg.arrayBuffer()
    } finally {
        URL.revokeObjectURL(url)
    }
}

export async function ruploadIgvideo(config: {
    uploadId: string
    meta: Mp4Meta
    videoBlob: Blob
    headersCaptured: HeaderValues
}): Promise<{ uploadId: string; uploadName: string }> {
    const {uploadId, meta, videoBlob, headersCaptured} = config
    const uploadName = `fb_uploader_${uploadId}`

    const ruploadParams = {
        'client-passthrough': '1',
        is_clips_video: '1',
        is_sidecar: '0',
        media_type: 2,
        for_album: false,
        video_format: '',
        upload_id: String(uploadId),
        upload_media_duration_ms: Math.round((Number(meta?.durationSec) || 0) * 1000),
        upload_media_width: Number(meta?.width) || 0,
        upload_media_height: Number(meta?.height) || 0,
        video_transform: null,
        video_edit_params: computeVideoEditParams(meta)
    }

    const url = `https://i.instagram.com/rupload_igvideo/${uploadName}`

    const initHeaders: Record<string, string> = {
        'x-ig-app-id': '936619743392459',
        'x-asbd-id': '359341',
        'x-web-session-id': String(headersCaptured.webSid || '')
    }
    const init = await fetchText(url, {
        method: 'GET',
        credentials: 'include',
        headers: initHeaders
    })
    if (!init.ok) {
        throw new Error(`rupload init failed: ${init.status} - ${init.text}`)
    }

    const len = String(videoBlob.size)
    const upHeaders: Record<string, string> = {
        'x-ig-app-id': '936619743392459',
        'x-asbd-id': '359341',
        'x-web-session-id': String(headersCaptured.webSid || ''),
        'x-instagram-ajax': String(headersCaptured.ajax || ''),
        'x-instagram-rupload-params': JSON.stringify(ruploadParams),
        'x-entity-name': uploadName,
        'x-entity-length': len,
        'offset': '0'
    }
    const up = await fetchText(url, {
        method: 'POST',
        credentials: 'include',
        headers: upHeaders,
        body: videoBlob
    })
    if (!up.ok) {
        throw new Error(`rupload upload failed: ${up.status} - ${up.text}`)
    }

    return {uploadId, uploadName}
}

export async function ruploadIgphoto(config: {
    uploadId: string
    meta: Mp4Meta
    coverBytes: ArrayBuffer
    headersCaptured: HeaderValues
}): Promise<{ status: number }> {
    const {uploadId, meta, coverBytes, headersCaptured} = config
    const uploadName = `fb_uploader_${uploadId}`
    const ruploadParams = {
        media_type: 2,
        upload_id: String(uploadId),
        upload_media_height: Number(meta?.height) || 0,
        upload_media_width: Number(meta?.width) || 0
    }

    const body = new Uint8Array(coverBytes)
    const len = String(body.byteLength)
    const url = `https://i.instagram.com/rupload_igphoto/${uploadName}`

    const headers: Record<string, string> = {
        'x-ig-app-id': '936619743392459',
        'x-asbd-id': '359341',
        'x-web-session-id': String(headersCaptured.webSid || ''),
        'x-instagram-ajax': String(headersCaptured.ajax || ''),
        'x-instagram-rupload-params': JSON.stringify(ruploadParams),
        'x-entity-name': uploadName,
        'x-entity-length': len,
        'x-entity-type': 'image/jpeg',
        'offset': '0',
        'content-type': 'image/jpeg'
    }
    const res = await fetchText(url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body
    })
    if (!res.ok) throw new Error(`rupload cover failed: ${res.status}`)
    return {status: res.status}
}

export async function configureToClips(config: {
    uploadId: string
    caption: string
    headersCaptured: HeaderValues
}): Promise<FetchTextResult> {
    const {uploadId, caption, headersCaptured} = config
    const csrftoken = getCookieValue('csrftoken')
    if (!csrftoken) throw new Error('missing csrftoken cookie')

    await sleep(5000)

    const form = new URLSearchParams()
    form.set('archive_only', 'false')
    form.set('caption', caption || '')
    form.set('clips_share_preview_to_feed', '1')
    form.set('disable_comments', '0')
    form.set('disable_oa_reuse', 'false')
    form.set('igtv_share_preview_to_feed', '1')
    form.set('is_meta_only_post', '0')
    form.set('is_unified_video', '1')
    form.set('like_and_view_counts_disabled', '0')
    form.set('media_share_flow', 'creation_flow')
    form.set('share_to_facebook', '')
    form.set('source_type', 'library')
    form.set('upload_id', String(uploadId))
    form.set('video_subtitles_enabled', '0')
    form.set('jazoest', generateJazoest(csrftoken))

    const headers: Record<string, string> = {
        'accept': '*/*',
        'content-type': 'application/x-www-form-urlencoded',
        'x-ig-app-id': '936619743392459',
        'x-asbd-id': '359341',
        'x-web-session-id': String(headersCaptured.webSid || ''),
        'x-instagram-ajax': String(headersCaptured.ajax || ''),
        'x-ig-www-claim': String(headersCaptured.claim || '0'),
        'x-csrftoken': String(csrftoken),
        'x-requested-with': 'XMLHttpRequest'
    }

    return await fetchText('https://www.instagram.com/api/v1/media/configure_to_clips/', {
        method: 'POST',
        headers,
        body: form.toString()
    })
}

export async function executeUpload(
    videoBlob: Blob,
    meta: Mp4Meta,
    caption: string,
    headersCaptured: HeaderValues
): Promise<UploadResult> {
    const uploadId = String(Date.now())

    await ruploadIgvideo({uploadId, meta, videoBlob, headersCaptured})

    const coverBytes = await captureCoverJpegFromBlob(videoBlob, meta)
    await ruploadIgphoto({uploadId, meta, coverBytes, headersCaptured})

    let result: FetchTextResult | null = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        result = await configureToClips({uploadId, caption, headersCaptured})
        if (!isTranscodeNotFinished(result)) break
        if (attempt < 3) {
            await sleep(5000)
        }
    }

    const publishOk = Boolean(result?.ok) && !isTranscodeNotFinished(result)

    return {
        ok: publishOk,
        status: result?.status || 0,
        bodySnippet: result?.text || '',
        blobDebug: {size: videoBlob.size, type: videoBlob.type}
    }
}
