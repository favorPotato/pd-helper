import {buildRequestEnvFromAppContext, extractScriptContentById} from './collector'
import type {RequestEnv} from './client'
import {withPdCode} from '../../shared/cli-bridge/cs-runtime'

const VIDEO_DETAIL_SCOPE = 'webapp.video-detail'
const APP_CONTEXT_SCOPE = 'webapp.app-context'

// 详情页四态：READY 正常 / GONE 已删除·不存在·审核中（statusCode=10204，终态）/
// AUTH_WALL 登录墙（公共接口不可取，终态）/ PENDING 风控·please-wait 过渡（唯一可 reload 重试）
export type VideoDetailState = 'READY' | 'GONE' | 'AUTH_WALL' | 'PENDING'

// TikTok「视频不存在/受限/审核中」状态码
const GONE_STATUS_CODE = 10204

// detail 为页面 __DEFAULT_SCOPE__['webapp.video-detail'] 节点；判别序：PENDING→GONE→AUTH_WALL→READY。
// 此函数与 business-dispatchers.ts 的注入探针 tkDetailReadyProbe 同构，改判据两处必须同步。
export function classifyVideoDetail(detail: Record<string, unknown> | null | undefined): VideoDetailState {
    if (!detail) return 'PENDING'
    const code = Number((detail as {statusCode?: unknown}).statusCode)
    if (code === GONE_STATUS_CODE) return 'GONE'
    if (code !== 0) return 'PENDING' // 非 0 非删除码：数据尚未就绪，按过渡页重试
    const itemStruct = asObject(asObject(detail.itemInfo)?.itemStruct)
    const id = itemStruct?.id
    if (typeof id !== 'string' || !id) return 'PENDING'
    const video = asObject(itemStruct.video)
    const playAddr = video?.playAddr
    const hasPlayAddr = typeof playAddr === 'string' && playAddr.length > 0
    const hasBitrate = Array.isArray(video?.bitrateInfo) && (video.bitrateInfo as unknown[]).length > 0
    if (!hasPlayAddr && !hasBitrate) return 'AUTH_WALL'
    return 'READY'
}

export class VideoDeletedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'VideoDeletedError'
        withPdCode(this, 'VIDEO_DELETED')
    }
}

export class LoginRequiredError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'LoginRequiredError'
        withPdCode(this, 'LOGIN_REQUIRED')
    }
}

// 存档无用字段：① 过期 URL/下载 blob，② 观看者会话上下文；保留视频本体/分类/配置
const ITEM_PRUNE_TOP = ['digged', 'forFriend', 'collected']
const VIDEO_PRUNE = ['playAddr', 'downloadAddr', 'cover', 'originCover', 'dynamicCover', 'shareCover', 'reflowCover', 'zoomCover', 'bitrateInfo', 'PlayAddrStruct', 'claInfo']
const MUSIC_PRUNE = ['playUrl', 'coverLarge', 'coverMedium', 'coverThumb', 'tt2dsp']
const AUTHOR_PRUNE = ['avatarLarger', 'avatarMedium', 'avatarThumb']

function asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

// 占位用户名 @i 即可：服务端按 videoId 返回，真实作者从 itemStruct.author.uniqueId 自带
export function buildVideoDetailUrl(videoId: string): string {
    return `https://www.tiktok.com/@i/video/${videoId}`
}

function parseUniversalData(html: string): Record<string, unknown> | null {
    const scriptText = extractScriptContentById(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__')
        || extractScriptContentById(html, '__UNIVERSAL_DATA_FOR_VAR__')
    if (!scriptText) return null
    try {
        return asObject(JSON.parse(scriptText))
    } catch {
        return null
    }
}

// app-context 详情页同样在，故顺带产出 requestEnv 供评论采集复用
// 四态分流：READY 返回 itemStruct；GONE/AUTH_WALL 抛带 pdCode 的终态错误；PENDING 返回 null（调用方据此重试）
export function parseVideoDetailFromHtml(html: string): {itemStruct: Record<string, unknown>; requestEnv: RequestEnv} | null {
    const root = parseUniversalData(html)
    const scope = asObject(root?.__DEFAULT_SCOPE__)
    const detail = asObject(scope?.[VIDEO_DETAIL_SCOPE])
    switch (classifyVideoDetail(detail)) {
        case 'GONE':
            throw new VideoDeletedError('视频已删除或不存在（statusCode=10204）')
        case 'AUTH_WALL':
            throw new LoginRequiredError('该视频需登录态才能查看，公共接口不可取')
        case 'PENDING':
            return null
        case 'READY': {
            // itemStruct 由 classifyVideoDetail 的 READY 判据保证非空
            const itemStruct = asObject(asObject(detail!.itemInfo)?.itemStruct)!
            return {itemStruct, requestEnv: buildRequestEnvFromAppContext(asObject(scope?.[APP_CONTEXT_SCOPE]))}
        }
    }
}

// 就地裁掉存档无用字段，保留视频本体；subtitleInfos 留结构、仅删过期 url
export function pruneItemStruct(itemStruct: Record<string, unknown>): Record<string, unknown> {
    for (const k of ITEM_PRUNE_TOP) delete itemStruct[k]
    const del = (obj: Record<string, unknown> | null, keys: string[]) => {
        if (obj) for (const k of keys) delete obj[k]
    }
    const video = asObject(itemStruct.video)
    del(video, VIDEO_PRUNE)
    del(asObject(itemStruct.music), MUSIC_PRUNE)
    del(asObject(itemStruct.author), AUTHOR_PRUNE)
    if (video && Array.isArray(video.subtitleInfos)) {
        for (const sub of video.subtitleInfos) {
            const o = asObject(sub)
            if (o) {
                delete o.Url
                delete o.UrlExpire
            }
        }
    }
    return itemStruct
}
