import {
    TIKTOK_MAX_VIDEO_DURATION,
    TIKTOK_MIN_COMMENT_COUNT,
    TIKTOK_MIN_LIKE_RATE,
    TIKTOK_MIN_PLAY_COUNT
} from '../../shared/env'
import {
    createJsonArchiveFile,
    createTextArchiveFile,
    createZipBlob,
    downloadBlob,
    formatTimestampForFilename,
    type ArchiveFile
} from '../../shared/archive'
import {truncateError} from '../../shared/errors'
import {sleepRandom} from '../../shared/timing'
import {Downloader, getDownloadCandidatesFromItem, type DownloadCandidate} from './downloader'
import type {CommentPageResponse, RequestEnv} from './client'
import {fetchCommentPage, fetchHotVideoPage, fetchHtml} from './client'
import type {TikTokComment, TikTokCommentSummary, TikTokProfileCollection, TikTokUser, TikTokVideo} from './types'
import {UrlHelper} from './helpers'

type AnyObject = Record<string, unknown>

interface DownloadSummary {
    attempted: number
    succeeded: number
    failed: number
    failedVideoIds: string[]
}

interface DownloadedArchiveVideo {
    file: ArchiveFile
}

interface CollectedVideo extends TikTokVideo {
    downloadCandidates: DownloadCandidate[]
}

type CollectLogFn = (message: string) => void | Promise<void>

async function emitCollectLog(logger: CollectLogFn | undefined, message: string): Promise<void> {
    if (!logger) return
    await logger(message)
}

function asObject(value: unknown): AnyObject | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as AnyObject
}

function extractScriptContentById(html: string, id: string): string | null {
    const needles = [`id="${id}"`, `id='${id}'`]
    let idx = -1
    for (const needle of needles) {
        idx = html.indexOf(needle)
        if (idx !== -1) break
    }
    if (idx === -1) return null
    let start = html.lastIndexOf('<script', idx)
    if (start === -1) return null
    start = html.indexOf('>', start) + 1
    const end = html.indexOf('</script>', start)
    if (end === -1) return null
    return html.substring(start, end)
}

function walkJson(root: unknown, visitor: (value: unknown) => void): void {
    const stack: unknown[] = [root]
    while (stack.length > 0) {
        const value = stack.pop()
        visitor(value)
        if (!value || typeof value !== 'object') continue
        if (Array.isArray(value)) {
            for (let i = value.length - 1; i >= 0; i -= 1) stack.push(value[i])
            continue
        }
        const obj = value as AnyObject
        const keys = Object.keys(obj)
        for (let i = keys.length - 1; i >= 0; i -= 1) stack.push(obj[keys[i]])
    }
}

function toNumber(value: unknown): number {
    const num = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(num) ? num : 0
}

function findSecUidCandidates(jsonData: unknown): Array<{ secUid: string; uniqueId: string }> {
    const candidates: Array<{ secUid: string; uniqueId: string }> = []
    walkJson(jsonData, (node) => {
        const obj = asObject(node)
        if (!obj) return
        const secUid = typeof obj.secUid === 'string' ? obj.secUid.trim() : ''
        if (!secUid) return
        const uniqueId = typeof obj.uniqueId === 'string' ? obj.uniqueId.trim() : ''
        candidates.push({secUid, uniqueId})
    })
    return candidates
}

function pickSecUid(candidates: Array<{ secUid: string; uniqueId: string }>, username: string): string {
    if (candidates.length === 0) {
        throw new Error('未找到 secUid')
    }
    const exact = candidates.filter((candidate) => candidate.uniqueId.toLowerCase() === username.toLowerCase())
    if (exact.length === 1) return exact[0].secUid
    if (exact.length > 1) throw new Error('匹配 uniqueId 的 secUid 存在多个候选')

    const uniqueValues = Array.from(new Set(candidates.map((candidate) => candidate.secUid)))
    if (uniqueValues.length !== 1) {
        throw new Error('secUid 候选不唯一')
    }
    return uniqueValues[0]
}

