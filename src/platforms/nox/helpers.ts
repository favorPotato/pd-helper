import {FixedOverlay} from '../../shared/ui-overlay'
import {getSelectedCount} from './scraper'
import {getInfluencerPoolCount} from './state'
import type {InfluencerPlatform} from './types'

export class UiHelper {
    private static overlay: FixedOverlay | null = null
    private static urlCleanup: (() => void) | null = null
    private static selectionTimer: number | null = null
    private static audienceCollecting = false
    private static tkCollecting = false

    public static async inject(handlers: {
        onCollectAudience: () => Promise<void>
        onCollectTikTok: () => Promise<void>
        onExportPool: () => Promise<void>
        onClearPool: () => Promise<void>
    }): Promise<void> {
        if (!UiHelper.overlay) {
            UiHelper.overlay = new FixedOverlay()
        }

        await UiHelper.overlay.inject('nox')
        UiHelper.overlay.setStatus('nox', 'NoxInfluencer')

        UiHelper.overlay.addButton('采集画像', '#ff6b35', async (event) => {
            event.stopPropagation()
            await handlers.onCollectAudience()
        }, false)

        UiHelper.overlay.addButton('TK采集', '#111111', async (event) => {
            event.stopPropagation()
            await handlers.onCollectTikTok()
        }, false)

        UiHelper.overlay.addButton('导出博主', '#0ea5e9', async (event) => {
            event.stopPropagation()
            await handlers.onExportPool()
        }, false)

        UiHelper.overlay.addButton('清空池子', '#ef4444', async (event) => {
            event.stopPropagation()
            await handlers.onClearPool()
        }, false)

        if (UiHelper.urlCleanup) {
            UiHelper.urlCleanup()
        }
        UiHelper.urlCleanup = UiHelper.overlay.observeUrl(async () => {
            await UiHelper.refreshEnabledState()
        })

        if (UiHelper.selectionTimer !== null) {
            window.clearInterval(UiHelper.selectionTimer)
        }
        UiHelper.selectionTimer = window.setInterval(() => {
            void UiHelper.refreshEnabledState()
        }, 500)

        await UiHelper.refreshEnabledState()
    }

    private static async refreshEnabledState(): Promise<void> {
        if (!UiHelper.overlay) return

        const platform = UrlHelper.getSearchPlatform()
        const isSearchPage = UrlHelper.isSearchPage()
        const selectedCount = isSearchPage ? getSelectedCount() : 0
        const poolCount = platform ? await getInfluencerPoolCount(platform) : 0
        const busy = UiHelper.audienceCollecting || UiHelper.tkCollecting

        UiHelper.overlay.setStatus('nox', `${UrlHelper.getStatusLabel()} · 池子 ${poolCount} 人`)

        UiHelper.overlay.setButtonVisible('采集画像', isSearchPage)
        UiHelper.overlay.setButtonEnabled('采集画像', isSearchPage && selectedCount > 0 && !busy)
        UiHelper.overlay.setButtonText('采集画像', UiHelper.audienceCollecting ? '采集画像中...' : (isSearchPage && selectedCount <= 0 ? '采集画像 (请选中博主)' : `采集画像 (${selectedCount})`))

        const isTikTokSearchPage = platform === 'tiktok'
        UiHelper.overlay.setButtonVisible('TK采集', isTikTokSearchPage)
        UiHelper.overlay.setButtonEnabled('TK采集', isTikTokSearchPage && poolCount > 0 && !busy)
        UiHelper.overlay.setButtonText('TK采集', UiHelper.tkCollecting ? 'TK采集中...' : `TK采集 (${poolCount})`)

        UiHelper.overlay.setButtonVisible('导出博主', true)
        UiHelper.overlay.setButtonEnabled('导出博主', poolCount > 0 && !busy)

        UiHelper.overlay.setButtonVisible('清空池子', true)
        UiHelper.overlay.setButtonEnabled('清空池子', poolCount > 0 && !busy)
    }

    public static async setBusyState(next: {audienceCollecting?: boolean; tkCollecting?: boolean}): Promise<void> {
        if (typeof next.audienceCollecting === 'boolean') {
            UiHelper.audienceCollecting = next.audienceCollecting
        }
        if (typeof next.tkCollecting === 'boolean') {
            UiHelper.tkCollecting = next.tkCollecting
        }
        await UiHelper.refreshEnabledState()
    }

    public static async refreshState(): Promise<void> {
        await UiHelper.refreshEnabledState()
    }

    public static log(message: unknown): void {
        UiHelper.overlay?.log(message)
    }
}

export class UrlHelper {
    static isSearchPage(): boolean {
        return UrlHelper.getSearchPlatform() !== null
    }

    static getSearchPlatform(): InfluencerPlatform | null {
        const path = window.location.pathname
        if (path.startsWith('/search/tiktok/channel')) return 'tiktok'
        if (path.startsWith('/search/instagram/channel')) return 'instagram'
        return null
    }

    static getStatusLabel(): string {
        const platform = UrlHelper.getSearchPlatform()
        if (platform === 'instagram') return 'Nox (IG)'
        if (platform === 'tiktok') return 'Nox (TK)'
        return 'Nox'
    }
}
