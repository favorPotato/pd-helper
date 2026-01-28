import {Analyzer, Extractor} from './analyzer'
import {UiHelper} from './helpers'
import {truncateError} from '../../shared/errors'

let analysisInProgress = false

async function runAnalysisWorkflow() {
    if (analysisInProgress) return

    try {
        UiHelper.log('开始分析帖子...')
        analysisInProgress = true

        const shortcode = Extractor.getShortcode()
        if (!shortcode) {
            console.error('无法提取 shortcode')
            UiHelper.log('无法提取 shortcode')
            return
        }

        let postData: Awaited<ReturnType<typeof Extractor.extractPostData>>
        try {
            postData = await Extractor.extractPostData(shortcode)
        } catch (error) {
            const msg = truncateError(error instanceof Error ? error.message : String(error), 500)
            console.error('提取数据失败:', msg)
            UiHelper.log(`提取数据失败: ${msg}`)
            return
        }

        if (!postData) {
            alert('无法读取动态数据')
            UiHelper.log('无法读取动态数据')
            return
        }

        if (postData.media?.comments_disabled) {
            alert('该帖子已关闭评论')
            UiHelper.log('该帖子已关闭评论')
            return
        }

        const analysis = postData.media?.media_url ? await Analyzer.callAIAnalysis(postData.media.media_url) : null

        if (analysis) {
            postData.media_analysis = analysis
            await Analyzer.downloadSuccessResult(postData, shortcode)
            alert(`AI分析成功，请查看 ${shortcode}.txt`)
            UiHelper.log('AI分析成功')
        } else {
            const ext = postData.media?.type === 'video' ? 'mp4' : 'jpg'
            const filename = `${shortcode}.${ext}`
            await Analyzer.downloadFallbackResult(postData, shortcode, filename)
            alert(`AI分析失败，请将 ${shortcode}.txt 和 ${filename} 上传到AI分析`)
            UiHelper.log('AI分析失败')
        }
    } catch (error) {
        const msg = truncateError(error instanceof Error ? error.message : String(error), 500)
        alert(`分析失败: ${msg}`)
        UiHelper.log(`分析失败: ${msg}`)
    } finally {
        analysisInProgress = false
    }
}

export function setup() {
    // 初始化UI
    void UiHelper.inject({
        onAnalyze: runAnalysisWorkflow
    })
}
