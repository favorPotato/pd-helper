import {Analyzer, Extractor, UiHelper} from './analyzer'

let analysisInProgress = false

async function runAnalysisWorkflow() {
    if (analysisInProgress) return

    const button = UiHelper.getAnalysisButton()

    try {
        UiHelper.setButtonState(button, true)
        analysisInProgress = true

        const shortcode = Extractor.getShortcode()
        if (!shortcode) {
            console.error('无法提取 shortcode')
            return
        }

        let postData: Awaited<ReturnType<typeof Extractor.extractPostData>>
        try {
            postData = await Extractor.extractPostData(shortcode)
        } catch (error) {
            console.error('提取数据失败:', error)
            return
        }

        if (!postData) {
            alert('无法读取动态数据')
            return
        }

        if (postData.media?.comments_disabled) {
            alert('该帖子已关闭评论')
            return
        }

        const analysis = postData.media?.media_url ? await Analyzer.callAIAnalysis(postData.media.media_url) : null

        if (analysis) {
            postData.media_analysis = analysis
            await Analyzer.downloadSuccessResult(postData, shortcode)
            alert(`AI分析成功，请查看 ${shortcode}.txt`)
        } else {
            const ext = postData.media?.type === 'video' ? 'mp4' : 'jpg'
            const filename = `${shortcode}.${ext}`
            await Analyzer.downloadFallbackResult(postData, shortcode, filename)
            alert(`AI分析失败，请将 ${shortcode}.txt 和 ${filename} 上传到AI分析`)
        }
    } finally {
        analysisInProgress = false
        UiHelper.setButtonState(button, false)
    }
}

export function setup() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            UiHelper.injectButton(runAnalysisWorkflow)
            UiHelper.observeDOM(runAnalysisWorkflow)
        })
    } else {
        UiHelper.injectButton(runAnalysisWorkflow)
        UiHelper.observeDOM(runAnalysisWorkflow)
    }

    window.addEventListener('popstate', () => {
        setTimeout(() => UiHelper.injectButton(runAnalysisWorkflow), 100)
    })
}
