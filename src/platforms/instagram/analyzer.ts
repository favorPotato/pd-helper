import {analyzeMedia} from '../../shared/api'
import {MEDIA_PROMPT} from '../../shared/env'
import type {ExtractResult} from '../../types'
import type {CleanedMedia, CommentsResult} from './types'

type ScriptNode = HTMLScriptElement | null

type GraphData = {
    xdt_api__v1__media__shortcode__web_info?: {
        items?: Array<any>
    }
    xdt_api__v1__media__media_id__comments__connection?: {
        edges?: Array<any>
        page_info?: {
            has_next_page?: boolean
            end_cursor?: string | null
        }
    }
}

export class Extractor {
    static getShortcode(): string | null {
        const match = window.location.pathname.match(/\/(p|reel)\/([A-Za-z0-9_-]+)\//)
        return match ? match[2] : null
    }

    static findScriptByKey(key: string): ScriptNode {
        const scripts = document.querySelectorAll<HTMLScriptElement>('script[data-sjs][type="application/json"]')
        for (const script of Array.from(scripts)) {
            if (script.textContent?.includes(key)) {
                return script
            }
        }
        return null
    }

    static extractDataFromScript(scriptText: string): GraphData | null {
        try {
            const json = JSON.parse(scriptText)
            return Extractor.findResultData(json)
        } catch (error) {
            console.error('JSON 解析失败:', error)
            return null
        }
    }

    static extractScriptContent(html: string, key: string): string | null {
        const keyIndex = html.indexOf(key)
        if (keyIndex === -1) return null

        let start = html.lastIndexOf('<script', keyIndex)
        if (start === -1) return null

        start = html.indexOf('>', start)
        if (start === -1) return null
        start += 1

        const end = html.indexOf('</script>', keyIndex)
        if (end === -1) return null

        return html.substring(start, end)
    }

    static cleanMediaData(rawData: GraphData | null): CleanedMedia | null {
        const item = rawData?.xdt_api__v1__media__shortcode__web_info?.items?.[0]
        if (!item) return null

        const isVideo = Array.isArray(item.video_versions) && item.video_versions.length > 0

        return {
            id: item.pk,
            shortcode: item.code,
            type: isVideo ? 'video' : 'image',
            media_url: isVideo ? item.video_versions[0].url : item.image_versions2?.candidates?.[0]?.url || null,
            taken_at: item.taken_at || null,
            caption: item.caption?.text || '',
            accessibility_caption: item.accessibility_caption || '',
            like_count: item.like_count || 0,
            comment_count: item.comment_count || 0,
            view_count: item.view_count || null,
            comments_disabled: item.comments_disabled === true,
            counts_hidden: item.like_and_view_counts_disabled === true,
            location: item.location
                ? {
                    name: item.location.name || '',
                    lat: item.location.lat || null,
                    lng: item.location.lng || null
                }
                : null,
            author: {
                id: item.user?.pk ?? null,
                username: item.user?.username ?? null,
                full_name: item.user?.full_name || '',
                is_verified: item.user?.is_verified || false
            }
        }
    }

    static cleanCommentsData(rawData: GraphData | null): CommentsResult {
        const connection = rawData?.xdt_api__v1__media__media_id__comments__connection
        if (!connection) {
            return {comments: [], pagination: {has_next_page: false, end_cursor: null}}
        }

        const comments = (connection.edges || []).map((edge: any) => ({
            id: edge.node.pk,
            text: edge.node.text,
            created_at: edge.node.created_at,
            like_count: edge.node.comment_like_count || 0,
            reply_count: edge.node.child_comment_count || 0,
            author: {
                username: edge.node.user?.username ?? null,
                is_verified: edge.node.user?.is_verified || false
            }
        }))

        return {
            comments,
            pagination: {
                has_next_page: connection.page_info?.has_next_page || false,
                end_cursor: connection.page_info?.end_cursor || null
            }
        }
    }

    static async fetchMissingData(
        shortcode: string,
        shortcodeWebInfo: string | null,
        commentsConnection: string | null
    ): Promise<{
        shortcodeWebInfo: string | null
        commentsConnection: string | null
        fetchFailed: boolean
    }> {
        if (shortcodeWebInfo && commentsConnection) {
            return {shortcodeWebInfo, commentsConnection, fetchFailed: false}
        }

        try {
            const url = `https://www.instagram.com/p/${shortcode}/`
            const response = await fetch(url, {
                headers: {
                    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
                },
                referrer: url,
                method: 'GET',
                mode: 'cors',
                credentials: 'include'
            })

            if (!response.ok) {
                console.error('请求失败:', response.status)
                return {shortcodeWebInfo, commentsConnection, fetchFailed: true}
            }


            const html = await response.text()
            return {
                shortcodeWebInfo: shortcodeWebInfo || Extractor.extractScriptContent(html, 'xdt_api__v1__media__shortcode__web_info'),
                commentsConnection: commentsConnection || Extractor.extractScriptContent(html, 'xdt_api__v1__media__media_id__comments__connection'),
                fetchFailed: false
            }
        } catch (error) {
            console.error('请求失败:', error)
            return {shortcodeWebInfo, commentsConnection, fetchFailed: true}
        }
    }

    static async extractPostData(shortcode: string): Promise<ExtractResult | null> {
        let shortcodeWebInfo = Extractor.findScriptByKey('xdt_api__v1__media__shortcode__web_info')?.textContent || null
        let commentsConnection = Extractor.findScriptByKey('xdt_api__v1__media__media_id__comments__connection')?.textContent || null

        const fetched = await Extractor.fetchMissingData(shortcode, shortcodeWebInfo, commentsConnection)
        shortcodeWebInfo = fetched.shortcodeWebInfo
        commentsConnection = fetched.commentsConnection
        if (fetched.fetchFailed) {
            return null
        }

        let mediaData = null
        if (shortcodeWebInfo) {
            const rawData = Extractor.extractDataFromScript(shortcodeWebInfo)
            if (rawData) {
                mediaData = Extractor.cleanMediaData(rawData)
            }
        }

        let commentsData: CommentsResult = {
            comments: [],
            pagination: {has_next_page: false, end_cursor: null}
        }
        if (commentsConnection) {
            const rawData = Extractor.extractDataFromScript(commentsConnection)
            if (rawData) {
                commentsData = Extractor.cleanCommentsData(rawData)
            }
        }

        return {
            media: mediaData,
            comments: commentsData.comments,
            pagination: commentsData.pagination,
            media_analysis: ''
        }
    }

    private static findResultData(obj: any): any | null {
        if (obj === null || obj === undefined) {
            return null
        }

        if (typeof obj === 'object' && obj.result && obj.result.data) {
            return obj.result.data
        }

        if (typeof obj === 'object') {
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    const result = Extractor.findResultData(obj[key])
                    if (result !== null) {
                        return result
                    }
                }
            }
        }

