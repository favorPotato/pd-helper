import {VideoHelper} from './helpers'
import {fetchBinary, fetchHead, fetchHtml} from './client'
import type {DownloadedVideo} from './types'

const QUALITY_SCORE: Record<string, number> = {'1080p': 4, '720p': 3, '540p': 2, '360p': 1}

const MAX_TOP_KEYS = 50
const MAX_SCAN_NODES = 50_000
const MAX_SCAN_DEPTH = 60

type AnyObject = Record<string, unknown>

function formatTopKeys(obj: unknown): string {
    const keys = obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj as AnyObject) : []
    const sliced = keys.slice(0, MAX_TOP_KEYS)
    const tail = keys.length > MAX_TOP_KEYS ? ',...' : ''
    return `[${sliced.join(',')}${tail}]`
}

function extractScriptContentByDefaultScope(html: string): string | null {
    const keyIndex = html.indexOf('__DEFAULT_SCOPE__')
    if (keyIndex === -1) return null
    let start = html.lastIndexOf('<script', keyIndex)
    if (start === -1) return null
    start = html.indexOf('>', start) + 1
    const endTag = ['<', '/', 'script', '>'].join('')
    const end = html.indexOf(endTag, keyIndex)
    if (end === -1) return null
    return html.substring(start, end)
}

function extractScriptContentById(html: string, id: string): string | null {
    const needles = [`id="${id}"`, `id='${id}'`]
    let idx = -1
    for (const n of needles) {
        idx = html.indexOf(n)
        if (idx !== -1) break
    }
    if (idx === -1) return null
    let start = html.lastIndexOf('<script', idx)
    if (start === -1) return null
    start = html.indexOf('>', start) + 1
    const endTag = ['<', '/', 'script', '>'].join('')
    const end = html.indexOf(endTag, start)
    if (end === -1) return null
    return html.substring(start, end)
}

function extractAssignedObject(html: string, marker: string): string | null {
    const pos0 = html.indexOf(marker)
    if (pos0 === -1) return null
    let pos = pos0 + marker.length
    while (pos < html.length && /\s/.test(html[pos])) pos += 1
    const objStart = html.indexOf('{', pos)
    if (objStart === -1) return null

    let brace = 0
    let inString = false
    let quote = ''
    let escaped = false
    for (let i = objStart; i < html.length; i += 1) {
        const ch = html[i]
        if (inString) {
            if (escaped) {
                escaped = false
                continue
            }
            if (ch === '\\') {
                escaped = true
                continue
            }
            if (ch === quote) {
                inString = false
                quote = ''
            }
            continue
        }

        if (ch === '"' || ch === "'") {
            inString = true
            quote = ch
            continue
        }
        if (ch === '{') brace += 1
        if (ch === '}') {
            brace -= 1
            if (brace === 0) return html.substring(objStart, i + 1)
        }
    }

    return null
}

function parseResolution(gearName: string): string {
    const match = gearName.match(/_(\d+)_/)
    return match ? match[1] + 'p' : '0p'
}

function isValidHost(url: string): boolean {
    try {
        return new URL(url).hostname !== 'www.tiktok.com'
    } catch {
        return false
    }
}

interface BitrateInfo {
    GearName: string
    Bitrate?: number
    PlayAddr?: { UrlList?: string[] }
}

export interface DownloadCandidate {
    resolution: string
    score: number
    bitrate: number
    url: string
}

function asObject(v: unknown): AnyObject | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    return v as AnyObject
}

function getVideoIdFromPageUrl(pageUrl: string): string {
    const pathname = new URL(pageUrl, window.location.origin).pathname
    const m = pathname.match(/\/video\/(\d+)/)
    if (!m) throw new Error('parse_error:missing_video_detail')
    return m[1]
}

function extractUrlsFromNode(node: unknown): string[] {
    const o = asObject(node)
    if (!o) return []

    const video = asObject((o as any).video) || o

    const urls: unknown[] = []
    const play = (video as any)?.playAddr?.UrlList
    const download = (video as any)?.downloadAddr?.UrlList
    if (Array.isArray(play)) urls.push(...play)
    if (Array.isArray(download)) urls.push(...download)

    return urls.filter((u): u is string => typeof u === 'string' && isValidHost(u))
}

