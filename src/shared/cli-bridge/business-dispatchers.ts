import type {DispatchContext, DispatchFn, PdFacade} from './types'
import {
    IG_COLLECT_REELS_REMOTE,
    IG_GENERATE_SCRIPT_REMOTE,
    IG_MANUAL_ANALYZE_REMOTE,
    NOX_AUTO_COLLECT_REMOTE,
    NOX_BACKFILL_PROFILES_REMOTE,
    NOX_COLLECT_AUDIENCE_REMOTE,
    NOX_COLLECT_TIKTOK_POOL_REMOTE,
    NOX_PAUSE_AUTO_COLLECT_REMOTE,
    NOX_RESUME_AUTO_COLLECT_REMOTE,
    TK_BATCH_COLLECT_REMOTE,
    TK_BRIDGE_TO_IG_REMOTE,
    TK_COLLECT_REMOTE,
    TK_DOWNLOAD_VIDEO_REMOTE,
    TK_PROFILE_METRICS_REMOTE
} from '../remote-collect'

interface PlatformSpec {
    name: string
    urls: string[]
}

const PLATFORM_TIKTOK: PlatformSpec = {name: 'tiktok', urls: ['*://*.tiktok.com/*']}
const PLATFORM_INSTAGRAM: PlatformSpec = {name: 'instagram', urls: ['*://*.instagram.com/*']}
const PLATFORM_NOX: PlatformSpec = {name: 'noxinfluencer', urls: ['*://*.noxinfluencer.com/*']}

async function findTab(spec: PlatformSpec): Promise<chrome.tabs.Tab | null> {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) return null
    const tabs = await chrome.tabs.query({url: spec.urls})
    return tabs[0] || null
}

async function dispatchRemoteToTab(
    ctx: DispatchContext,
    spec: PlatformSpec,
    remoteType: string,
    payload: Record<string, unknown>
): Promise<void> {
    ctx.markPhase('locating_tab')
    const tab = await findTab(spec)
    if (!tab?.id) {
        ctx.setTabId(null)
        ctx.fail('TAB_CLOSED', `未找到 ${spec.name} 已打开的 tab，请先在浏览器打开对应站点并完成登录`)
        return
    }
    ctx.setTabId(tab.id)

    ctx.markPhase('messaging_cs')
    let ack: unknown
    try {
        ack = await chrome.tabs.sendMessage(tab.id, {
            ...payload,
            type: remoteType,
            taskId: ctx.taskId
        })
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        ctx.fail('TAB_CLOSED', `cs sendMessage failed: ${msg}`)
        return
    }

    const okAck = ack && typeof ack === 'object' && ((ack as {accepted?: unknown}).accepted === true || (ack as {ok?: unknown}).ok === true)
    if (!okAck) {
        ctx.fail('UNKNOWN_ERROR', `cs did not accept: ${JSON.stringify(ack ?? null)}`)
        return
    }
    ctx.pushLog('progress', {message: `cs accepted: ${JSON.stringify(ack)}`})
}

function strParam(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : ''
}

function numParam(raw: unknown): number | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
}

function boolParam(raw: unknown, fallback = false): boolean {
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'string') return raw === 'true' || raw === '1' || raw === 'yes'
    if (typeof raw === 'number') return raw !== 0
    return fallback
}


const tkProfileMetrics: DispatchFn = async (params, ctx) => {
    const username = strParam(params.username)
    if (!username) {
        ctx.setTabId(null)
        ctx.fail('INVALID_PARAM', 'username required')
        return
    }
    await dispatchRemoteToTab(ctx, PLATFORM_TIKTOK, TK_PROFILE_METRICS_REMOTE, {
        clientTabId: 0,
        username,
        minLikeRate: numParam(params.minLikeRate),
        maxDurationSec: numParam(params.maxDurationSec)
    })
}

const tkCollect: DispatchFn = async (params, ctx) => {
    const username = strParam(params.username)
    if (!username) {
        ctx.setTabId(null)
        ctx.fail('INVALID_PARAM', 'username required')
        return
    }
    await dispatchRemoteToTab(ctx, PLATFORM_TIKTOK, TK_COLLECT_REMOTE, {
        clientTabId: 0,
        username,
        maxVideoCount: numParam(params.maxVideoCount),
        fromTs: numParam(params.fromTs),
        toTs: numParam(params.toTs),
        startYear: numParam(params.startYear),
        endYear: numParam(params.endYear),
        minLikeRate: numParam(params.minLikeRate),
        maxDurationSec: numParam(params.maxDurationSec),
        filenamePrefix: strParam(params.filenamePrefix),
        sortType: params.sortType === 'hot' ? 'hot' : 'recent'
    })
}

