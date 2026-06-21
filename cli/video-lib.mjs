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

// 列 raws/<platform>/ 下所有 <videoId>.json 的 videoId（去 .json 后缀）。
// 作为 detail 续采的「node 端已落盘事实」基准，目录不存在（首跑）返回空数组。
export function listRawVideoIds(libRoot, platform) {
    assertPlatform(platform)
    const dir = join(libRoot, 'raws', platform)
    if (!existsSync(dir)) return []
    const ids = []
    for (const name of readdirSync(dir)) {
        if (name.endsWith('.json')) ids.push(name.slice(0, -5))
    }
    return ids
}

// 单一存在性判定规则：文件名 === videoId 或以 `${videoId}.` 开头。
// videoExists 与 scanVideoIdSet 共用此函数，避免两份手抄判定漂移。
function videoFileMatches(name, videoId) {
    return name === videoId || name.startsWith(`${videoId}.`)
}

export function videoExists(libRoot, videoId) {
    assertVideoId(videoId)
    const dir = join(libRoot, 'videos')
    if (!existsSync(dir)) return false
    for (const name of readdirSync(dir)) {
        if (videoFileMatches(name, videoId)) return true
    }
    return false
}

// 预扫 videos/ 一次把已存在 videoId 收成 Set，供批量去重 O(1) 命中（替代逐条全目录扫描）。
// 判存语义与 videoExists 一致：每个文件名拆出所有「点号前缀」+ 全名，任一等于待查 id 即视为已存在
// （覆盖 `${id}.ext` 前缀匹配，且 id 自身可含点）。目录不存在（首跑）返回空 Set。
export function scanVideoIdSet(libRoot) {
    const set = new Set()
    const dir = join(libRoot, 'videos')
    if (!existsSync(dir)) return set
    for (const name of readdirSync(dir)) {
        set.add(name)
        let dot = name.indexOf('.')
        while (dot !== -1) {
            set.add(name.slice(0, dot))
            dot = name.indexOf('.', dot + 1)
        }
    }
    return set
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
    // 单次扫描：downloadDir 根目录下若已有完成（无 .crdownload）的同 id 文件即归位。
    const tryMove = () => {
        const names = existsSync(downloadDir) ? readdirSync(downloadDir) : []
        const matched = names.filter((n) => n === videoId || n.startsWith(prefix))
        const downloading = matched.some((n) => n.endsWith('.crdownload'))
        const done = matched.find((n) => !n.endsWith('.crdownload'))
        if (done && !downloading) {
            renameSync(join(downloadDir, done), join(videosDir, done))
            return {moved: true, name: done}
        }
        return null
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const r = tryMove()
        if (r) return r
        await sleep(pollMs)
    }
    // deadline 到点前的最后一段 sleep 内下载可能刚好完成（无 .crdownload 却仍滞留根目录），
    // 退出前补扫一次归位，使已下完的视频不因超时被判 missing 而重跑重下。
    const last = tryMove()
    if (last) return last
    return {moved: false}
}