function extractBitrateInfoFromNode(node: unknown): BitrateInfo[] | null {
    const o = asObject(node)
    if (!o) return null

    const candidates: unknown[] = [
        (o as any)?.video?.bitrateInfo,
        (o as any)?.bitrateInfo,
        (o as any)?.itemInfo?.itemStruct?.video?.bitrateInfo
    ]

    for (const c of candidates) {
        if (!Array.isArray(c)) continue
        const ok = c.some((x) => {
            const xo = asObject(x)
            const urlList = (xo as any)?.PlayAddr?.UrlList
            return Array.isArray(urlList) && urlList.some((u) => typeof u === 'string' && isValidHost(u))
        })
        if (ok) return c as BitrateInfo[]
    }
    return null
}

function findVideoNodeByVideoId(root: unknown, videoId: string): { node: unknown | null; sawCandidate: boolean } {
    const queue: Array<{ node: unknown; depth: number }> = [{node: root, depth: 0}]
    const visited = new WeakSet<object>()
    let visitedCount = 0
    let sawCandidate = false

    while (queue.length > 0) {
        const cur = queue.shift()!
        const node = cur.node
        const depth = cur.depth
        if (depth > MAX_SCAN_DEPTH) continue

        visitedCount += 1
        if (visitedCount > MAX_SCAN_NODES) throw new Error('parse_error:scan_limit_exceeded')

        if (!node) continue

        if (typeof node === 'object') {
            if (visited.has(node as object)) continue
            visited.add(node as object)
        }

        if (Array.isArray(node)) {
            for (const child of node) queue.push({node: child, depth: depth + 1})
            continue
        }

        const o = asObject(node)
        if (!o) continue

        const id = String((o as any).id || '')
        const itemStructId = String((o as any)?.itemStruct?.id || '')
        if (id === videoId || itemStructId === videoId) {
            sawCandidate = true
            const b = extractBitrateInfoFromNode(o)
            const urls = extractUrlsFromNode(o)
            if (b || urls.length > 0) return {node: o, sawCandidate}
        }

        if (Object.prototype.hasOwnProperty.call(o, videoId)) {
            sawCandidate = true
            const hit = (o as any)[videoId]
            const b = extractBitrateInfoFromNode(hit)
            const urls = extractUrlsFromNode(hit)
            if (b || urls.length > 0) return {node: hit, sawCandidate}
            queue.push({node: hit, depth: depth + 1})
        }

        for (const v of Object.values(o)) queue.push({node: v, depth: depth + 1})
    }

    return {node: null, sawCandidate}
}

function buildCandidatesFromNode(node: unknown): DownloadCandidate[] {
    const bitrateInfo = extractBitrateInfoFromNode(node)
    if (!bitrateInfo) {
        const urls = extractUrlsFromNode(node)
        return urls.map((url) => ({resolution: '0p', score: 0, bitrate: 0, url}))
    }

    const candidates: DownloadCandidate[] = []
    bitrateInfo.forEach((info: BitrateInfo) => {
        const resolution = parseResolution(info.GearName)
        const urls = (info.PlayAddr?.UrlList || []).filter(isValidHost)
        urls.forEach((url: string) => {
            candidates.push({
                resolution,
                score: QUALITY_SCORE[resolution] || 0,
                bitrate: info.Bitrate || 0,
                url
            })
        })
    })
    return candidates
}

function sortAndDeduplicateCandidates(candidates: DownloadCandidate[]): DownloadCandidate[] {
    const unique = new Map<string, DownloadCandidate>()
    for (const candidate of candidates) {
        const existing = unique.get(candidate.url)
        if (!existing) {
            unique.set(candidate.url, candidate)
            continue
        }

        if (candidate.score > existing.score || (candidate.score === existing.score && candidate.bitrate > existing.bitrate)) {
            unique.set(candidate.url, candidate)
        }
    }

    return Array.from(unique.values()).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return b.bitrate - a.bitrate
    })
}

export function getDownloadCandidatesFromItem(item: unknown): DownloadCandidate[] {
    return buildCandidatesFromNode(item)
}

function parseContainerJson(container: string, jsonText: string, videoId: string): {
    candidates: DownloadCandidate[];
    topKeys: string
} {
    const root = JSON.parse(jsonText)
    const topKeysObj =
        container === 'DEFAULT_SCOPE' ? (root as any)?.['__DEFAULT_SCOPE__'] : root
    const topKeys = formatTopKeys(topKeysObj)

    const {node, sawCandidate} = findVideoNodeByVideoId(root, videoId)
    if (!node) {
        if (sawCandidate) {
            throw new Error(`parse_error:no_bitrateInfo_and_no_playAddr container=${container} videoId=${videoId} topKeys=${topKeys}`)
        }
        throw new Error(`parse_error:unexpected_container_shape container=${container} videoId=${videoId} topKeys=${topKeys}`)
    }

    const candidates = buildCandidatesFromNode(node)
    if (candidates.length === 0) {
        throw new Error(`parse_error:no_bitrateInfo_and_no_playAddr container=${container} videoId=${videoId} topKeys=${topKeys}`)
    }

    return {candidates, topKeys}
}

