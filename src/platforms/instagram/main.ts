import {Analyzer, Extractor} from './analyzer'
import {InstagramRequestAbortError, UiHelper, UrlHelper} from './helpers'
import {truncateError} from '../../shared/errors'
import type {ReelsCollectRange} from './types'
import type {ScriptApiEndpoint, ScriptApiRequestMessage, ScriptApiResponse, ScriptApiUploadFile} from '../../types'

let analysisInProgress = false
let reelsCollectionInProgress = false
let scriptGenerationInProgress = false

type ExtractedPostData = NonNullable<Awaited<ReturnType<typeof Extractor.extractPostData>>>

async function requestScriptApi(
    endpoint: ScriptApiEndpoint,
    method: 'GET' | 'POST',
    body?: unknown,
    options: {bodyType?: 'json' | 'multipart'; files?: ScriptApiUploadFile[]} = {}
): Promise<ScriptApiResponse> {
    try {
        const message: ScriptApiRequestMessage = {
            type: 'script_api_request',
            endpoint,
            method,
            body,
            bodyType: options.bodyType,
            files: options.files
        }
        return await chrome.runtime.sendMessage(message) as ScriptApiResponse
    } catch (error) {
        return {
            ok: false,
            status: 0,
            data: null,
            error: truncateError(error instanceof Error ? error.message : String(error), 500)
        }
    }
}

function getScriptApiRecord(data: unknown): Record<string, unknown> | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return null
    }

    return data as Record<string, unknown>
}

function getScriptApiPayload(result: ScriptApiResponse): Record<string, unknown> | null {
    const root = getScriptApiRecord(result.data)
    if (!root) return null

    const payload = root.data
    return getScriptApiRecord(payload) || root
}

function readScriptApiStringList(record: Record<string, unknown> | null, key: string): string[] {
    const value = record?.[key]
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

function stringifyScriptApiData(value: unknown): string {
    if (typeof value === 'string') {
        return value
    }

    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function formatScriptApiResult(result: ScriptApiResponse, fallback: string): string {
    if (result.error) {
        return result.error
    }

    const root = getScriptApiRecord(result.data)
    const payload = getScriptApiPayload(result)
    const message = typeof root?.message === 'string' && root.message.trim() ? root.message : null
    const reasons = readScriptApiStringList(payload, 'reasons')
    const reviewFlags = readScriptApiStringList(payload, 'review_flags')
    const details = [
        ...(message ? [message] : []),
        ...(reasons.length > 0 ? [`reasons: ${reasons.join('，')}`] : []),
        ...(reviewFlags.length > 0 ? [`review_flags: ${reviewFlags.join('，')}`] : [])
    ]

    if (details.length > 0) {
        return truncateError(details.join('\n'), 500)
    }

    if (result.data !== null && result.data !== undefined) {
        return truncateError(stringifyScriptApiData(result.data), 500)
    }

    return fallback
}

function isResponseBlocked(result: ScriptApiResponse): boolean {
    return getScriptApiPayload(result)?.blocked === true
}

async function checkScriptHealth(): Promise<ScriptApiResponse> {
    return await requestScriptApi('/health', 'GET')
}

async function precheckScript(body: unknown): Promise<ScriptApiResponse> {
    return await requestScriptApi('/precheck', 'POST', body)
}

async function generateScript(postData: unknown, files: ScriptApiUploadFile[]): Promise<ScriptApiResponse> {
    return await requestScriptApi('/generate-script', 'POST', postData, {
        bodyType: 'multipart',
        files
    })
}

function getMediaUrls(postData: ExtractedPostData): string[] {
    const media = postData.media
    if (!media) return []

    if (Array.isArray(media.media_urls) && media.media_urls.length > 0) {
        return media.media_urls.filter((url): url is string => typeof url === 'string' && url.length > 0)
    }

    if (typeof media.media_url === 'string' && media.media_url) {
        return [media.media_url]
    }

    return []
}

function getFileExtensionFromMimeType(mimeType: string, fallback: string): string {
    const normalized = mimeType.toLowerCase()
    if (normalized.includes('mp4')) return 'mp4'
    if (normalized.includes('quicktime')) return 'mov'
    if (normalized.includes('png')) return 'png'
    if (normalized.includes('webp')) return 'webp'
    if (normalized.includes('gif')) return 'gif'
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
    return fallback
}

function buildMediaFilename(shortcode: string, index: number, total: number, mimeType: string, fallbackExt: string): string {
    const extension = getFileExtensionFromMimeType(mimeType, fallbackExt)
    const suffix = total > 1 ? `-${index + 1}` : ''
    return `${shortcode}${suffix}.${extension}`
}

async function fetchMediaFiles(postData: ExtractedPostData, shortcode: string): Promise<ScriptApiUploadFile[]> {
    const mediaUrls = getMediaUrls(postData)
    if (mediaUrls.length === 0) return []

    const fallbackMimeType = postData.media?.type === 'video' ? 'video/mp4' : 'image/jpeg'
    const fallbackExt = postData.media?.type === 'video' ? 'mp4' : 'jpg'
    const files: ScriptApiUploadFile[] = []

    for (let index = 0; index < mediaUrls.length; index += 1) {
        const mediaUrl = mediaUrls[index]

        try {
            const response = await fetch(mediaUrl)
            if (!response.ok) {
                UiHelper.log(`媒体获取失败(${index + 1}/${mediaUrls.length}): ${response.status}`)
                continue
            }

            const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || fallbackMimeType
            const filename = buildMediaFilename(shortcode, index, mediaUrls.length, mimeType, fallbackExt)
            const buffer = await response.arrayBuffer()

            files.push({
                filename,
                mimeType,
                bytes: Array.from(new Uint8Array(buffer))
            })
        } catch (error) {
            const msg = truncateError(error instanceof Error ? error.message : String(error), 500)
            UiHelper.log(`媒体获取失败(${index + 1}/${mediaUrls.length}): ${msg}`)
        }
    }

    return files
}

function parseReelsCollectRange(input: string): ReelsCollectRange | null {
    const normalized = input.trim()
    if (!normalized) return null

    const match = normalized.match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!match) {
        throw new Error('区间格式无效，请输入如 1-10 或 5')
    }

    const start = Number.parseInt(match[1], 10)
    const end = Number.parseInt(match[2] || match[1], 10)

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
        throw new Error('区间必须是大于等于 1 的整数')
    }

    if (start > end) {
        throw new Error('区间起始值不能大于结束值')
    }

    return {start, end}
}

