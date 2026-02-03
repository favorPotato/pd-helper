import {FixedOverlay} from '../../shared/ui-overlay'
import type {CleanedComment} from './types'

export class UiHelper {
    private static overlay: FixedOverlay | null = null
    private static urlCleanup: (() => void) | null = null
    private static lastStatusText = ''

    static async inject(handlers: { onAutoAnalyze: () => Promise<void>; onManualAnalyze: () => Promise<void> }): Promise<void> {
        if (!UiHelper.overlay) {
            UiHelper.overlay = new FixedOverlay()
        }

        await UiHelper.overlay.inject('instagram')

        const shortcode = UrlHelper.getShortcode()
        const statusText = shortcode ? 'Instagram (Post)' : 'Instagram (Non-Post)'
        UiHelper.lastStatusText = statusText
        UiHelper.overlay.setStatus('instagram', statusText)

        UiHelper.overlay.addButton('自动分析', '#0095f6', async (e) => {
            e.stopPropagation()
            await handlers.onAutoAnalyze()
        }, false)

        UiHelper.overlay.addButton('手动分析', '#f57c00', async (e) => {
            e.stopPropagation()
            await handlers.onManualAnalyze()
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

    static setButtonEnabled(text: string, enabled: boolean) {
        if (UiHelper.overlay) {
            UiHelper.overlay.setButtonEnabled(text, enabled)
        }
    }

    static refreshEnabledState() {
        if (!UiHelper.overlay) return

        const shortcode = UrlHelper.getShortcode()
        const hasShortcode = !!shortcode

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

        UiHelper.overlay.setButtonEnabled('自动分析', hasShortcode)
        UiHelper.overlay.setButtonEnabled('手动分析', hasShortcode)
    }
}

export class UrlHelper {
    static getShortcode(): string | null {
        const match = window.location.pathname.match(/\/(p|reel)\/([A-Za-z0-9_-]+)\//)
        return match ? match[2] : null
    }
}

export class RequestHelper {
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
        if (headerValues?.webSid) headers['x-web-session-id'] = headerValues.webSid
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
            const response = await fetch(url, {
                method: 'GET',
                headers,
                mode: 'cors',
                credentials: 'include'
            })
            if (!response.ok) return null
            const data = (await response.json()) as {
                comments?: Array<{
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

    static buildPostUrl(shortcode: string): string {
        return `https://www.instagram.com/p/${shortcode}/`
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
        followersCount: number | null
        bio: string | null
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
            return {
                id: user?.id ? String(user.id) : null,
                followersCount: typeof user?.edge_followed_by?.count === 'number' ? user.edge_followed_by.count : null,
                bio: typeof user?.biography === 'string' ? user.biography : null
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

    static async fetchPostHtml(shortcode: string): Promise<string | null> {
        const url = RequestHelper.buildPostUrl(shortcode)
        try {
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
                return null
            }

            return await response.text()
        } catch (error) {
            console.error('请求失败:', error)
            return null
        }
    }
}
