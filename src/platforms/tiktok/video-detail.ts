import {extractScriptContentById} from './collector'

const VIDEO_DETAIL_SCOPE = 'webapp.video-detail'

function asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

// 占位用户名 @i 即可：服务端按 videoId 返回，真实作者从 itemStruct.author.uniqueId 自带
export function buildVideoDetailUrl(videoId: string): string {
    return `https://www.tiktok.com/@i/video/${videoId}`
}

// 不依赖 window/document，便于 CLI 与页面下载按钮两路复用同一抽取逻辑
export function parseItemStructFromHtml(html: string): Record<string, unknown> | null {
    const scriptText = extractScriptContentById(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__')
        || extractScriptContentById(html, '__UNIVERSAL_DATA_FOR_VAR__')
    if (!scriptText) return null

    let root: unknown
    try {
        root = JSON.parse(scriptText)
    } catch {
        return null
    }

    const scope = asObject(asObject(root)?.__DEFAULT_SCOPE__)
    const detail = asObject(scope?.[VIDEO_DETAIL_SCOPE])
    if (!detail) return null
    // statusCode 可能是字符串数字，Number() 归一后非 0 即视频不存在/受限
    const statusCode = detail.statusCode
    if (statusCode !== undefined && statusCode !== null && Number(statusCode) !== 0) return null

    const itemStruct = asObject(asObject(detail.itemInfo)?.itemStruct)
    // 风控降级时结构在但 id 等内容被剥离，故额外查 id
    if (!itemStruct || typeof itemStruct.id !== 'string' || !itemStruct.id) return null
    return itemStruct
}