async function preparePostData(): Promise<{
    shortcode: string
    postData: ExtractedPostData
} | null> {
    const shortcode = UrlHelper.getShortcode()
    if (!shortcode) {
        console.error('无法提取 shortcode')
        UiHelper.log('无法提取 shortcode')
        return null
    }

    let postData: Awaited<ReturnType<typeof Extractor.extractPostData>>
    try {
        postData = await Extractor.extractPostData(shortcode, {
            routeKind: UrlHelper.getCurrentMediaRouteKind()
        })
    } catch (error) {
        const msg = truncateError(error instanceof Error ? error.message : String(error), 500)
        console.error('提取数据失败:', msg)
        UiHelper.log(`提取数据失败: ${msg}`)
        return null
    }

    if (!postData) {
        alert('无法读取动态数据')
        UiHelper.log('无法读取动态数据')
        return null
    }

    if (postData.media?.comments_disabled) {
        alert('该帖子已关闭评论')
        UiHelper.log('该帖子已关闭评论')
        return null
    }

    const preparedPostData: ExtractedPostData = postData
    return {shortcode, postData: preparedPostData}
}

async function runManualAnalysisWorkflow() {
    if (analysisInProgress) return

    try {
        UiHelper.log('开始手动分析...')
        analysisInProgress = true

        const prepared = await preparePostData()
        if (!prepared) return
        const {shortcode, postData} = prepared

        const ext = postData.media?.type === 'video' ? 'mp4' : 'jpg'
        const filename = `${shortcode}.${ext}`
        await Analyzer.downloadFallbackResult(postData, shortcode, filename)
        alert(`相关文件已生成，请将 ${shortcode}.txt 和 ${filename} 上传到AI分析`)
        UiHelper.log('相关文件已生成')
    } catch (error) {
        const msg = truncateError(error instanceof Error ? error.message : String(error), 500)
        alert(`分析失败: ${msg}`)
        UiHelper.log(`分析失败: ${msg}`)
    } finally {
        analysisInProgress = false
    }
}

