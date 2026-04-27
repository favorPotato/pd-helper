import {FixedOverlay} from '../../shared/ui-overlay'
import type {CleanedComment, MediaRouteKind, ReelsPageItem, ReelsPageResult} from './types'

export class InstagramRequestAbortError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'InstagramRequestAbortError'
    }
}

export class UiHelper {
    private static overlay: FixedOverlay | null = null
    private static urlCleanup: (() => void) | null = null
    private static lastStatusText = ''

    static async inject(handlers: {
        onManualAnalyze: () => Promise<void>
        onGenerateScript: () => Promise<void>
        onCollectReels: () => Promise<void>
        onCollectReelsDesc: () => Promise<void>
    }): Promise<void> {
        if (!UiHelper.overlay) {
            UiHelper.overlay = new FixedOverlay()
        }

        await UiHelper.overlay.inject('instagram')

        const shortcode = UrlHelper.getShortcode()
        const statusText = shortcode ? 'Instagram (Post)' : 'Instagram (Non-Post)'
        UiHelper.lastStatusText = statusText
        UiHelper.overlay.setStatus('instagram', statusText)

        UiHelper.overlay.addButton('手动分析', '#f57c00', async (e) => {
            e.stopPropagation()
            await handlers.onManualAnalyze()
        }, false)

        UiHelper.overlay.addButton('生成剧本', '#00897b', async (e) => {
            e.stopPropagation()
            await handlers.onGenerateScript()
        }, false)

        UiHelper.overlay.addButton('采集reels(正序)', '#8e24aa', async (e) => {
            e.stopPropagation()
            await handlers.onCollectReels()
        }, false)

        UiHelper.overlay.addButton('采集reels(倒序)', '#6a1b9a', async (e) => {
            e.stopPropagation()
            await handlers.onCollectReelsDesc()
        }, false)

        if (UiHelper.urlCleanup) {
            UiHelper.urlCleanup()
        }

        UiHelper.urlCleanup = UiHelper.overlay.observeUrl(async () => {
            UiHelper.refreshEnabledState()
        })

        UiHelper.refreshEnabledState()
    }

    static log(message: unknown) {
        if (UiHelper.overlay) {
            UiHelper.overlay.log(message)
        }
    }

    static refreshEnabledState() {
        if (!UiHelper.overlay) return

        const shortcode = UrlHelper.getShortcode()
        const hasShortcode = !!shortcode
        const isAccountReelsPage = UrlHelper.isAccountReelsPage()

        if (hasShortcode) {
            if (UiHelper.lastStatusText !== 'Instagram (Post)') {
                UiHelper.lastStatusText = 'Instagram (Post)'
                UiHelper.overlay.setStatus('instagram', 'Instagram (Post)')
            }
        } else {
            if (UiHelper.lastStatusText !== 'Instagram (Non-Post)') {
                UiHelper.lastStatusText = 'Instagram (Non-Post)'
                UiHelper.overlay.setStatus('instagram', 'Instagram (Non-Post)')
            }
        }

        UiHelper.overlay.setButtonVisible('手动分析', hasShortcode)
        UiHelper.overlay.setButtonEnabled('手动分析', hasShortcode)
        UiHelper.overlay.setButtonVisible('生成剧本', hasShortcode)
        UiHelper.overlay.setButtonEnabled('生成剧本', hasShortcode)
        UiHelper.overlay.setButtonVisible('采集reels(正序)', isAccountReelsPage)
        UiHelper.overlay.setButtonEnabled('采集reels(正序)', isAccountReelsPage)
        UiHelper.overlay.setButtonVisible('采集reels(倒序)', isAccountReelsPage)
        UiHelper.overlay.setButtonEnabled('采集reels(倒序)', isAccountReelsPage)
    }
}