export class Downloader {
    private static async downloadFromCandidates(candidates: DownloadCandidate[], filename: string, referrer?: string): Promise<DownloadedVideo> {
        for (const candidate of sortAndDeduplicateCandidates(candidates)) {
            try {
                const testRes = await fetchHead(candidate.url, referrer)

                const contentType = testRes.headers.get('content-type') || ''
                const contentLength = parseInt(testRes.headers.get('content-length') || '0')
                const isVideo = contentType.includes('video/')
                const hasSize = contentLength > 10000

                if (testRes.status === 200 && isVideo && hasSize) {
                    const binary = await fetchBinary(candidate.url, referrer)
                    const videoBytes = binary.bytes
                    const meta = VideoHelper.parseMp4Meta(videoBytes)

                    return {
                        bytes: videoBytes,
                        mime: binary.contentType || contentType || 'video/mp4',
                        name: filename,
                        meta
                    }
                }
            } catch (error) {
                console.warn('视频地址探测失败:', error)
            }
        }

        throw new Error('parse_error:all_video_urls_failed')
    }

    private static async downloadFromPage(pageUrl: string, videoId: string, filename: string): Promise<DownloadedVideo> {

        let html = ''
        try {
            html = await fetchHtml(pageUrl)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const statusMatch = message.match(/请求失败: (\d+)/)
            if (statusMatch) {
                throw new Error(`parse_error:http_status status=${statusMatch[1]}`)
            }
            throw error
        }
        const attempts: Array<{ container: string; getText: () => string | null }> = [
            {
                container: 'DEFAULT_SCOPE',
                getText: () => extractScriptContentByDefaultScope(html)
            },
            {
                container: 'UNIVERSAL_DATA',
                getText: () =>
                    extractScriptContentById(html, '__UNIVERSAL_DATA_FOR_VAR__') ||
                    extractScriptContentById(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__')
            },
            {container: 'SIGI_STATE', getText: () => extractScriptContentById(html, 'SIGI_STATE')},
            {
                container: 'ASSIGNMENT',
                getText: () =>
                    extractAssignedObject(html, "window['SIGI_STATE']=") ||
                    extractAssignedObject(html, 'window.SIGI_STATE=') ||
                    extractAssignedObject(html, 'window.__UNIVERSAL_DATA_FOR_VAR__=') ||
                    extractAssignedObject(html, 'window.__UNIVERSAL_DATA_FOR_REHYDRATION__=')
            }
        ]

        let anyContainerSeen = false
        let candidates: DownloadCandidate[] = []

        for (const a of attempts) {
            const raw = a.getText()
            if (!raw) continue
            anyContainerSeen = true
            try {
                const parsed = parseContainerJson(a.container, raw, videoId)
                candidates = parsed.candidates
                break
            } catch (e) {
                // JSON parse failures should allow fallback; container-shape errors should be thrown.
                const msg = String(e instanceof Error ? e.message : e)
                if (msg.includes('Unexpected') || msg.includes('JSON')) {
                    continue
                }
                throw e
            }
        }

        if (candidates.length === 0) {
            if (anyContainerSeen) {
                throw new Error('parse_error:no_video_candidates_from_container')
            }
            throw new Error('parse_error:no_known_container')
        }

        return await Downloader.downloadFromCandidates(candidates, filename, pageUrl)
    }

    public static async downloadTikTokVideo(): Promise<DownloadedVideo> {
        const pageUrl = window.location.href
        const videoId = getVideoIdFromPageUrl(pageUrl)
        return await Downloader.downloadFromPage(pageUrl, videoId, `tiktok_${Date.now()}.mp4`)
    }

    public static async downloadTikTokVideoByCandidates(candidates: DownloadCandidate[], referrer: string, filename?: string): Promise<DownloadedVideo> {
        return await Downloader.downloadFromCandidates(candidates, filename || `tiktok_${Date.now()}.mp4`, referrer)
    }
}