        return null
    }
}

export class Analyzer {
    static async callAIAnalysis(mediaUrl: string): Promise<string | null> {
        return analyzeMedia(mediaUrl)
    }

    static async downloadSuccessResult(result: ExtractResult, shortcode: string): Promise<void> {
        const jsonOutput = JSON.stringify(result, null, 2)
        console.log('=== AI分析结果 ===\n', jsonOutput)
        await Analyzer.downloadText(`${shortcode}.txt`, jsonOutput)
    }

    static async downloadFallbackResult(result: ExtractResult, shortcode: string, filename: string): Promise<void> {
        const output = await Analyzer.buildFallbackOutput(result)

        if (result.media?.media_url) {
            await Analyzer.downloadMedia(result.media.media_url, filename)
        }

        console.log('=== 降级方案数据 ===\n', output)
        await Analyzer.downloadText(`${shortcode}.txt`, output)
    }

    private static async buildFallbackOutput(result: ExtractResult): Promise<string> {
        const instruction = '根据规则分析图片，将结果填入到 media_analysis[string]，最终只输出填充好 media_analysis 字段后的完整 json，禁止做出未要求的更改。'

        return `${instruction}\n\n${MEDIA_PROMPT}\n\n${JSON.stringify(result, null, 2)}`
    }

    private static async downloadText(filename: string, content: string): Promise<void> {
        const blob = new Blob([content], {type: 'text/plain'})
        const url = URL.createObjectURL(blob)
        await chrome.runtime.sendMessage({action: 'download', url, filename})
    }

    private static async downloadMedia(mediaUrl: string, filename: string): Promise<void> {
        await chrome.runtime.sendMessage({action: 'download', url: mediaUrl, filename})
    }
}

export class UiHelper {
    static getAnalysisButton(): HTMLButtonElement | null {
        return document.getElementById('ig-analytics-button') as HTMLButtonElement | null
    }

    static setButtonState(button: HTMLButtonElement | null, loading: boolean): void {
        if (!button) return
        if (loading) {
            button.textContent = '分析中...'
            button.disabled = true
            button.style.opacity = '0.6'
            button.style.cursor = 'not-allowed'
        } else {
            button.textContent = '分析'
            button.disabled = false
            button.style.opacity = '1'
            button.style.cursor = 'pointer'
        }
    }


    static injectButton(onClick: () => Promise<void>): void {
        if (!UiHelper.isPostPage()) {
            const existingBtn = UiHelper.getAnalysisButton()
            if (existingBtn) existingBtn.remove()
            return
        }

        if (UiHelper.getAnalysisButton()) {
            return
        }

        const container = UiHelper.findButtonContainer()
        if (!container) {
            return
        }

        const button = UiHelper.createAnalysisButton(onClick)
        container.appendChild(button)
    }

    static observeDOM(onClick: () => Promise<void>): void {
        const observer = new MutationObserver(() => {
            clearTimeout((UiHelper.observeDOM as typeof UiHelper.observeDOM & { timeout?: number }).timeout)
            ;(UiHelper.observeDOM as typeof UiHelper.observeDOM & {
                timeout?: number
            }).timeout = window.setTimeout(() => {
                UiHelper.injectButton(onClick)
            }, 500)
        })

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'id']
        })
    }

    private static isPostPage(): boolean {
        return /\/(p|reel)\/[A-Za-z0-9_-]+/.test(window.location.pathname)
    }

    private static findButtonContainer(): HTMLElement | null {
        const selectors = [
            '//div[@class="_aasi"]',
            '//div[@class="xyinxu5 xv54qhq x1g2khh7 xf7dkkf"]'
        ]

        for (const selector of selectors) {
            const result = document.evaluate(
                selector,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
            )
            if (result.singleNodeValue) {
                return result.singleNodeValue as HTMLElement
            }
        }

        return null
    }

    private static createAnalysisButton(onClick: () => Promise<void>): HTMLButtonElement {
        const button = document.createElement('button')
        button.id = 'ig-analytics-button'
        button.textContent = '分析'
        button.style.cssText = `
    padding: 8px 16px;
    margin-left: 8px;
    background-color: #0095f6;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    transition: background-color 0.2s;
  `

        button.addEventListener('mouseenter', function () {
            this.style.backgroundColor = '#0a66c2'
        })

        button.addEventListener('mouseleave', function () {
            this.style.backgroundColor = '#0095f6'
        })

        button.addEventListener('click', () => {
            void onClick()
        })
        return button
    }
}
