import {analyzeMedia} from '../../shared/api'
import {MEDIA_PROMPT} from '../../shared/env'
import type {ExtractResult} from '../../types'
import type {CleanedMedia, CommentsResult} from './types'
import {RequestHelper} from './helpers'

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

    private static extractMentions(text: string): string[] {
        if (!text) return []
        const result = new Set<string>()
        const regex = /@([A-Za-z0-9._]+)/g
        let match: RegExpExecArray | null = regex.exec(text)
        while (match) {
            result.add(`@${match[1]}`)
            match = regex.exec(text)
        }
        return Array.from(result)
    }

    private static extractHashtags(text: string): string[] {
        if (!text) return []
        const result = new Set<string>()
        const regex = /#([A-Za-z0-9_]+)/g
        let match: RegExpExecArray | null = regex.exec(text)
        while (match) {
            result.add(`#${match[1]}`)
            match = regex.exec(text)
        }
        return Array.from(result)
    }

    private static mapCollaborators(raw: any): string[] {
        if (!Array.isArray(raw)) return []
        const names = raw
            .map((user) => (typeof user?.username === 'string' ? user.username : ''))
            .filter((name) => name)
        return Array.from(new Set(names))
    }

    static cleanMediaData(rawData: GraphData | null): CleanedMedia | null {
        const item = rawData?.xdt_api__v1__media__shortcode__web_info?.items?.[0]
        if (!item) return null

        const captionText = item.caption?.text || ''
        const rawMediaType = typeof item.media_type === 'number' ? item.media_type : null
        const productType = typeof item.product_type === 'string' ? item.product_type : ''
        const carouselCount = typeof item.carousel_media_count === 'number' ? item.carousel_media_count : null
        const hasCarouselMedia = Array.isArray(item.carousel_media) && item.carousel_media.length > 0
        const isCarousel =
            rawMediaType === 8 ||
            productType === 'carousel_container' ||
            hasCarouselMedia ||
            (typeof carouselCount === 'number' && carouselCount > 1)
        const isReels = productType === 'clips' || rawMediaType === 2
        const isVideo = Array.isArray(item.video_versions) && item.video_versions.length > 0
        const collaborators = Extractor.mapCollaborators(item.coauthor_producers)
        const viewCount = item.view_count ?? item.play_count ?? null
        const videoDuration = typeof item.video_duration === 'number' ? item.video_duration : null

        return {
            id: item.pk,
            shortcode: item.code,
            media_type: isCarousel ? 'carousel' : isReels ? 'reels' : 'post',
            type: isVideo ? 'video' : 'image',
            media_url: isVideo ? item.video_versions[0].url : item.image_versions2?.candidates?.[0]?.url || null,
            taken_at: item.taken_at || null,
            caption: captionText,
            mentions: Extractor.extractMentions(captionText),
            hashtags: Extractor.extractHashtags(captionText),
            is_collaboration: collaborators.length > 0,
            collaborators,
            is_carousel: isCarousel,
            carousel_count: carouselCount ?? (hasCarouselMedia ? item.carousel_media.length : null),
            accessibility_caption: item.accessibility_caption || '',
            like_count: item.like_count || 0,
            comment_count: item.comment_count || 0,
            view_count: viewCount,
            video_duration: videoDuration,
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
                is_verified: item.user?.is_verified || false,
                followers_count: item.user?.follower_count ?? null,
                account_location: null,
                joined_date: null,
                bio: item.user?.biography ?? null
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
            const html = await RequestHelper.fetchPostHtml(shortcode)
            if (!html) {
                return {shortcodeWebInfo, commentsConnection, fetchFailed: true}
            }
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

        if (mediaData?.author) {
            const username = mediaData.author.username
            const profile = username ? await RequestHelper.fetchProfileV1(username) : null
            if (profile) {
                if (!mediaData.author.id && profile.id) {
                    mediaData.author.id = profile.id
                }
                if (mediaData.author.followers_count === null && profile.followersCount !== null) {
                    mediaData.author.followers_count = profile.followersCount
                }
                if (mediaData.author.bio === null && profile.bio !== null) {
                    mediaData.author.bio = profile.bio
                }
            }

            const userId = mediaData.author.id
            if (userId) {
                const about = await RequestHelper.fetchAboutGql(userId)
                if (about) {
                    if (mediaData.author.account_location === null && about.accountLocation) {
                        mediaData.author.account_location = about.accountLocation
                    }
                    if (mediaData.author.joined_date === null && about.joinedDate) {
                        mediaData.author.joined_date = about.joinedDate
                    }
                }
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


