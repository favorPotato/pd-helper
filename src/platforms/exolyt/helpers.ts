import {FixedOverlay} from '../../shared/ui-overlay'

import {getCounts, isPaused} from './collect-state'

// exolyt 浮窗 UiHelper：只管 UI 装配 + 通过 inject 暴露回调注入点，具体采集动作由 main.ts 注入。
// 结构刻意与 nox helpers 对齐（overlay 单例 / busy 态 / sheetsAlive 门禁 / UrlHelper 抽象 / observeUrl + 500ms 刷新），
// 便于后续抽出 nox/exolyt 共用浮窗基类。
export class UiHelper {
    private static overlay: FixedOverlay | null = null
    private static urlCleanup: (() => void) | null = null
    private static refreshTimer: number | null = null

    // 各按钮在途态：置位时禁用全部业务按钮、按钮文案改「…中」，避免重入。
    private static searching = false
    private static detailing = false
    private static packing = false
    // 远程 Sheets 健康：不可用时禁用全部业务按钮（exolyt 去重池为权威，依赖比 nox 更硬）。
    private static sheetsAlive = true

    public static async inject(handlers: {
        onSearch: () => Promise<void>
        onDetail: () => Promise<void>
        onPackVideo: () => Promise<void>
        onPauseResume: () => Promise<void>
    }): Promise<void> {
        if (!UiHelper.overlay) {
            UiHelper.overlay = new FixedOverlay()
        }

        await UiHelper.overlay.inject('exolyt')
        UiHelper.overlay.setStatus('exolyt', UrlHelper.getStatusLabel())

        UiHelper.overlay.addButton('采集列表', '#0ea5e9', async (event) => {
            event.stopPropagation()
            await handlers.onSearch()
        }, false)

        UiHelper.overlay.addButton('采集详情', '#6366f1', async (event) => {
            event.stopPropagation()
            await handlers.onDetail()
        }, false)

        UiHelper.overlay.addButton('采集视频', '#16a34a', async (event) => {
            event.stopPropagation()
            await handlers.onPackVideo()
        }, false)

        UiHelper.overlay.addButton('暂停', '#f59e0b', async (event) => {
            event.stopPropagation()
            await handlers.onPauseResume()
        }, false)

        // URL 变化即时响应（SPA 路由切换板块）+ 500ms 兜底轮询（内存计数变化驱动按钮启用态）——与 nox 同构
        if (UiHelper.urlCleanup) {
            UiHelper.urlCleanup()
        }
        UiHelper.urlCleanup = UiHelper.overlay.observeUrl(() => {
            UiHelper.refreshEnabledState()
        })

        if (UiHelper.refreshTimer !== null) {
            window.clearInterval(UiHelper.refreshTimer)
        }
        UiHelper.refreshTimer = window.setInterval(() => {
            UiHelper.refreshEnabledState()
        }, 500)

        UiHelper.refreshEnabledState()
    }

    // 按内存态 + URL + Sheets 健康动态启用按钮；计数仅驱动按钮启用态，不再常驻状态栏。
    private static refreshEnabledState(): void {
        if (!UiHelper.overlay) return

        const counts = getCounts()
        const paused = isPaused()
        const busy = UiHelper.searching || UiHelper.detailing || UiHelper.packing
        const onVideosPage = UrlHelper.isVideosPage()
        // 统一可操作门禁：远程去重池可用且无在途任务（仿 nox canOperate）
        const canOperate = UiHelper.sheetsAlive && !busy

        // 状态栏名牌：/videos 显 Exolyt (videos)、其余 Exolyt；Sheets 不可用追加提示；运行中追加阶段。
        const phase = UiHelper.searching ? '采集列表中'
            : UiHelper.detailing ? '采集详情中'
                : UiHelper.packing ? '采集视频中'
                    : ''
        const statusParts = [UrlHelper.getStatusLabel(onVideosPage)]
        if (!UiHelper.sheetsAlive) statusParts.push('Sheets 不可用')
        else if (phase) statusParts.push(phase)
        UiHelper.overlay.setStatus('exolyt', statusParts.join(' · '))

        // 全部按钮均为 /videos 页内板块：仅 /videos 可见；暂停额外仅在采集在途时出现（仿 nox）。
        UiHelper.overlay.setButtonVisible('采集列表', onVideosPage)
        UiHelper.overlay.setButtonVisible('采集详情', onVideosPage)
        UiHelper.overlay.setButtonVisible('采集视频', onVideosPage)
        UiHelper.overlay.setButtonVisible('暂停', onVideosPage && busy)

        // 采集列表：去重池可用 + 空闲时可点。
        UiHelper.overlay.setButtonEnabled('采集列表', canOperate)
        UiHelper.overlay.setButtonText('采集列表', UiHelper.searching ? '采集列表...' : '采集列表')

        // 采集详情：有 searched 待处理且可操作时可点。
        UiHelper.overlay.setButtonEnabled('采集详情', canOperate && counts.searched > 0)
        UiHelper.overlay.setButtonText('采集详情', UiHelper.detailing ? '采集详情...' : '采集详情')

        // 采集视频：有 detailed 或 failed（重试队列）待处理且可操作时可点。
        UiHelper.overlay.setButtonEnabled('采集视频', canOperate && (counts.detailed > 0 || counts.failed > 0))
        UiHelper.overlay.setButtonText('采集视频', UiHelper.packing ? '采集视频...' : '采集视频')

        // 暂停·继续：仅采集在途时有意义；文案随暂停标志切换（挂起态可恢复）。
        UiHelper.overlay.setButtonEnabled('暂停', busy)
        UiHelper.overlay.setButtonText('暂停', paused ? '继续' : '暂停')
    }

    // main.ts 在采集动作前后置位在途态，驱动按钮启用/文案刷新。
    public static setBusyState(next: {searching?: boolean; detailing?: boolean; packing?: boolean}): void {
        if (typeof next.searching === 'boolean') UiHelper.searching = next.searching
        if (typeof next.detailing === 'boolean') UiHelper.detailing = next.detailing
        if (typeof next.packing === 'boolean') UiHelper.packing = next.packing
        UiHelper.refreshEnabledState()
    }

    // 远程 Sheets 健康标志（setup 里 checkAppsScriptHealth 后置位，仿 nox）。
    public static setSheetsAlive(alive: boolean): void {
        UiHelper.sheetsAlive = alive
        UiHelper.refreshEnabledState()
    }

    public static log(message: unknown): void {
        UiHelper.overlay?.log(message)
    }
}

// URL 判定抽象（与 nox UrlHelper 同构，便于后续抽出共用浮窗基类）：exolyt 全部按钮归属 /videos 页内板块。
class UrlHelper {
    static isVideosPage(): boolean {
        return window.location.pathname.includes('/videos')
    }

    static getStatusLabel(onVideosPage: boolean = UrlHelper.isVideosPage()): string {
        return onVideosPage ? 'Exolyt (videos)' : 'Exolyt'
    }
}
