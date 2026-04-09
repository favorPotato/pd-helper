import {FixedOverlay} from '../../shared/ui-overlay'
import {getSelectedCount} from './scraper'

export class UiHelper {
    private static overlay: FixedOverlay | null = null
    private static urlCleanup: (() => void) | null = null
    private static selectionTimer: number | null = null

    public static async inject(handlers: {onCollect: () => Promise<void>}): Promise<void> {
        if (!UiHelper.overlay) {
            UiHelper.overlay = new FixedOverlay()
        }

        await UiHelper.overlay.inject('nox')
        UiHelper.overlay.setStatus('nox', 'NoxInfluencer')

        UiHelper.overlay.addButton('采集博主', '#111111', async (event) => {
            event.stopPropagation()
            await handlers.onCollect()
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

        UiHelper.overlay.setStatus('nox', 'NoxInfluencer')
        UiHelper.overlay.setButtonVisible(0, isSearchPage)
        UiHelper.overlay.setButtonEnabled(0, isSearchPage && selectedCount > 0)
        UiHelper.overlay.setButtonText(0, isSearchPage && selectedCount <= 0 ? '采集博主 (请选中博主)' : '采集博主')
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
