import {Analyzer, Extractor} from './analyzer'
import {InstagramRequestAbortError, UiHelper, UrlHelper} from './helpers'
import {truncateError} from '../../shared/errors'
import type {ReelsCollectRange} from './types'

let analysisInProgress = false
let reelsCollectionInProgress = false

type ExtractedPostData = NonNullable<Awaited<ReturnType<typeof Extractor.extractPostData>>>

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

async function runCollectReelsWorkflow() {
    if (reelsCollectionInProgress) return

    const username = UrlHelper.getUsernameFromAccountReelsPage()
    if (!username) {
        alert('当前页面不是账号 reels 列表页')
        UiHelper.log('当前页面不是账号 reels 列表页')
        return
    }

    reelsCollectionInProgress = true
    try {
        const rangeInput = window.prompt('1-10 = 按时间线取第 1 到第 10 个视频\n5 = 只取第 5 个\n留空 = 全部\n输入采集区间值：', '')
        if (rangeInput === null) {
            UiHelper.log('已取消 reels 采集')
            return
        }

        const range = parseReelsCollectRange(rangeInput)
        const log = (message: string) => {
            console.log(`[采集reels] ${message}`)
            UiHelper.log(message)
        }

        log(`开始采集 @${username} 的 reels...`)
        if (range) {
            log(`按时间线区间采集：${range.start}-${range.end}`)
        } else {
            log('按时间线采集全部 reels')
        }

        const collected = await Analyzer.collectReelsForUsername(username, log, range)
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
        onCollectReels: runCollectReelsWorkflow
    })
}