async function runGenerateScriptWorkflow() {
    if (scriptGenerationInProgress) return

    try {
        UiHelper.log('开始生成剧本...')
        scriptGenerationInProgress = true

        const prepared = await preparePostData()
        if (!prepared) return

        const {shortcode, postData} = prepared
        if (!postData.media?.id) {
            alert('无法提取帖子媒体数据')
            UiHelper.log('无法提取帖子媒体数据')
            return
        }

        const healthResult = await checkScriptHealth()
        if (!healthResult.ok) {
            const message = formatScriptApiResult(healthResult, '健康检查失败')
            alert(message)
            UiHelper.log(`健康检查失败: ${message}`)
            return
        }

        const payload = Analyzer.buildScriptApiPostData(postData)
        const precheckResult = await precheckScript(payload)
        if (!precheckResult.ok || isResponseBlocked(precheckResult)) {
            const message = formatScriptApiResult(precheckResult, 'precheck 未通过')
            alert(message)
            UiHelper.log(`precheck 未通过: ${message}`)
            return
        }

        const mediaFiles = await fetchMediaFiles(postData, shortcode)
        if (mediaFiles.length === 0) {
            alert('无法获取帖子媒体文件，已取消生成剧本')
            UiHelper.log('无法获取帖子媒体文件，已取消生成剧本')
            return
        }

        const generateResult = await generateScript(payload, mediaFiles)
        if (!generateResult.ok || isResponseBlocked(generateResult)) {
            const message = formatScriptApiResult(generateResult, '生成剧本失败')
            alert(`生成剧本失败: ${message}`)
            UiHelper.log(`生成剧本失败: ${message}`)
            return
        }

        UiHelper.log(`生成剧本已提交: ${truncateError(stringifyScriptApiData(generateResult.data), 300)}`)
        alert('生成剧本请求已提交')
    } catch (error) {
        const msg = truncateError(error instanceof Error ? error.message : String(error), 500)
        alert(`生成剧本失败: ${msg}`)
        UiHelper.log(`生成剧本失败: ${msg}`)
    } finally {
        scriptGenerationInProgress = false
    }
}

async function runCollectReelsWorkflow(order: 'asc' | 'desc' = 'asc') {
    if (reelsCollectionInProgress) return

    const username = UrlHelper.getUsernameFromAccountReelsPage()
    if (!username) {
        alert('当前页面不是账号 reels 列表页')
        UiHelper.log('当前页面不是账号 reels 列表页')
        return
    }

    reelsCollectionInProgress = true
    try {
        const dialogResult = await import('../../shared/custom-dialog').then(m => m.showDialog({
            title: '采集 Reels',
            fields: [{
                key: 'range',
                label: '采集区间（如 1-10 取前10个，5 只取第5个，留空全部）',
                type: 'text',
                placeholder: '留空 = 全部'
            }]
        }))
        if (dialogResult === null) {
            UiHelper.log('已取消 reels 采集')
            return
        }

        const rangeInput = String(dialogResult.range || '')
        const range = parseReelsCollectRange(rangeInput)
        const log = (message: string) => {
            UiHelper.log(message)
        }

        log(`开始采集 @${username} 的 reels（${order === 'asc' ? '正序' : '倒序'}）...`)
        if (range) {
            log(`按${order === 'asc' ? '正序' : '倒序'}区间采集：${range.start}-${range.end}`)
        } else {
            log(`按${order === 'asc' ? '正序' : '倒序'}采集全部 reels`)
        }

        const collected = await Analyzer.collectReelsForUsername(username, log, range, order)
        if (!collected) {
            alert('采集失败：无法读取账号或分页数据')
            log('采集失败：无法读取账号或分页数据')
            return
        }

        await Analyzer.downloadJson(collected.filename, collected.output)
        log(`采集完成：${collected.output.meta.total_posts} 条`)
    } catch (error) {
        if (error instanceof InstagramRequestAbortError) {
            alert(error.message)
            UiHelper.log(error.message)
            return
        }
        const msg = truncateError(error instanceof Error ? error.message : String(error), 500)
        alert(`采集失败: ${msg}`)
        UiHelper.log(`采集失败: ${msg}`)
    } finally {
        reelsCollectionInProgress = false
    }
}

export function setup() {
    // 初始化UI
    void UiHelper.inject({
        onManualAnalyze: runManualAnalysisWorkflow,
        onGenerateScript: runGenerateScriptWorkflow,
        onCollectReels: () => runCollectReelsWorkflow('asc'),
        onCollectReelsDesc: () => runCollectReelsWorkflow('desc')
    })
}
