import {runFireAndForget, type CsRuntime} from '../shared/cli-bridge/cs-runtime'
import {PD_RUNTIME_DISPATCH, PD_RUNTIME_PING, TK_BATCH_COLLECT_REMOTE} from '../shared/remote-collect'
import {createTkBatchExecutor, runTkBatchCollect} from '../shared/tk-batch-collect'
import {FixedOverlay} from '../shared/ui-overlay'

declare const window: Window & {
    __PD_RUNTIME_LOADED__?: boolean
}

type RuntimeMessage = {
    type?: unknown
    runtimeTabId?: unknown
    remoteType?: unknown
    taskId?: unknown
    batchSize?: unknown
    maxVideoCount?: unknown
    sortType?: unknown
    minLikeRate?: unknown
    maxDurationSec?: unknown
    fromTs?: unknown
    toTs?: unknown
}

let currentTabId = 0
const overlay = new FixedOverlay()

async function initOverlay(): Promise<void> {
    await overlay.inject('runtime')
    overlay.setStatus('runtime', 'pd-runtime')
}

function numParam(raw: unknown, fallback: number): number {
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
}

function normalizeParams(msg: RuntimeMessage) {
    const now = Date.now()
    const defaultFromTs = new Date(new Date().getFullYear(), 0, 1).getTime()
    return {
        batchSize: numParam(msg.batchSize, 500),
        maxVideoCount: numParam(msg.maxVideoCount, 50),
        sortType: msg.sortType === 'hot' ? 'hot' as const : 'recent' as const,
        minLikeRate: numParam(msg.minLikeRate, 0.02),
        maxDurationSec: numParam(msg.maxDurationSec, 60),
        fromTs: numParam(msg.fromTs, defaultFromTs),
        toTs: numParam(msg.toTs, now)
    }
}

async function initCurrentTabId(): Promise<void> {
    try {
        const tab = await chrome.tabs.getCurrent()
        currentTabId = tab?.id || 0
    } catch {
        currentTabId = 0
    }
}

function isForThisRuntime(msg: RuntimeMessage): boolean {
    const target = typeof msg.runtimeTabId === 'number' ? msg.runtimeTabId : 0
    return !target || !currentTabId || target === currentTabId
}

async function handleTkBatchCollect(msg: RuntimeMessage, rt: CsRuntime): Promise<{batchSize: number; completed: true}> {
    const params = normalizeParams(msg)
    rt.log(`开始批量采集，目标 ${params.batchSize} 个博主`)

    await runTkBatchCollect(createTkBatchExecutor({
        log: (message) => rt.log(message),
        label: (_progress, inf) => `${inf.genderTag}${inf.name || `@${inf.username}`}`,
        throwIfCancelled: () => rt.throwIfCancelled()
    }), params)

    rt.log('批量采集完成')
    return {batchSize: params.batchSize, completed: true}
}

function installMessageHandler(): void {
    chrome.runtime.onMessage.addListener((raw: RuntimeMessage, _sender, sendResponse) => {
        if (!raw || typeof raw !== 'object') return

        if (raw.type === PD_RUNTIME_PING && isForThisRuntime(raw)) {
            sendResponse({ok: true, title: document.title, tabId: currentTabId})
            return
        }

        if (raw.type !== PD_RUNTIME_DISPATCH || !isForThisRuntime(raw)) return

        const taskId = typeof raw.taskId === 'string' ? raw.taskId : ''
        if (!taskId) {
            sendResponse({ok: false, error: 'taskId required'})
            return
        }
        if (raw.remoteType !== TK_BATCH_COLLECT_REMOTE) {
            sendResponse({ok: false, error: `unsupported runtime method: ${String(raw.remoteType || '')}`})
            return
        }

        sendResponse({ok: true, accepted: true})
        void runFireAndForget(taskId, (rt) => handleTkBatchCollect(raw, rt), {
            onLog: (message) => overlay.log(message)
        })
        return true
    })
}

async function main(): Promise<void> {
    if (window.__PD_RUNTIME_LOADED__) return
    window.__PD_RUNTIME_LOADED__ = true
    document.title = 'pd-runtime'
    await initOverlay()
    await initCurrentTabId()
    installMessageHandler()
    overlay.log('pd-runtime ready')
}

void main()
