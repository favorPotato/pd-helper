import {FixedOverlay} from '../../shared/ui-overlay'
import {getSelectedCount} from './scraper'

import type {InfluencerPlatform} from './types'

export class UiHelper {
    private static overlay: FixedOverlay | null = null
    private static urlCleanup: (() => void) | null = null
    private static selectionTimer: number | null = null
    private static audienceCollecting = false
    private static tkCollecting = false
    private static autoCollecting = false
    private static backfillCollecting = false
    private static autoCollectStatus = ''
    private static sheetsAlive = true

    public static async inject(handlers: {
        onCollectAudience: () => Promise<void>
        onCollectTikTok: () => Promise<void>
        onAutoCollect?: () => Promise<void>
        onBackfillProfiles?: () => Promise<void>
        onPauseResume?: () => Promise<void>
    }): Promise<void> {
        if (!UiHelper.overlay) {
            UiHelper.overlay = new FixedOverlay()
        }

        await UiHelper.overlay.inject('nox')
        UiHelper.overlay.setStatus('nox', 'NoxInfluencer')

        if (handlers.onAutoCollect) {
            UiHelper.overlay.addButton('自动采集', '#7c3aed', async (event) => {
                event.stopPropagation()
                await handlers.onAutoCollect!()
            }, false)
        }

        if (handlers.onPauseResume) {
            UiHelper.overlay.addButton('暂停', '#f59e0b', async (event) => {
                event.stopPropagation()
                await handlers.onPauseResume!()
            }, false)
        }

        UiHelper.overlay.addButton('手动选中', '#ff6b35', async (event) => {
            event.stopPropagation()
            await handlers.onCollectAudience()
        }, false)

        if (handlers.onBackfillProfiles) {
            UiHelper.overlay.addButton('回填画像', '#2563eb', async (event) => {
                event.stopPropagation()
                await handlers.onBackfillProfiles!()
            }, false)
        }

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

        const platform = UrlHelper.getSearchPlatform()
        const isSearchPage = UrlHelper.isSearchPage()
        const selectedCount = isSearchPage ? getSelectedCount() : 0
        const busy = UiHelper.audienceCollecting || UiHelper.tkCollecting || UiHelper.autoCollecting || UiHelper.backfillCollecting
        const canOperate = UiHelper.sheetsAlive && !busy

        const statusParts = [UrlHelper.getStatusLabel()]
        if (!UiHelper.sheetsAlive) {
            statusParts.push('Sheets 不可用')
        } else if (UiHelper.autoCollecting && UiHelper.autoCollectStatus) {
            statusParts.push(UiHelper.autoCollectStatus)
        }
        UiHelper.overlay.setStatus('nox', statusParts.join(' · '))

        UiHelper.overlay.setButtonVisible('自动采集', isSearchPage && platform === 'tiktok')
        UiHelper.overlay.setButtonEnabled('自动采集', isSearchPage && canOperate)
        UiHelper.overlay.setButtonText('自动采集', UiHelper.autoCollecting ? '采集中...' : '自动采集')

        UiHelper.overlay.setButtonVisible('暂停', UiHelper.autoCollecting)
        UiHelper.overlay.setButtonEnabled('暂停', true)
        UiHelper.overlay.setButtonText('暂停', '暂停')

        UiHelper.overlay.setButtonVisible('手动选中', isSearchPage)
        UiHelper.overlay.setButtonEnabled('手动选中', isSearchPage && selectedCount > 0 && canOperate)
        UiHelper.overlay.setButtonText('手动选中', UiHelper.audienceCollecting ? '手动选中...' : '手动选中')

        UiHelper.overlay.setButtonVisible('回填画像', isSearchPage && platform === 'tiktok')
        UiHelper.overlay.setButtonEnabled('回填画像', isSearchPage && platform === 'tiktok' && canOperate)
        UiHelper.overlay.setButtonText('回填画像', UiHelper.backfillCollecting ? '回填中...' : '回填画像')

        const isTikTokSearchPage = platform === 'tiktok'
        UiHelper.overlay.setButtonVisible('TK采集', isTikTokSearchPage)
        UiHelper.overlay.setButtonEnabled('TK采集', isTikTokSearchPage && UiHelper.sheetsAlive && !busy)
        UiHelper.overlay.setButtonText('TK采集', UiHelper.tkCollecting ? 'TK采集中...' : 'TK采集')


    }

    public static async setBusyState(next: {audienceCollecting?: boolean; tkCollecting?: boolean; autoCollecting?: boolean; backfillCollecting?: boolean}): Promise<void> {
        if (typeof next.audienceCollecting === 'boolean') UiHelper.audienceCollecting = next.audienceCollecting
        if (typeof next.tkCollecting === 'boolean') UiHelper.tkCollecting = next.tkCollecting
        if (typeof next.autoCollecting === 'boolean') UiHelper.autoCollecting = next.autoCollecting
        if (typeof next.backfillCollecting === 'boolean') UiHelper.backfillCollecting = next.backfillCollecting
        await UiHelper.refreshEnabledState()
    }

    public static setAutoCollectStatus(status: string): void {
        UiHelper.autoCollectStatus = status
        void UiHelper.refreshEnabledState()
    }

    public static setSheetsAlive(alive: boolean): void {
        UiHelper.sheetsAlive = alive
        void UiHelper.refreshEnabledState()
    }

    public static log(message: unknown): void {
        UiHelper.overlay?.log(message)
    }
}

class UrlHelper {
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