const tkBatchCollect: DispatchFn = async (params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_TIKTOK, TK_BATCH_COLLECT_REMOTE, {
        batchSize: numParam(params.batchSize),
        maxVideoCount: numParam(params.maxVideoCount),
        sortType: params.sortType === 'hot' ? 'hot' : 'recent',
        minLikeRate: numParam(params.minLikeRate),
        maxDurationSec: numParam(params.maxDurationSec),
        fromTs: numParam(params.fromTs),
        toTs: numParam(params.toTs)
    })
}

const tkDownloadVideo: DispatchFn = async (_params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_TIKTOK, TK_DOWNLOAD_VIDEO_REMOTE, {})
}

const tkBridgeToIg: DispatchFn = async (params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_TIKTOK, TK_BRIDGE_TO_IG_REMOTE, {
        caption: strParam(params.caption)
    })
}


const igCollectReels: DispatchFn = async (params, ctx) => {
    const username = strParam(params.username)
    if (!username) {
        ctx.setTabId(null)
        ctx.fail('INVALID_PARAM', 'username required')
        return
    }
    await dispatchRemoteToTab(ctx, PLATFORM_INSTAGRAM, IG_COLLECT_REELS_REMOTE, {
        username,
        order: params.order === 'desc' ? 'desc' : 'asc',
        rangeFrom: strParam(params.rangeFrom),
        rangeTo: strParam(params.rangeTo)
    })
}

const igManualAnalyze: DispatchFn = async (_params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_INSTAGRAM, IG_MANUAL_ANALYZE_REMOTE, {})
}

const igGenerateScript: DispatchFn = async (_params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_INSTAGRAM, IG_GENERATE_SCRIPT_REMOTE, {})
}


const noxAutoCollect: DispatchFn = async (params, ctx) => {
    // searchUrl / platform 由 CS handler 从 URL 读取，不需要 dispatch 传入
    await dispatchRemoteToTab(ctx, PLATFORM_NOX, NOX_AUTO_COLLECT_REMOTE, {
        targetCount: numParam(params.targetCount),
        startPageNum: numParam(params.startPageNum),
        collectProfile: boolParam(params.collectProfile, true)
    })
}

const noxCollectAudience: DispatchFn = async (_params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_NOX, NOX_COLLECT_AUDIENCE_REMOTE, {})
}

const noxBackfillProfiles: DispatchFn = async (params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_NOX, NOX_BACKFILL_PROFILES_REMOTE, {
        batchSize: numParam(params.batchSize)
    })
}

const noxCollectTikTokPool: DispatchFn = async (params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_NOX, NOX_COLLECT_TIKTOK_POOL_REMOTE, {
        batchSize: numParam(params.batchSize),
        maxVideoCount: numParam(params.maxVideoCount),
        sortType: params.sortType === 'hot' ? 'hot' : 'recent',
        minLikeRate: numParam(params.minLikeRate),
        maxDurationSec: numParam(params.maxDurationSec),
        fromTs: numParam(params.fromTs),
        toTs: numParam(params.toTs)
    })
}

const noxPauseAutoCollect: DispatchFn = async (_params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_NOX, NOX_PAUSE_AUTO_COLLECT_REMOTE, {})
}

const noxResumeAutoCollect: DispatchFn = async (_params, ctx) => {
    await dispatchRemoteToTab(ctx, PLATFORM_NOX, NOX_RESUME_AUTO_COLLECT_REMOTE, {})
}

const DISPATCHERS: Readonly<Record<string, DispatchFn>> = {
    tkProfileMetrics,
    tkCollect,
    tkBatchCollect,
    tkDownloadVideo,
    tkBridgeToIg,
    igCollectReels,
    igManualAnalyze,
    igGenerateScript,
    noxAutoCollect,
    noxCollectAudience,
    noxBackfillProfiles,
    noxCollectTikTokPool,
    noxPauseAutoCollect,
    noxResumeAutoCollect
}

export function registerBusinessDispatchers(facade: PdFacade): void {
    for (const [method, fn] of Object.entries(DISPATCHERS)) {
        facade.register(method, fn)
    }
}
