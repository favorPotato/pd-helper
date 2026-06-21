import {existsSync, mkdirSync, readdirSync, renameSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {sleep} from './io.mjs'

const PLATFORMS = new Set(['exolyt', 'tiktok'])

function assertPlatform(platform) {
    if (!PLATFORMS.has(platform)) {
        throw new Error(`invalid platform: ${platform} (expected 'exolyt' | 'tiktok')`)
    }
}

function assertVideoId(videoId) {
    if (typeof videoId !== 'string' || videoId === '') {
        throw new Error(`invalid videoId: ${videoId} (expected non-empty string)`)
    }
    if (videoId.includes('/') || videoId.includes('\\') || videoId.includes('..')) {
        throw new Error(`invalid videoId: ${videoId} (path traversal not allowed)`)
    }
}

export function ensureVideoLibDirs(libRoot) {
    mkdirSync(join(libRoot, 'raws', 'exolyt'), {recursive: true})
    mkdirSync(join(libRoot, 'raws', 'tiktok'), {recursive: true})
    mkdirSync(join(libRoot, 'videos'), {recursive: true})
}

export function rawPath(libRoot, platform, videoId) {
    assertPlatform(platform)
    assertVideoId(videoId)
    return resolve(libRoot, 'raws', platform, `${videoId}.json`)
}

export function rawExists(libRoot, platform, videoId) {
    return existsSync(rawPath(libRoot, platform, videoId))
}

export function videoExists(libRoot, videoId) {
    assertVideoId(videoId)
    const dir = join(libRoot, 'videos')
    if (!existsSync(dir)) return false
    const prefix = `${videoId}.`
    for (const name of readdirSync(dir)) {
        if (name === videoId || name.startsWith(prefix)) return true
    }
    return false
}

// 默认权限落盘（不 chmod）；已存在则跳过 = 存在性补采
export function writeRawJson(libRoot, platform, videoId, obj) {
    const path = rawPath(libRoot, platform, videoId)
    if (existsSync(path)) {
        return {written: false, skipped: true}
    }
    writeFileSync(path, JSON.stringify(obj, null, 2))
    return {written: true, skipped: false}
}

// 视频经浏览器 anchor 下载落「下载目录」(downloadDir，平铺、文件名由扩展定，不支持子目录)。
// 等下载完成（出现 {videoId}.* 且无 .crdownload 临时文件）后 mv 进 <libRoot>/videos/，保持默认权限。
// best-effort：超时未见文件返回 {moved:false}，不阻断流程。
export async function moveVideoIntoLib(downloadDir, libRoot, videoId, opts = {}) {
    assertVideoId(videoId)
    const timeoutMs = opts.timeoutMs || 30000
    const pollMs = opts.pollMs || 500
    const prefix = `${videoId}.`
    const videosDir = join(libRoot, 'videos')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const names = existsSync(downloadDir) ? readdirSync(downloadDir) : []
        const matched = names.filter((n) => n === videoId || n.startsWith(prefix))
        const downloading = matched.some((n) => n.endsWith('.crdownload'))
        const done = matched.find((n) => !n.endsWith('.crdownload'))
        if (done && !downloading) {
            renameSync(join(downloadDir, done), join(videosDir, done))
            return {moved: true, name: done}
        }
        await sleep(pollMs)
    }
    return {moved: false}
}
