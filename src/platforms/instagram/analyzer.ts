import {MEDIA_PROMPT} from '../../shared/env'
import {sleepRandom} from '../../shared/timing'
import type {ExtractResult} from '../../types'
import type {
    AccountOutput,
    CleanedMedia,
    CollectorOutput,
    CommentOutput,
    CommentsResult,
    MediaRouteKind,
    PostOutput,
    ReelsCollectRange
} from './types'
import {RequestHelper} from './helpers'

type ScriptNode = HTMLScriptElement | null

type GraphData = {
    xdt_api__v1__media__shortcode__web_info?: {
        items?: Array<any>
    }
    xdt_api__v1__clips__home__connection_v2?: {
        edges?: Array<{node?: {media?: any}}>
    }
    xdt_api__v1__clips__user__connection_v2?: {
        edges?: Array<{node?: {media?: any}}>
    }
    xdt_api__v1__media__media_id__comments__connection?: {
        edges?: Array<any>
        page_info?: {
            has_next_page?: boolean
            end_cursor?: string | null
        }
    }
}

type ExtractOptions = {
    routeKind?: MediaRouteKind
    commentsMode?: 'paginate' | 'first_page_only'
    mediaId?: string
}

const MEDIA_SCRIPT_KEYS = [
    'xdt_api__v1__media__shortcode__web_info',
    'xdt_api__v1__clips__home__connection_v2',
    'xdt_api__v1__clips__user__connection_v2'
] as const


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

    static findScriptByKeys(keys: readonly string[]): ScriptNode {
        for (const key of keys) {
            const script = Extractor.findScriptByKey(key)
            if (script) return script
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

    static extractScriptContentByKeys(html: string, keys: readonly string[]): string | null {
        for (const key of keys) {
            const content = Extractor.extractScriptContent(html, key)
            if (content) return content
        }
        return null
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

    private static getRawMediaItem(rawData: GraphData | null): any | null {
        return rawData?.xdt_api__v1__media__shortcode__web_info?.items?.[0]
            || rawData?.xdt_api__v1__clips__home__connection_v2?.edges?.[0]?.node?.media
            || rawData?.xdt_api__v1__clips__user__connection_v2?.edges?.[0]?.node?.media
            || null
    }

    private static pickThumbnailUrl(item: any): string | null {
        const imageUrl = item?.image_versions2?.candidates?.[0]?.url
        if (typeof imageUrl === 'string' && imageUrl) return imageUrl
        const displayUrl = item?.display_uri
        if (typeof displayUrl === 'string' && displayUrl) return displayUrl
        return null
    }

    private static extractMusicInfo(item: any): {
        music_id: string | null
        music_title: string | null
        music_artist: string | null
        is_original_audio: boolean | null
    } {
        const primaryMusicInfo = item?.music_info
        const reelsMusicInfo = item?.clips_metadata?.music_info
        const musicInfo = primaryMusicInfo && typeof primaryMusicInfo === 'object'
            ? primaryMusicInfo
            : reelsMusicInfo && typeof reelsMusicInfo === 'object'
                ? reelsMusicInfo
                : null

        const asset = musicInfo?.music_asset_info
        if (asset && typeof asset === 'object') {
            return {
                music_id: asset?.audio_cluster_id !== undefined && asset?.audio_cluster_id !== null ? String(asset.audio_cluster_id) : null,
                music_title: typeof asset?.title === 'string' ? asset.title : null,
                music_artist: typeof asset?.display_artist === 'string' ? asset.display_artist : null,
                is_original_audio: typeof musicInfo?.is_original_audio === 'boolean'
                    ? musicInfo.is_original_audio
                    : null
            }
        }

        const originalSound = item?.original_sound_info
        return {
            music_id: originalSound?.audio_asset_id !== undefined && originalSound?.audio_asset_id !== null
                ? String(originalSound.audio_asset_id)
                : null,
            music_title: typeof originalSound?.original_audio_title === 'string' ? originalSound.original_audio_title : null,
            music_artist: typeof originalSound?.ig_artist?.username === 'string' ? originalSound.ig_artist.username : null,
            is_original_audio: originalSound ? true : null
        }
    }

    static cleanMediaData(rawData: GraphData | null): CleanedMedia | null {
        const item = Extractor.getRawMediaItem(rawData)
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
        const thumbnailUrl = Extractor.pickThumbnailUrl(item)
        const carouselMediaUrls = isCarousel ? Extractor.collectCarouselMediaUrls(item.carousel_media) : []
        const music = Extractor.extractMusicInfo(item)

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
            like_count: typeof item.like_count === 'number' ? item.like_count : 0,
            comment_count: typeof item.comment_count === 'number' ? item.comment_count : 0,
            view_count: viewCount,
            video_duration: videoDuration,
            thumbnail_url: thumbnailUrl,
            music_id: music.music_id,
            music_title: music.music_title,
            music_artist: music.music_artist,
            is_original_audio: music.is_original_audio,
            comments_disabled: typeof item.comments_disabled === 'boolean' ? item.comments_disabled : null,
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
            return {
                comments: [],
                pagination: {has_next_page: false, end_cursor: null}
            }
        }

        const comments = (connection.edges || []).map((edge: any) => ({
            comment_id: edge?.node?.pk !== undefined && edge?.node?.pk !== null
                ? String(edge.node.pk)
                : edge?.node?.id !== undefined && edge?.node?.id !== null
                    ? String(edge.node.id)
                    : null,
            text: edge.node.text,
            created_at: edge.node.created_at,
            like_count: typeof edge?.node?.comment_like_count === 'number' ? edge.node.comment_like_count : 0,
            reply_count: typeof edge?.node?.child_comment_count === 'number' ? edge.node.child_comment_count : 0,
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
        commentsConnection: string | null,
        routeKind: MediaRouteKind,
        mediaId: string | null
    ): Promise<{
        shortcodeWebInfo: string | null
        commentsConnection: string | null
        commentsPage: {comments: any[]; nextMinId: string | null; hasMore: boolean} | null
        fetchFailed: boolean
    }> {
        const needsHtml = !shortcodeWebInfo || (routeKind !== 'reels' && !commentsConnection)
        const shouldPrefetchComments = routeKind === 'reels' && !!mediaId

        if (!needsHtml && !shouldPrefetchComments) {
            return {shortcodeWebInfo, commentsConnection, commentsPage: null, fetchFailed: false}
        }

        try {
            const [html, commentsPage] = await Promise.all([
                needsHtml ? RequestHelper.fetchPostHtml(shortcode, routeKind) : null,
                shouldPrefetchComments && mediaId ? RequestHelper.fetchCommentsPage(mediaId, null) : null
            ])

            if (needsHtml && !html) {
                return {shortcodeWebInfo, commentsConnection, commentsPage, fetchFailed: true}
            }

            const fetchedShortcodeWebInfo = html ? Extractor.extractScriptContentByKeys(html, MEDIA_SCRIPT_KEYS) : null
            const fetchedCommentsConnection = html
                ? Extractor.extractScriptContent(html, 'xdt_api__v1__media__media_id__comments__connection')
                : null

            return {
                shortcodeWebInfo: commentsConnection ? (shortcodeWebInfo || fetchedShortcodeWebInfo) : (fetchedShortcodeWebInfo || shortcodeWebInfo),
                commentsConnection: commentsConnection || fetchedCommentsConnection,
                commentsPage,
                fetchFailed: false
            }
        } catch (error) {
            console.error('请求失败:', error)
            return {shortcodeWebInfo, commentsConnection, commentsPage: null, fetchFailed: true}
        }
    }

    static async extractPostData(shortcode: string, options: ExtractOptions = {}): Promise<ExtractResult | null> {
        const routeKind = options.routeKind || 'p'
        const commentsMode = options.commentsMode || 'paginate'
        const mediaIdFromOptions = options.mediaId || null

        let shortcodeWebInfo = Extractor.findScriptByKeys(MEDIA_SCRIPT_KEYS)?.textContent || null
        let commentsConnection = Extractor.findScriptByKey('xdt_api__v1__media__media_id__comments__connection')?.textContent || null

        const fetched = await Extractor.fetchMissingData(shortcode, shortcodeWebInfo, commentsConnection, routeKind, mediaIdFromOptions)
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
                if (!author.username && profile.username) {
                    author.username = profile.username
                }
                if (!author.full_name && profile.fullName) {
                    author.full_name = profile.fullName
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
        if (routeKind === 'reels' && fetched.commentsPage) {
            commentsData = {
                comments: fetched.commentsPage.comments,
                pagination: {
                    has_next_page: fetched.commentsPage.hasMore,
                    end_cursor: fetched.commentsPage.nextMinId
                }
            }
        } else if (commentsConnection) {
            const rawData = Extractor.extractDataFromScript(commentsConnection)
            if (rawData) {
                commentsData = Extractor.cleanCommentsData(rawData)
            }
        }

        const mediaId = mediaData?.id
        if (commentsMode === 'paginate' && mediaId && commentsData.pagination.has_next_page && commentsData.pagination.end_cursor) {
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
    static buildScriptApiPostData(result: ExtractResult): {
        post_id: string
        shortcode: string | null
        caption: string | null
        accessibility_caption: string | null
        location: {name: string; lat: number | null; lng: number | null} | null
        hashtags: string[]
        mentions: string[]
        taken_at: number | null
        media_type: string | null
        type: string | null
        is_carousel: boolean
        carousel_count: number | null
        comments_disabled: boolean
        author: {username: string | null} | null
    } {
        const media = result.media

        return {
            post_id: media?.id || '',
            shortcode: media?.shortcode || null,
            caption: media?.caption || null,
            accessibility_caption: media?.accessibility_caption || null,
            location: media?.location || null,
            hashtags: Array.isArray(media?.hashtags) ? [...media.hashtags] : [],
            mentions: Array.isArray(media?.mentions) ? [...media.mentions] : [],
            taken_at: media?.taken_at ?? null,
            media_type: media?.media_type || null,
            type: media?.type || null,
            is_carousel: media?.is_carousel === true,
            carousel_count: media?.carousel_count ?? null,
            comments_disabled: media?.comments_disabled === true,
            author: media?.author ? {username: media.author.username ?? null} : null
        }
    }

    private static mapMediaType(media: CleanedMedia): 'reels' | 'image' | 'carousel' {
        if (media.media_type === 'reels') return 'reels'
        if (media.media_type === 'carousel') return 'carousel'
        return media.type === 'image' ? 'image' : 'reels'
    }

    private static mapPostOutput(media: CleanedMedia): PostOutput {
        return {
            id: media.id,
            shortcode: media.shortcode,
            taken_at: media.taken_at,
            media_type: Analyzer.mapMediaType(media),
            view_count: media.view_count,
            like_count: media.like_count,
            comment_count: media.comment_count,
            video_duration: media.video_duration,
            caption: media.caption || null,
            hashtags: media.hashtags,
            mentions: media.mentions,
            thumbnail_url: media.thumbnail_url,
            media_url: media.media_url,
            music_id: media.music_id ?? null,
            music_title: media.music_title ?? null,
            music_artist: media.music_artist ?? null,
            is_original_audio: media.is_original_audio ?? null,
            location: media.location?.name || null,
            is_collaboration: media.is_collaboration,
            comments_disabled: media.comments_disabled
        }
    }

    private static mapCommentOutput(comment: any): CommentOutput {
        return {
            comment_id: typeof comment?.comment_id === 'string' ? comment.comment_id : null,
            username: comment?.author?.username ?? null,
            text: typeof comment?.text === 'string' ? comment.text : '',
            created_at: typeof comment?.created_at === 'number' ? comment.created_at : 0,
            like_count: typeof comment?.like_count === 'number' ? comment.like_count : 0
        }
    }

    private static buildTimestampForFilename(date: Date): string {
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        const hour = String(date.getHours()).padStart(2, '0')
        const minute = String(date.getMinutes()).padStart(2, '0')
        const second = String(date.getSeconds()).padStart(2, '0')
        return `${year}${month}${day}_${hour}${minute}${second}`
    }

    static async collectReelsForUsername(
        username: string,
        log: (message: string) => void,
        range?: ReelsCollectRange | null,
        order: 'asc' | 'desc' = 'asc'
    ): Promise<{filename: string; output: CollectorOutput} | null> {
        const profile = await RequestHelper.fetchProfileV1(username)
        if (!profile) return null

        let accountLocation: string | null = null
        let joinedDate: string | null = null
        if (profile.id) {
            const about = await RequestHelper.fetchAboutGql(profile.id)
            accountLocation = about?.accountLocation || null
            joinedDate = about?.joinedDate || null
        }

        const account: AccountOutput = {
            username: profile.username,
            full_name: profile.fullName,
            bio: profile.bio,
            external_url: profile.externalUrls,
            followers_count: profile.followersCount,
            following_count: profile.followingCount,
            post_count: profile.postCount,
            is_verified: profile.isVerified,
            is_business_account: profile.isBusinessAccount,
            account_location: accountLocation,
            joined_date: joinedDate,
            profile_pic_url: profile.profilePicUrl
        }

        const allItems: Array<{id: string; shortcode: string}> = []
        const seen = new Set<string>()
        let after: string | null = null
        let page = 1

        while (true) {
            log(`抓取 reels 列表第 ${page} 页...`)
            const pageResult = await RequestHelper.fetchReelsPage(profile.id || '', after)
            if (!pageResult) break

            for (const item of pageResult.items) {
                if (seen.has(item.shortcode)) continue
                seen.add(item.shortcode)
                allItems.push(item)
            }

            if (!pageResult.pageInfo.has_next_page || !pageResult.pageInfo.end_cursor) break
            after = pageResult.pageInfo.end_cursor
            page += 1
            await sleepRandom(1200, 2000)
        }

        if (order === 'asc') {
            allItems.reverse()
        }

        const selectedItems = range
            ? allItems.slice(Math.max(0, range.start - 1), Math.min(allItems.length, range.end))
            : allItems

        if (range) {
            log(`时间线范围 ${range.start}-${range.end}，命中 ${selectedItems.length}/${allItems.length} 条`)
        } else {
            log(`按${order === 'asc' ? '正序' : '倒序'}处理全部 ${selectedItems.length} 条 reels`)
        }

        const posts: PostOutput[] = []
        let hasIncomplete = false

        for (let index = 0; index < selectedItems.length; index += 1) {
            const item = selectedItems[index]
            log(`抓取详情 ${index + 1}/${selectedItems.length}: ${item.shortcode}`)
            const result = await Extractor.extractPostData(item.shortcode, {
                routeKind: 'reels',
                commentsMode: 'first_page_only',
                mediaId: item.id
            })

            if (!result?.media) {
                hasIncomplete = true
                posts.push({id: item.id, shortcode: item.shortcode, error: 'fetch_failed'})
                continue
            }

            posts.push({
                ...Analyzer.mapPostOutput(result.media),
                comments: result.comments.map((comment) => Analyzer.mapCommentOutput(comment))
            })

            if (index < selectedItems.length - 1) {
                await sleepRandom(800, 1500)
            }
        }

        const crawledAt = new Date()
        const output: CollectorOutput = {
            account,
            posts,
            meta: {
                crawled_at: crawledAt.toISOString(),
                total_posts: posts.length,
                has_incomplete: hasIncomplete
            }
        }

        const filename = `${username}_${Analyzer.buildTimestampForFilename(crawledAt)}.json`
        return {filename, output}
    }

    static buildScriptPayload(result: ExtractResult): ExtractResult {
        const media = result.media ? {...result.media} : null
        if (media) {
            delete (media as {media_url?: string | null}).media_url
            delete (media as {media_urls?: string[] | null}).media_urls
        }
        const comments = result.comments.map((comment) => ({...comment}))
        return {...result, media, comments}
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

        await Analyzer.downloadText(`${shortcode}.txt`, output)
    }

    private static async buildFallbackOutput(result: ExtractResult): Promise<string> {
        const instruction = '根据规则分析图片，将结果填入到 media_analysis[object]，只允许修改 media_analysis 内部字段，最终只输出填充好 media_analysis 字段后的完整 json。'

        const payload = JSON.stringify(Analyzer.buildScriptPayload(result), null, 2)
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

    static async downloadJson(filename: string, data: unknown): Promise<void> {
        const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'})
        const url = URL.createObjectURL(blob)
        await chrome.runtime.sendMessage({action: 'download', url, filename})
    }

    private static async downloadMedia(mediaUrl: string, filename: string): Promise<void> {
        await chrome.runtime.sendMessage({action: 'download', url: mediaUrl, filename})
    }
}