function buildRequestEnv(jsonData: unknown, usernameFromUrl: string, secUid: string): {
    user: TikTokUser;
    requestEnv: RequestEnv
} {
    const root = asObject(jsonData) || {}
    const scope = asObject(root.__DEFAULT_SCOPE__) || {}
    const appContext = asObject(scope['webapp.app-context']) || {}
    const userDetail = asObject(scope['webapp.user-detail']) || {}
    const userInfo = asObject(userDetail.userInfo) || {}
    const user = asObject(userInfo.user) || {}
    const statsV2 = asObject(userInfo.statsV2) || {}

    const output: TikTokUser = {
        userId: String(user.id || ''),
        secUid: String(secUid || ''),
        username: String(user.uniqueId || usernameFromUrl || ''),
        nickname: String(user.nickname || ''),
        signature: String(user.signature || ''),
        avatarUrl: String(user.avatarMedium || ''),
        verified: user.verified === true,
        privateAccount: user.privateAccount === true,
        secret: user.secret === true,
        language: String(user.language || ''),
        signupAt: toNumber(user.createTime),
        followerCount: toNumber(statsV2.followerCount),
        followingCount: toNumber(statsV2.followingCount),
        heartCount: toNumber(statsV2.heartCount || statsV2.heart),
        videoCount: toNumber(statsV2.videoCount),
        diggCount: toNumber(statsV2.diggCount),
        friendCount: toNumber(statsV2.friendCount)
    }

    const requestEnv: RequestEnv = {
        appLanguage: String(appContext.language || ''),
        browserLanguage: String(navigator.language || ''),
        deviceId: String(appContext.wid || '7605966330110543378'),
        region: String(appContext.region || '')
    }

    return {user: output, requestEnv}
}

function extractHashtags(item: AnyObject): string[] {
    const tags: string[] = []
    const seen = new Set<string>()
    const add = (value: unknown) => {
        const tag = typeof value === 'string' ? value.trim() : ''
        if (!tag || seen.has(tag)) return
        seen.add(tag)
        tags.push(tag)
    }

    const textExtra = Array.isArray(item.textExtra) ? item.textExtra : []
    for (const entry of textExtra) {
        const obj = asObject(entry)
        if (!obj) continue
        if (toNumber(obj.type) !== 1) continue
        add(obj.hashtagName)
    }

    if (tags.length > 0) return tags

    const challenges = Array.isArray(item.challenges) ? item.challenges : []
    for (const challenge of challenges) {
        const obj = asObject(challenge)
        if (!obj) continue
        add(obj.title)
    }

    return tags
}

function extractDescAndHashtags(rawDesc: unknown, item: AnyObject): { desc: string; hashtags: string[] } {
    const desc = String(rawDesc || '').trim()
    const hashtags = extractHashtags(item)
    const seen = new Set<string>(hashtags.map((tag) => tag.toLowerCase()))
    const tagsFromDesc: string[] = []

    const cleanedDesc = desc
        .replace(/(^|\s)#([\p{L}\p{M}\p{N}_]+)/gu, (_match, leading: string, tag: string) => {
            const normalized = tag.trim()
            const key = normalized.toLowerCase()
            if (!seen.has(key)) {
                seen.add(key)
                tagsFromDesc.push(normalized)
            }
            return leading
        })
        .replace(/\s+/g, ' ')
        .trim()

    return {
        desc: cleanedDesc,
        hashtags: [...hashtags, ...tagsFromDesc]
    }
}

function extractVideoDuration(item: AnyObject): number {
    const video = asObject(item.video) || {}
    return toNumber(video.duration)
}

function extractStats(item: AnyObject): {
    playCount: number
    diggCount: number
    commentCount: number
    shareCount: number
    collectCount: number
    repostCount: number
} {
    const statsV2 = asObject(item.statsV2)
    const stats = asObject(item.stats)
    const source = statsV2 || stats || {}
    return {
        playCount: toNumber(source.playCount),
        diggCount: toNumber(source.diggCount),
        commentCount: toNumber(source.commentCount),
        shareCount: toNumber(source.shareCount),
        collectCount: toNumber(source.collectCount),
        repostCount: toNumber(source.repostCount)
    }
}

function buildVideoUrl(username: string, videoId: string): string {
    return `https://www.tiktok.com/@${username}/video/${videoId}`
}

function buildProfileUrl(username: string): string {
    return `https://www.tiktok.com/@${username}`
}

function qualifiesVideo(stats: {
    playCount: number;
    diggCount: number;
    commentCount: number
}, videoDuration: number): boolean {
    if (stats.playCount < TIKTOK_MIN_PLAY_COUNT) return false
    if (stats.commentCount < TIKTOK_MIN_COMMENT_COUNT) return false
    if (videoDuration > TIKTOK_MAX_VIDEO_DURATION) return false
    if (stats.playCount <= 0) return false
    return stats.diggCount / stats.playCount >= TIKTOK_MIN_LIKE_RATE
}

function isVideoInYearRange(createAt: number, startYear: number, endYear: number): boolean {
    if (!Number.isFinite(createAt) || createAt <= 0) return false
    const year = new Date(createAt * 1000).getUTCFullYear()
    return year >= startYear && year <= endYear
}

