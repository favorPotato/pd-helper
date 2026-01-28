import {FixedOverlay} from '../../shared/ui-overlay'
import {Extractor} from './analyzer'

export class UiHelper {
    private static overlay: FixedOverlay | null = null
    private static urlCleanup: (() => void) | null = null
    private static lastStatusText = ''

    static async inject(handlers: { onAnalyze: () => Promise<void> }): Promise<void> {
        if (!UiHelper.overlay) {
            UiHelper.overlay = new FixedOverlay()
        }

        await UiHelper.overlay.inject('instagram')

        const shortcode = Extractor.getShortcode()
        const statusText = shortcode ? 'Instagram (Post)' : 'Instagram (Non-Post)'
        UiHelper.lastStatusText = statusText
        UiHelper.overlay.setStatus('instagram', statusText)

        UiHelper.overlay.addButton('分析', '#0095f6', async (e) => {
            e.stopPropagation()
            await handlers.onAnalyze()
        }, false)

        if (UiHelper.urlCleanup) {
            UiHelper.urlCleanup()
        }

        UiHelper.urlCleanup = UiHelper.overlay.observeUrl(async (url) => {
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

        const shortcode = Extractor.getShortcode()
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

        UiHelper.overlay.setButtonEnabled('分析', hasShortcode)
    }
}
