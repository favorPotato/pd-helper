import {analyzeMedia} from '../../shared/api'
import {MEDIA_PROMPT} from '../../shared/env'
import type {ExtractResult, MediaAnalysis} from '../../types'
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
    private static async fetchMoreComments(
        mediaId: string,
        initial: CommentsResult,
        maxPages: number
    ): Promise<CommentsResult> {
        if (!mediaId || maxPages <= 1) return initial
        let pageCount = 1
        let nextMinId = initial.pagination.end_cursor
        let hasMore = initial.pagination.has_next_page
        const comments = initial.comments.slice()

        while (hasMore && nextMinId && pageCount < maxPages) {
            const page = await RequestHelper.fetchCommentsPage(mediaId, nextMinId)
            if (!page) break
            comments.push(...page.comments)
            nextMinId = page.nextMinId
            hasMore = page.hasMore
            pageCount += 1
        }

        return {
            comments,
            pagination: {
                has_next_page: hasMore,
                end_cursor: nextMinId
            }
        }
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

    private static pickMediaUrl(item: any): string | null {
        const videoUrl = item?.video_versions?.[0]?.url
        if (typeof videoUrl === 'string' && videoUrl) return videoUrl
        const imageUrl = item?.image_versions2?.candidates?.[0]?.url
        if (typeof imageUrl === 'string' && imageUrl) return imageUrl
        return null
    }

    private static collectCarouselMediaUrls(raw: any): string[] {
        if (!Array.isArray(raw)) return []
        const urls = raw
            .map((item) => Extractor.pickMediaUrl(item))
            .filter((url): url is string => typeof url === 'string' && url.length > 0)
        return Array.from(new Set(urls))
    }

    private static parseDashDuration(manifest: unknown): number | null {
        if (typeof manifest !== 'string' || !manifest) return null

        const attrMatch = /mediaPresentationDuration="([^"]+)"/.exec(manifest)
        const raw = attrMatch?.[1] || /PT[0-9HMS.]+/i.exec(manifest)?.[0] || null
        if (!raw) return null

        const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(raw)
        if (!match) return null

        const hours = Number(match[1] || 0)
        const minutes = Number(match[2] || 0)
        const seconds = Number.parseFloat(match[3] || '0')
        const total = hours * 3600 + minutes * 60 + seconds
        return Number.isFinite(total) ? total : null
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
        const videoDuration = Extractor.parseDashDuration(item.video_dash_manifest)
        const mediaUrl = Extractor.pickMediaUrl(item)
        const carouselMediaUrls = isCarousel ? Extractor.collectCarouselMediaUrls(item.carousel_media) : []

        return {
            id: String(item.pk ?? ''),
            shortcode: item.code,
            media_type: isCarousel ? 'carousel' : isReels ? 'reels' : 'post',
            type: isVideo ? 'video' : 'image',
            media_url: mediaUrl,
            media_urls: carouselMediaUrls.length > 0 ? carouselMediaUrls : null,
            taken_at: item.taken_at || null,
            caption: captionText,
            mentions: Extractor.extractMentions(captionText),
            hashtags: Extractor.extractHashtags(captionText),
            is_collaboration: collaborators.length > 0,
            collaborators,
            is_carousel: isCarousel,
            carousel_count: carouselCount ?? (hasCarouselMedia ? item.carousel_media.length : null),
            accessibility_caption: typeof item.accessibility_caption === 'string' && item.accessibility_caption
                ? item.accessibility_caption
                : null,
            like_count: item.like_count || 0,
            comment_count: item.comment_count || 0,
            view_count: viewCount,
            video_duration: videoDuration,
            comments_disabled: item.comments_disabled === true,
            counts_hidden: item.like_and_view_counts_disabled === true,
            like_and_view_counts_disabled: item.like_and_view_counts_disabled === true,
            location: item.location
                ? {
                    name: item.location.name || '',
                    lat: item.location.lat || null,
                    lng: item.location.lng || null
                }
                : null,
            author: {
                id: item.user?.pk !== undefined && item.user?.pk !== null ? String(item.user.pk) : null,
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

        let mediaData: CleanedMedia | null = null
        if (shortcodeWebInfo) {
            const rawData = Extractor.extractDataFromScript(shortcodeWebInfo)
            if (rawData) {
                mediaData = Extractor.cleanMediaData(rawData)
            }
        }

        const author = mediaData?.author
        if (author) {
            const username = author.username
            const profile = username ? await RequestHelper.fetchProfileV1(username) : null
            if (profile) {
                if (!author.id && profile.id) {
                    author.id = profile.id
                }
                if (author.followers_count === null && profile.followersCount !== null) {
                    author.followers_count = profile.followersCount
                }
                if (author.bio === null && profile.bio !== null) {
                    author.bio = profile.bio
                }
            }

            const userId = author.id
            if (userId) {
                const about = await RequestHelper.fetchAboutGql(userId)
                if (about) {
                    if (author.account_location === null && about.accountLocation) {
                        author.account_location = about.accountLocation
                    }
                    if (author.joined_date === null && about.joinedDate) {
                        author.joined_date = about.joinedDate
                    }
                }
            }
        }

        if (
            mediaData &&
            mediaData.media_type === 'reels' &&
            mediaData.view_count === null &&
            !mediaData.counts_hidden &&
            mediaData.id
        ) {
            const viewCount = await RequestHelper.fetchMediaInfoViewCount(mediaData.id)
            if (typeof viewCount === 'number') {
                mediaData.view_count = viewCount
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

        const mediaId = mediaData?.id
        if (mediaId && commentsData.pagination.has_next_page && commentsData.pagination.end_cursor) {
            commentsData = await Extractor.fetchMoreComments(mediaId, commentsData, 5)
        }

        return {
            media: mediaData,
            comments: commentsData.comments,
            media_analysis: {
                description: '',
                per_image_notes: null,
                visual_tags: [],
                tone: '',
                hook_points: [],
                text_in_image: null,
                opening_hook: null,
                turning_point: null,
                highlight_moment: null
            }
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
    static async callAIAnalysis(mediaUrl: string | string[]): Promise<MediaAnalysis | null> {
        const result = await analyzeMedia(mediaUrl)
        if (!result) return null
        return Analyzer.parseMediaAnalysis(result)
    }

    private static parseMediaAnalysis(raw: string): MediaAnalysis | null {
        try {
            const parsed = JSON.parse(raw) as unknown
            if (typeof parsed === 'object' && parsed !== null && 'media_analysis' in parsed) {
                const container = parsed as {media_analysis?: unknown}
                const nested = Analyzer.normalizeMediaAnalysis(container.media_analysis)
                if (nested) return nested
            }
            return Analyzer.normalizeMediaAnalysis(parsed)
        } catch (error) {
            console.error('AI分析结果解析失败:', error)
            return null
        }
    }

    private static normalizeMediaAnalysis(raw: unknown): MediaAnalysis | null {
        if (typeof raw !== 'object' || raw === null) return null
        const data = raw as Record<string, unknown>
        const perImageNotes = Array.isArray(data.per_image_notes)
            ? data.per_image_notes.filter((item) => typeof item === 'string')
            : data.per_image_notes === null
                ? null
                : null
        return {
            description: typeof data.description === 'string' ? data.description : '',
            per_image_notes: perImageNotes,
            visual_tags: Array.isArray(data.visual_tags)
                ? data.visual_tags.filter((item) => typeof item === 'string')
                : [],
            tone: typeof data.tone === 'string' ? data.tone : '',
            hook_points: Array.isArray(data.hook_points)
                ? data.hook_points.filter((item) => typeof item === 'string')
                : [],
            text_in_image: typeof data.text_in_image === 'string' ? data.text_in_image : null,
            opening_hook: typeof data.opening_hook === 'string' ? data.opening_hook : null,
            turning_point: typeof data.turning_point === 'string' ? data.turning_point : null,
            highlight_moment: typeof data.highlight_moment === 'string' ? data.highlight_moment : null
        }
    }

    private static buildOutputResult(result: ExtractResult): ExtractResult {
        const media = result.media ? {...result.media} : null
        if (media) {
            delete (media as {media_url?: string | null}).media_url
            delete (media as {media_urls?: string[] | null}).media_urls
        }
        const comments = result.comments.map((comment) => ({...comment}))
        return {...result, media, comments}
    }

    static async downloadSuccessResult(result: ExtractResult, shortcode: string): Promise<void> {
        const jsonOutput = JSON.stringify(Analyzer.buildOutputResult(result), null, 2)
        console.log('=== AI分析结果 ===\n', jsonOutput)
        await Analyzer.downloadText(`${shortcode}.txt`, jsonOutput)
    }

    static async downloadFallbackResult(result: ExtractResult, shortcode: string, filename: string): Promise<void> {
        const output = await Analyzer.buildFallbackOutput(result)

        if (result.media?.media_type === 'carousel' && Array.isArray(result.media.media_urls)) {
            const urls = result.media.media_urls
            for (let i = 0; i < urls.length; i += 1) {
                const url = urls[i]
                if (!url) continue
                const indexedFilename = Analyzer.buildIndexedFilename(filename, i + 1)
                await Analyzer.downloadMedia(url, indexedFilename)
            }
        } else if (result.media?.media_url) {
            await Analyzer.downloadMedia(result.media.media_url, filename)
        }

        console.log('=== 降级方案数据 ===\n', output)
        await Analyzer.downloadText(`${shortcode}.txt`, output)
    }

    private static async buildFallbackOutput(result: ExtractResult): Promise<string> {
        const instruction = '根据规则分析图片，将结果填入到 media_analysis[object]，只允许修改 media_analysis 内部字段，最终只输出填充好 media_analysis 字段后的完整 json。'

        const payload = JSON.stringify(Analyzer.buildOutputResult(result), null, 2)
        return `${instruction}\n\n${MEDIA_PROMPT}\n\n${payload}`
    }

    private static buildIndexedFilename(filename: string, index: number): string {
        const dot = filename.lastIndexOf('.')
        if (dot === -1) return `${filename}-${index}`
        const base = filename.slice(0, dot)
        const ext = filename.slice(dot)
        return `${base}-${index}${ext}`
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