function parseSortTags(value: unknown): { top_list: number } {
    if (typeof value !== 'string' || !value.trim()) return {top_list: 0}
    try {
        const parsed = JSON.parse(value)
        const obj = asObject(parsed) || {}
        return {top_list: toNumber(obj.top_list)}
    } catch {
        return {top_list: 0}
    }
}

function normalizeCommentText(value: unknown): string {
    return String(value || '').replace(/\s+/g, ' ').trim()
}

function isPureEmojiComment(text: string): boolean {
    if (!text) return false
    const stripped = text
        .replace(/[\p{White_Space}\u200d\uFE0F]/gu, '')
        .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Component}]/gu, '')
    return stripped.length === 0
}

function isObviousSpam(text: string): boolean {
    const lower = text.toLowerCase()
    const patterns = [
        /\bsupport\b/,
        /follow\s*back/,
        /\bfb\b/,
        /\bmutual(?:an)?\b/,
        /\bhadir\b/,
        /^done(?:\s+(?:fb|follow|support))?$/,
        /\bcheck in\b/,
        /^amin$/,
        /^assalamualaikum$/,
        /^hi+$/,
        /^hello+$/
    ]
    return patterns.some((pattern) => pattern.test(lower))
}

function shouldKeepComment(text: string): boolean {
    if (!text) return false
    if (isPureEmojiComment(text)) return false
    if (text.length < 3) return false
    return !isObviousSpam(text)
}

function mapComment(raw: unknown, authorUserId: string): TikTokComment | null {
    const comment = asObject(raw)
    if (!comment) return null
    const user = asObject(comment.user) || {}
    const commentUserId = String(user.uid || '')
    if (authorUserId && commentUserId && authorUserId === commentUserId) return null

    const text = normalizeCommentText(comment.text)
    if (!shouldKeepComment(text)) return null

    const sortTags = parseSortTags(comment.sort_tags)

    return {
        commentId: String(comment.cid || ''),
        text,
        language: String(comment.comment_language || ''),
        createAt: toNumber(comment.create_time),
        diggCount: toNumber(comment.digg_count),
        replyCount: toNumber(comment.reply_comment_total),
        authorLiked: comment.is_author_digged === true,
        isTop: sortTags.top_list === 1,
        user: {
            userId: commentUserId,
            secUid: String(user.sec_uid || ''),
            username: String(user.unique_id || ''),
            nickname: String(user.nickname || '')
        }
    }
}

function mapCommentResponse(page: CommentPageResponse, authorUserId: string): {
    comments: TikTokComment[];
    summary: TikTokCommentSummary
} {
    const rawComments = page.comments
    const comments = rawComments.map((item) => mapComment(item, authorUserId)).filter((item): item is TikTokComment => item !== null)
    return {
        comments,
        summary: {
            total: page.total,
            fetched: comments.length,
            hasMore: page.hasMore,
            cursor: page.cursor,
            hasFilteredComments: page.hasFilteredComments
        }
    }
}

async function downloadSelectedVideo(video: CollectedVideo, filenamePrefix = ''): Promise<DownloadedArchiveVideo> {
    const filename = `${filenamePrefix}${video.videoId}.mp4`
    const downloaded = await Downloader.downloadTikTokVideoByCandidates(video.downloadCandidates, video.videoUrl, filename)
    return {
        file: {
            filename,
            bytes: downloaded.bytes
        }
    }
}

function toPublicVideo(video: CollectedVideo): TikTokVideo {
    const {downloadCandidates: _downloadCandidates, ...publicVideo} = video
    return publicVideo
}