export class UrlHelper {
    static getShortcode(): string | null {
        const match = window.location.pathname.match(/\/(p|reels?)\/([A-Za-z0-9_-]+)\//)
        return match ? match[2] : null
    }

    static getMediaRouteKindFromUrl(url: string = window.location.href): MediaRouteKind | null {
        const pathname = new URL(url, window.location.origin).pathname
        if (/^\/p\/[A-Za-z0-9_-]+\/$/.test(pathname)) return 'p'
        if (/^\/(?:reel|reels)\/[A-Za-z0-9_-]+\/$/.test(pathname)) return 'reels'
        return null
    }

    static getCurrentMediaRouteKind(): MediaRouteKind {
        return UrlHelper.getMediaRouteKindFromUrl() || 'p'
    }

    static isAccountReelsPage(url: string = window.location.href): boolean {
        const pathname = new URL(url, window.location.origin).pathname
        return /^\/[A-Za-z0-9._]+\/reels\/$/.test(pathname)
    }

    static getUsernameFromAccountReelsPage(url: string = window.location.href): string | null {
        const pathname = new URL(url, window.location.origin).pathname
        const match = pathname.match(/^\/([A-Za-z0-9._]+)\/reels\/$/)
        return match ? match[1] : null
    }
}

export class RequestHelper {
    private static async sleep(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms))
    }

    private static randomBetween(minMs: number, maxMs: number): number {
        const lower = Math.min(minMs, maxMs)
        const upper = Math.max(minMs, maxMs)
        return Math.floor(Math.random() * (upper - lower + 1)) + lower
    }

    private static ensureResponseAllowed(response: Response, requestLabel: string): void {
        if (response.status === 301 || response.redirected) {
            throw new InstagramRequestAbortError(`${requestLabel} 被重定向，终止采集`)
        }
    }

    private static async fetchWithRetry(
        input: RequestInfo | URL,
        init: RequestInit,
        requestLabel: string
    ): Promise<Response> {
        let attempt = 0

        while (true) {
            const response = await fetch(input, init)
            RequestHelper.ensureResponseAllowed(response, requestLabel)

            if (response.status !== 429) {
                return response
            }

            attempt += 1
            if (attempt >= 3) {
                return response
            }

            const delay = RequestHelper.randomBetween(30000, 60000)
            console.warn(`${requestLabel} 命中 429，第 ${attempt} 次重试前等待 ${delay}ms`)
            await RequestHelper.sleep(delay)
        }
    }

    private static extractFromHtml(patterns: RegExp[], html: string): string | null {
        for (const pattern of patterns) {
            const match = pattern.exec(html)
            if (match?.[1]) return match[1]
        }
        return null
    }

    private static getPageHtml(): string {
        return document.documentElement?.outerHTML || ''
    }

    private static buildCommentsUrl(mediaId: string, minId: string | null): string {
        const params = new URLSearchParams()
        params.set('can_support_threading', 'true')
        params.set('sort_order', 'popular')
        if (minId) params.set('min_id', minId)
        return `https://www.instagram.com/api/v1/media/${mediaId}/comments/?${params.toString()}`
    }

    private static buildAuthorizationHeader(dsUserId: string, sessionId: string): string | null {
        if (!dsUserId || !sessionId) return null
        const payload = JSON.stringify({ds_user_id: dsUserId, sessionid: sessionId})
        return `Bearer IGT:2:${btoa(payload)}`
    }

    private static async getAuthCookies(): Promise<{ds_user_id: string; sessionid: string; csrftoken: string} | null> {
        try {
            const response = await chrome.runtime.sendMessage({type: 'get_ig_cookies'})
            if (!response || response.ok !== true) return null
            const cookies = response.cookies || {}
            const dsUserId = String(cookies.ds_user_id || '')
            const sessionId = String(cookies.sessionid || '')
            const csrfToken = String(cookies.csrftoken || '')
            if (!dsUserId || !sessionId) return null
            return {ds_user_id: dsUserId, sessionid: sessionId, csrftoken: csrfToken}
        } catch (error) {
            console.error('获取cookies失败:', error)
            return null
        }
    }

    private static async getHeaderValues(): Promise<{claim: string; ajax: string; webSid: string} | null> {
        try {
            const response = await chrome.runtime.sendMessage({type: 'get_header_values'})
            if (!response || typeof response !== 'object') return null
            const claim = String((response as {claim?: string}).claim || '')
            const ajax = String((response as {ajax?: string}).ajax || '')
            const webSid = String((response as {webSid?: string}).webSid || '')
            return {claim, ajax, webSid}
        } catch (error) {
            console.error('获取headers失败:', error)
            return null
        }
    }

    private static async applyAuthHeaders(headers: Record<string, string>): Promise<void> {
        const auth = await RequestHelper.getAuthCookies()
        if (auth?.csrftoken) headers['x-csrftoken'] = auth.csrftoken

        const headerValues = await RequestHelper.getHeaderValues()
        if (headerValues?.claim) headers['x-ig-www-claim'] = headerValues.claim
        if (headerValues?.ajax) headers['x-instagram-ajax'] = headerValues.ajax
        if (headerValues?.webSid) headers['x-web-session-id'] = headerValues.webSid
    }

    private static getGraphqlTokens(): {fbDtsg: string; lsd: string; jazoest: string} | null {
        const html = RequestHelper.getPageHtml()
        if (!html) return null

        const lsd = RequestHelper.extractFromHtml([
            /"LSD",\[\],\{"token":"([^"]+)"/,
            /\["LSD",\[],\{"token":"([^"]+)"/
        ], html)
        const fbDtsg = RequestHelper.extractFromHtml([
            /"DTSGInitialData",\[\],\{"token":"([^"]+)"/,
            /"DTSGInitData",\[\],\{"token":"([^"]+)"/
        ], html)
        const jazoest = RequestHelper.extractFromHtml([
            /jazoest=([0-9]+)/,
            /"jazoest":"?([0-9]+)"?/
        ], html)

        if (!lsd || !fbDtsg || !jazoest) return null
        return {fbDtsg, lsd, jazoest}
    }

    static async fetchCommentsPage(
        mediaId: string,
        minId: string | null
    ): Promise<{comments: CleanedComment[]; nextMinId: string | null; hasMore: boolean} | null> {
        if (!mediaId) return null
        const url = RequestHelper.buildCommentsUrl(mediaId, minId)
        const headers: Record<string, string> = {
            accept: '*/*',
            'x-asbd-id': '359341',
            'x-ig-app-id': '936619743392459',
            'x-requested-with': 'XMLHttpRequest'
        }

        await RequestHelper.applyAuthHeaders(headers)

        try {
            const response = await RequestHelper.fetchWithRetry(url, {
                method: 'GET',
                headers,
                mode: 'cors',
                credentials: 'include'
            }, 'reels 评论请求')
            if (!response.ok) return null
            const data = (await response.json()) as {
                comments?: Array<{
                    pk?: unknown
                    id?: unknown
                    text?: unknown
                    created_at?: unknown
                    comment_like_count?: unknown
                    child_comment_count?: unknown
                    user?: {username?: unknown; is_verified?: unknown}
                }>
                has_more_headload_comments?: unknown
                next_min_id?: unknown
            }

            const rawComments = Array.isArray(data.comments) ? data.comments : []
            const comments = rawComments.map((comment) => ({
                comment_id: comment?.pk !== undefined && comment?.pk !== null
                    ? String(comment.pk)
                    : comment?.id !== undefined && comment?.id !== null
                        ? String(comment.id)
                        : null,
                text: typeof comment.text === 'string' ? comment.text : '',
                created_at: typeof comment.created_at === 'number' ? comment.created_at : 0,
                like_count: typeof comment.comment_like_count === 'number' ? comment.comment_like_count : 0,
                reply_count: typeof comment.child_comment_count === 'number' ? comment.child_comment_count : 0,
                author: {
                    username: typeof comment.user?.username === 'string' ? comment.user.username : null,
                    is_verified: comment.user?.is_verified === true
                }
            }))

            const nextMinId = typeof data.next_min_id === 'string' && data.next_min_id ? data.next_min_id : null
            const hasMore = data.has_more_headload_comments === true
            return {comments, nextMinId, hasMore}
        } catch (error) {
            console.error('请求失败:', error)
            return null
        }
    }

    private static getMobileUserAgent(): string {
        return 'Instagram 269.0.0.18.75 Android (30/11; 420dpi; 1080x1920; OnePlus; 6T Dev; devitron; qcom; zh_CN; 312456789)'
    }

    static buildMediaUrl(shortcode: string, routeKind: MediaRouteKind): string {
        const path = routeKind === 'reels' ? 'reels' : 'p'
        return `https://www.instagram.com/${path}/${shortcode}/`
    }

    static buildProfileV1Url(username: string): string {
        const encoded = encodeURIComponent(username)
        return `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encoded}`
    }

    static buildMediaInfoUrl(mediaId: string): string {
        return `https://www.instagram.com/api/v1/media/${mediaId}/info/`
    }

    static async fetchProfileV1(username: string): Promise<{
        id: string | null
        username: string
        fullName: string | null
        bio: string | null
        externalUrls: string[]
        followersCount: number | null
        followingCount: number | null
        postCount: number | null
        isVerified: boolean | null
        isBusinessAccount: boolean | null
        profilePicUrl: string | null
    } | null> {
        const url = RequestHelper.buildProfileV1Url(username)
        const headers: Record<string, string> = {
            accept: '*/*',
            'x-ig-app-id': '936619743392459',
            'x-asbd-id': '359341',
            'user-agent': RequestHelper.getMobileUserAgent()
        }
        const auth = await RequestHelper.getAuthCookies()
        if (auth) {
            const authorization = RequestHelper.buildAuthorizationHeader(auth.ds_user_id, auth.sessionid)
            if (authorization) headers['authorization'] = authorization
        }

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers,
                credentials: 'include'
            })
            if (!response.ok) return null
            const data = await response.json()
            const user = data?.data?.user
            if (!user) return null
            const bioLinks = Array.isArray(user?.bio_links) ? user.bio_links : []
            const externalUrls = Array.from(new Set([
                ...bioLinks.map((item: any) => (typeof item?.url === 'string' ? item.url : '')).filter(Boolean),
                typeof user?.external_url === 'string' ? user.external_url : ''
            ].filter(Boolean)))
            return {
                id: user?.id ? String(user.id) : null,
                username: typeof user?.username === 'string' ? user.username : username,
                fullName: typeof user?.full_name === 'string' ? user.full_name : null,
                bio: typeof user?.biography === 'string' ? user.biography : null,
                externalUrls,
                followersCount: typeof user?.edge_followed_by?.count === 'number' ? user.edge_followed_by.count : null,
                followingCount: typeof user?.edge_follow?.count === 'number' ? user.edge_follow.count : null,
                postCount: typeof user?.edge_owner_to_timeline_media?.count === 'number' ? user.edge_owner_to_timeline_media.count : null,
                isVerified: typeof user?.is_verified === 'boolean' ? user.is_verified : null,
                isBusinessAccount: typeof user?.is_business_account === 'boolean' ? user.is_business_account : null,
                profilePicUrl: typeof user?.profile_pic_url_hd === 'string'
                    ? user.profile_pic_url_hd
                    : typeof user?.profile_pic_url === 'string'
                        ? user.profile_pic_url
                        : null
            }
        } catch (error) {
            console.error('请求失败:', error)
            return null
        }
    }

    static async fetchMediaInfoViewCount(mediaId: string): Promise<number | null> {
        if (!mediaId) return null
        const url = RequestHelper.buildMediaInfoUrl(mediaId)
        const headers: Record<string, string> = {
            accept: '*/*',
            'x-ig-app-id': '936619743392459',
            'x-asbd-id': '359341',
            'x-requested-with': 'XMLHttpRequest'
        }

        await RequestHelper.applyAuthHeaders(headers)

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers,
                credentials: 'include'
            })
            if (!response.ok) return null
            const data = await response.json()
            const item = Array.isArray(data?.items) ? data.items[0] : null
            return typeof item?.play_count === 'number' ? item.play_count : null
        } catch (error) {
            console.error('请求失败:', error)
            return null
        }
    }

    private static buildAboutGqlVariables(userId: string): string {
        return String.raw`{"params": {"params": "{\"params\": \"{\\\"server_params\\\": {\\\"harm\\\": \\\"SCAM\\\", \\\"action\\\": \\\"FOLLOW\\\", \\\"target_user_id\\\": ${userId}, \\\"url\\\": \\\"\\\"}}\"}", "bloks_versioning_id": "16e9197b928710eafdf1e803935ed8c450a1a2e3eb696bff1184df088b900bcf", "infra_params": {"device_id": ""}, "app_id": "com.bloks.www.ig.proactive_warning"}, "bk_context": {"is_flipper_enabled": false, "theme_params": [], "debug_tooling_metadata_token": null}}`
    }

    static async fetchAboutGql(userId: string): Promise<{
        accountLocation: string | null
        joinedDate: string | null
    } | null> {
        const form = new URLSearchParams()
        form.set('method', 'post')
        form.set('pretty', 'false')
        form.set('format', 'json')
        form.set('server_timestamps', 'true')
        form.set('locale', 'user')
        form.set('purpose', 'fetch')
        form.set('fb_api_req_friendly_name', 'IGBloksAppRootQuery')
        form.set('client_doc_id', '25336029839814386604447461985')
        form.set('enable_canonical_naming', 'true')
        form.set('enable_canonical_variable_overrides', 'true')
        form.set('enable_canonical_naming_ambiguous_type_prefixing', 'true')
        form.set('variables', RequestHelper.buildAboutGqlVariables(userId))

        const headers: Record<string, string> = {
            accept: '*/*',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            origin: 'https://www.instagram.com',
            referer: 'https://www.instagram.com/',
            'x-ig-app-id': '936619743392459',
            'x-asbd-id': '359341',
            'user-agent': RequestHelper.getMobileUserAgent()
        }
        const auth = await RequestHelper.getAuthCookies()
        if (auth) {
            const authorization = RequestHelper.buildAuthorizationHeader(auth.ds_user_id, auth.sessionid)
            if (authorization) headers['authorization'] = authorization
        }

        try {
            const response = await fetch('https://i-fallback.instagram.com/graphql_www', {
                method: 'POST',
                headers,
                body: form.toString(),
                credentials: 'include'
            })
            if (!response.ok) return null
            const data = await response.json()
            return RequestHelper.parseAboutGql(data)
        } catch (error) {
            console.error('请求失败:', error)
            return null
        }
    }

    private static parseAboutGql(data: any): {
        accountLocation: string | null
        joinedDate: string | null
    } | null {
        const bloks = RequestHelper.findValueByKey(data, 'bloks_bundle_tree')
        if (typeof bloks !== 'string') return null
        try {
            const tree = JSON.parse(bloks)
            const accountLocation = RequestHelper.findAccountLocation(tree)
            const joinedDate = RequestHelper.findJoinedDate(tree)
            return {accountLocation, joinedDate}
        } catch (error) {
            console.error('解析失败:', error)
            return null
        }
    }

    private static findValueByKey(obj: any, key: string): unknown {
        if (!obj || typeof obj !== 'object') return null
        if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key]
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const found = RequestHelper.findValueByKey(item, key)
                if (found !== null && found !== undefined) return found
            }
            return null
        }
        for (const value of Object.values(obj)) {
            const found = RequestHelper.findValueByKey(value, key)
            if (found !== null && found !== undefined) return found
        }
        return null
    }

    private static findAccountLocation(node: any): string | null {
        if (!node || typeof node !== 'object') return null
        if (Array.isArray(node)) {
            for (const item of node) {
                const found = RequestHelper.findAccountLocation(item)
                if (found) return found
            }
            return null
        }
        const data = (node as {data?: any}).data
        if (data && typeof data === 'object') {
            const key = data.key
            if (typeof key === 'string' && key.includes('about_this_account_country')) {
                if (key.includes('about_this_account_country_visibility')) {
                    return null
                }
                const candidates = [data.initial, data.value, data.label, data.text]
                for (const candidate of candidates) {
                    if (typeof candidate === 'string' && candidate) return candidate
                }
            }
        }
        for (const value of Object.values(node)) {
            const found = RequestHelper.findAccountLocation(value)
            if (found) return found
        }
        return null
    }

    private static findJoinedDate(node: any): string | null {
        const strings: string[] = []
        RequestHelper.collectStrings(node, strings)
        const joinedText = strings.join(';')
        const match = joinedText.match(/(\d{4})年(\d{1,2})月/)
        if (!match) return null
        const year = match[1]
        const month = match[2].padStart(2, '0')
        return `${year}-${month}`
    }

    private static collectStrings(node: any, out: string[]): void {
        if (typeof node === 'string') {
            out.push(node)
            return
        }
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) {
            for (const item of node) RequestHelper.collectStrings(item, out)
            return
        }
        for (const value of Object.values(node)) {
            RequestHelper.collectStrings(value, out)
        }
    }

    private static parseReelsPageResponse(data: any): ReelsPageResult | null {
        const connection = data?.data?.xdt_api__v1__clips__user__connection_v2
        if (!connection || !Array.isArray(connection.edges)) return null

        const items: ReelsPageItem[] = connection.edges
            .map((edge: any) => {
                const media = edge?.node?.media
                const id = media?.pk !== undefined && media?.pk !== null ? String(media.pk) : ''
                const shortcode = typeof media?.code === 'string' ? media.code : ''
                if (!id || !shortcode) return null
                return {id, shortcode}
            })
            .filter((item: ReelsPageItem | null): item is ReelsPageItem => item !== null)

        return {
            items,
            pageInfo: {
                has_next_page: connection?.page_info?.has_next_page === true,
                end_cursor: typeof connection?.page_info?.end_cursor === 'string' && connection.page_info.end_cursor
                    ? connection.page_info.end_cursor
                    : null
            }
        }
    }

    static async fetchReelsPage(userId: string, after: string | null): Promise<ReelsPageResult | null> {
        if (!userId) return null
        const tokens = RequestHelper.getGraphqlTokens()
        const auth = await RequestHelper.getAuthCookies()
        if (!tokens || !auth?.ds_user_id) return null

        const variables = after
            ? {
                after,
                before: null,
                data: {include_feed_video: true, page_size: 12, target_user_id: userId},
                first: 3,
                last: null
            }
            : {
                data: {include_feed_video: true, page_size: 12, target_user_id: userId}
            }

        const form = new URLSearchParams()
        form.set('fb_api_caller_class', 'RelayModern')
        form.set('fb_api_req_friendly_name', after ? 'PolarisProfileReelsTabContentQuery_connection' : 'PolarisProfileReelsTabContentQuery')
        form.set('variables', JSON.stringify(variables))
        form.set('server_timestamps', 'true')
        form.set('doc_id', after ? '26450124097916368' : '26384222851217435')
        form.set('av', auth.ds_user_id)
        form.set('__user', auth.ds_user_id)
        form.set('fb_dtsg', tokens.fbDtsg)
        form.set('jazoest', tokens.jazoest)
        form.set('lsd', tokens.lsd)

        const headers: Record<string, string> = {
            accept: '*/*',
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'https://www.instagram.com',
            referer: window.location.href,
            'x-ig-app-id': '936619743392459',
            'x-asbd-id': '359341',
            'x-fb-lsd': tokens.lsd,
            'x-fb-friendly-name': after ? 'PolarisProfileReelsTabContentQuery_connection' : 'PolarisProfileReelsTabContentQuery',
            'x-root-field-name': 'xdt_api__v1__clips__user__connection_v2'
        }
        await RequestHelper.applyAuthHeaders(headers)

        try {
            const response = await RequestHelper.fetchWithRetry('https://www.instagram.com/graphql/query', {
                method: 'POST',
                headers,
                body: form.toString(),
                credentials: 'include'
            }, 'reels 列表请求')
            if (!response.ok) return null
            const data = await response.json()
            return RequestHelper.parseReelsPageResponse(data)
        } catch (error) {
            console.error('请求失败:', error)
            return null
        }
    }

    static async fetchPostHtml(shortcode: string, routeKind: MediaRouteKind = 'p'): Promise<string | null> {
        const url = RequestHelper.buildMediaUrl(shortcode, routeKind)
        const requestLabel = routeKind === 'reels' ? 'reels 详情请求' : '帖子详情请求'
        try {
            const response = await RequestHelper.fetchWithRetry(url, {
                headers: {
                    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
                },
                referrer: url,
                method: 'GET',
                mode: 'cors',
                credentials: 'include'
            }, requestLabel)

            if (!response.ok) {
                console.error('请求失败:', response.status)
                return null
            }

            return await response.text()
        } catch (error) {
            console.error('请求失败:', error)
            return null
        }
    }
}
