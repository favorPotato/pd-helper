import {FixedOverlay} from '../../shared/ui-overlay'
import {getSelectedCount} from './scraper'
import {getNoxInfluencerPoolCount} from './state'

export class UiHelper {
    private static overlay: FixedOverlay | null = null
    private static urlCleanup: (() => void) | null = null
    private static selectionTimer: number | null = null
    private static audienceCollecting = false
    private static tkCollecting = false

    public static async inject(handlers: {onCollectAudience: () => Promise<void>; onCollectTikTok: () => Promise<void>}): Promise<void> {
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

        const isSearchPage = UrlHelper.isSearchPage()
        const selectedCount = isSearchPage ? getSelectedCount() : 0
        const poolCount = await getNoxInfluencerPoolCount()
        const busy = UiHelper.audienceCollecting || UiHelper.tkCollecting

        UiHelper.overlay.setStatus('nox', `NoxInfluencer · 待TK ${poolCount} 人`)
        UiHelper.overlay.setButtonVisible(0, isSearchPage)
        UiHelper.overlay.setButtonEnabled(0, isSearchPage && selectedCount > 0 && !busy)
        UiHelper.overlay.setButtonText(0, UiHelper.audienceCollecting ? '采集画像中...' : (isSearchPage && selectedCount <= 0 ? '采集画像 (请选中博主)' : `采集画像 (${selectedCount})`))

        UiHelper.overlay.setButtonVisible(1, true)
        UiHelper.overlay.setButtonEnabled(1, poolCount > 0 && !busy)
        UiHelper.overlay.setButtonText(1, UiHelper.tkCollecting ? 'TK采集中...' : `TK采集 (待采集 ${poolCount} 人)`)
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
        return window.location.pathname.startsWith('/search/tiktok/channel')
    }
}