async function loadProfileContext(username: string): Promise<{
    username: string;
    user: TikTokUser;
    requestEnv: RequestEnv;
    commentSetting: number
    profileUrl: string
}> {
    const normalizedUsername = username.trim().replace(/^@/, '')
    const profileUrl = buildProfileUrl(normalizedUsername)

    const html = await fetchHtml(profileUrl)
    const scriptText = extractScriptContentById(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__')
        || extractScriptContentById(html, '__UNIVERSAL_DATA_FOR_VAR__')
    if (!scriptText) throw new Error('未找到主页 JSON 容器')

    const jsonData = JSON.parse(scriptText)

    const secUid = pickSecUid(findSecUidCandidates(jsonData), normalizedUsername)
    const {user, requestEnv} = buildRequestEnv(jsonData, normalizedUsername, secUid)
    const root = asObject(jsonData) || {}
    const scope = asObject(root.__DEFAULT_SCOPE__) || {}
    const userDetail = asObject(scope['webapp.user-detail']) || {}
    const userInfo = asObject(userDetail.userInfo) || {}
    const rawUser = asObject(userInfo.user) || {}
    const resolvedUsername = user.username || normalizedUsername
    return {
        username: resolvedUsername,
        user,
        requestEnv,
        commentSetting: toNumber(rawUser.commentSetting),
        profileUrl: buildProfileUrl(resolvedUsername)
    }
}

async function fetchCommentsForVideo(
    videoId: string,
    username: string,
    authorUserId: string,
    requestEnv: RequestEnv
): Promise<{ comments: TikTokComment[]; summary: TikTokCommentSummary }> {
    const page = await fetchCommentPage(videoId, 0, requestEnv, buildVideoUrl(username, videoId))
    return mapCommentResponse(page, authorUserId)
}

async function collectVideos(
    username: string,
    authorUserId: string,
    secUid: string,
    requestEnv: RequestEnv,
    profileUrl: string,
    maxVideoCount: number,
    startYear: number,
    endYear: number,
    onLog?: CollectLogFn
): Promise<CollectedVideo[]> {
    const videos: CollectedVideo[] = []
    const seenVideoIds = new Set<string>()
    let cursor = 0
    let page = 0

    while (videos.length < maxVideoCount) {
        page += 1
        await emitCollectLog(onLog, `拉取视频列表第 ${page} 页...`)
        const pageResult = await fetchHotVideoPage(secUid, cursor, requestEnv, profileUrl)
        const items = pageResult.items
        if (items.length === 0) break

        for (const item of items) {
            const obj = asObject(item)
            if (!obj) continue
            if (obj.isAd === true) continue

            const videoId = String(obj.id || '')
            if (!videoId) continue
            if (seenVideoIds.has(videoId)) continue

            const createAt = toNumber(obj.createTime)
            if (!isVideoInYearRange(createAt, startYear, endYear)) continue

            const stats = extractStats(obj)
            const videoDuration = extractVideoDuration(obj)
            if (!qualifiesVideo(stats, videoDuration)) continue
            const downloadCandidates = getDownloadCandidatesFromItem(obj)
            if (downloadCandidates.length === 0) continue
            seenVideoIds.add(videoId)
            const descMeta = extractDescAndHashtags(obj.desc, obj)

            let comments: TikTokComment[] = []
            let commentSummary: TikTokCommentSummary = {
                total: 0,
                fetched: 0,
                hasMore: false,
                cursor: 0,
                hasFilteredComments: false
            }
            const videoUrl = buildVideoUrl(username, videoId)

            try {
                const commentResult = await fetchCommentsForVideo(videoId, username, authorUserId, requestEnv)
                comments = commentResult.comments
                commentSummary = commentResult.summary
            } catch (error) {
                console.warn('[TikTok] fetch comments failed', videoId, error)
            }

            videos.push({
                videoId,
                desc: descMeta.desc,
                createAt,
                videoDuration,
                videoUrl,
                hashtags: descMeta.hashtags,
                playCount: stats.playCount,
                diggCount: stats.diggCount,
                commentCount: stats.commentCount,
                shareCount: stats.shareCount,
                collectCount: stats.collectCount,
                repostCount: stats.repostCount,
                privateItem: obj.privateItem === true,
                secret: obj.secret === true,
                commentSummary,
                comments,
                downloadCandidates
            })

            if (videos.length >= maxVideoCount) {
                break
            }

            await sleepRandom(800, 1500)
        }

        if (!pageResult.hasMore) break
        const nextCursor = pageResult.cursor
        if (!Number.isFinite(nextCursor) || nextCursor <= cursor) break
        cursor = nextCursor
        await sleepRandom(1200, 2000)
    }

    return videos
}

async function downloadCollectedVideos(
    videos: CollectedVideo[],
    targetCount: number,
    onDownloadProgress?: (downloadedCount: number, selectedCount: number, targetCount: number) => void,
    onDownloadFailed?: (videoId: string) => void,
    filenamePrefix = ''
): Promise<{ downloadSummary: DownloadSummary; downloadedFiles: ArchiveFile[] }> {
    const downloadedFiles: ArchiveFile[] = []
    const downloadSummary: DownloadSummary = {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        failedVideoIds: []
    }

    for (const video of videos) {
        try {
            downloadSummary.attempted += 1
            const downloaded = await downloadSelectedVideo(video, filenamePrefix)
            const publicVideo = toPublicVideo(video)
            downloadedFiles.push(downloaded.file)
            downloadedFiles.push(createJsonArchiveFile(`${filenamePrefix}${video.videoId}.json`, publicVideo))
            downloadedFiles.push(createTextArchiveFile(`${filenamePrefix}${video.videoId}.txt`, `${video.videoUrl}\n\n`))
            downloadSummary.succeeded += 1
            onDownloadProgress?.(downloadSummary.succeeded, videos.length, targetCount)
        } catch (error) {
            downloadSummary.failed += 1
            downloadSummary.failedVideoIds.push(video.videoId)
            onDownloadFailed?.(video.videoId)
            console.warn('[TikTok] download selected video failed', video.videoId, error)
        }
        await sleepRandom(800, 1500)
    }

    return {downloadSummary, downloadedFiles}
}

export class Collector {
    static async collectProfileByUsername(
        username: string,
        maxVideoCount: number,
        startYear: number,
        endYear: number,
        onSelectedCount?: (selectedCount: number, targetCount: number) => void,
        onDownloadProgress?: (downloadedCount: number, selectedCount: number, targetCount: number) => void,
        onDownloadFailed?: (videoId: string) => void,
        filenamePrefix?: string,
        onLog?: CollectLogFn
    ): Promise<{
        filename: string;
        output: TikTokProfileCollection
        downloadSummary: DownloadSummary
    }> {
        const normalizedUsername = username.trim().replace(/^@/, '')
        if (!normalizedUsername) {
            throw new Error('缺少 TikTok 用户名')
        }

        await emitCollectLog(onLog, `读取主页信息: @${normalizedUsername}`)
        const {user, requestEnv, username: resolvedUsername, commentSetting, profileUrl} = await loadProfileContext(normalizedUsername)
        await emitCollectLog(onLog, `主页信息就绪: @${resolvedUsername}`)

        if (commentSetting !== 0) {
            throw new Error('当前博主已关闭评论功能')
        }

        await emitCollectLog(onLog, `开始筛选 ${startYear}-${endYear} 年视频...`)
        const videos = await collectVideos(
            resolvedUsername,
            user.userId,
            user.secUid,
            requestEnv,
            profileUrl,
            maxVideoCount,
            startYear,
            endYear,
            onLog
        )
        if (videos.length === 0) {
            throw new Error('当前博主没有符合要求的视频')
        }
        await emitCollectLog(onLog, `已筛出 ${videos.length} 个符合条件的视频`)
        onSelectedCount?.(videos.length, maxVideoCount)
        await emitCollectLog(onLog, '开始下载入选视频并生成归档...')
        const {downloadSummary, downloadedFiles} = await downloadCollectedVideos(
            videos,
            maxVideoCount,
            onDownloadProgress,
            onDownloadFailed,
            filenamePrefix || ''
        )
        const outputVideos = videos.map(toPublicVideo)
        const output: TikTokProfileCollection = {user, videos: outputVideos}
        const prefix = filenamePrefix || ''
        const baseName = `${prefix}${resolvedUsername}_${formatTimestampForFilename(new Date())}`
        const jsonFilename = `${baseName}.json`
        const filename = `${baseName}.zip`
        console.log('[TikTok Collect]', output)
        const archiveBlob = createZipBlob([
            createJsonArchiveFile(jsonFilename, output),
            ...downloadedFiles
        ])
        await downloadBlob(filename, archiveBlob)
        await emitCollectLog(onLog, `归档已生成: ${filename}`)
        return {filename, output, downloadSummary}
    }

    static async collectCurrentProfile(
        maxVideoCount: number,
        startYear: number,
        endYear: number,
        onSelectedCount?: (selectedCount: number, targetCount: number) => void,
        onDownloadProgress?: (downloadedCount: number, selectedCount: number, targetCount: number) => void,
        onDownloadFailed?: (videoId: string) => void,
        filenamePrefix?: string,
        onLog?: CollectLogFn
    ): Promise<{
        filename: string;
        output: TikTokProfileCollection
        downloadSummary: DownloadSummary
    }> {
        const username = UrlHelper.getUsernameFromProfilePage(window.location.href)
        if (!username) {
            throw new Error('当前页面不是博主主页')
        }

        return await Collector.collectProfileByUsername(
            username,
            maxVideoCount,
            startYear,
            endYear,
            onSelectedCount,
            onDownloadProgress,
            onDownloadFailed,
            filenamePrefix,
            onLog
        )
    }

    static formatError(error: unknown): string {
        return truncateError(error instanceof Error ? error.message : String(error), 500)
    }
}
