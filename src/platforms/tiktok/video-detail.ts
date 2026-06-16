import {buildRequestEnvFromAppContext, extractScriptContentById} from './collector'
import type {RequestEnv} from './client'

const VIDEO_DETAIL_SCOPE = 'webapp.video-detail'
const APP_CONTEXT_SCOPE = 'webapp.app-context'

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

// 不依赖 window/document，便于 CLI 与页面下载按钮两路复用同一抽取逻辑
export function parseItemStructFromHtml(html: string): Record<string, unknown> | null {
    return parseVideoDetailFromHtml(html)?.itemStruct ?? null
}

// app-context 详情页同样在，故顺带产出 requestEnv 供评论采集复用
export function parseVideoDetailFromHtml(html: string): {itemStruct: Record<string, unknown>; requestEnv: RequestEnv} | null {
    const root = parseUniversalData(html)
    const scope = asObject(root?.__DEFAULT_SCOPE__)
    const detail = asObject(scope?.[VIDEO_DETAIL_SCOPE])
    if (!detail) return null
    // statusCode 可能是字符串数字，Number() 归一后非 0 即视频不存在/受限
    const statusCode = detail.statusCode
    if (statusCode !== undefined && statusCode !== null && Number(statusCode) !== 0) return null

    const itemStruct = asObject(asObject(detail.itemInfo)?.itemStruct)
    // 风控降级时结构在但 id 等内容被剥离，故额外查 id
    if (!itemStruct || typeof itemStruct.id !== 'string' || !itemStruct.id) return null
    return {itemStruct, requestEnv: buildRequestEnvFromAppContext(asObject(scope?.[APP_CONTEXT_SCOPE]))}
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
