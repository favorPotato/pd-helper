import {showDialog} from '../../shared/custom-dialog'
import {TK_BATCH_COLLECT_FIELDS} from '../../shared/tk-collect-fields'
import {truncateError} from '../../shared/errors'
import {
    isNoxLogMessage,
    NOX_AUTO_COLLECT_REMOTE,
    NOX_BACKFILL_PROFILES_REMOTE,
    NOX_COLLECT_AUDIENCE_REMOTE,
    NOX_COLLECT_TIKTOK_POOL_REMOTE,
    NOX_PAUSE_AUTO_COLLECT_REMOTE,
    NOX_RESUME_AUTO_COLLECT_REMOTE
} from '../../shared/remote-collect'
import {runFireAndForget} from '../../shared/cli-bridge/cs-runtime'
import {sleepRandom} from '../../shared/timing'
import {enqueueUpsertInfluencers} from '../../shared/sheets-sync'
import {runTkBatchCollect, createTkBatchExecutor} from '../../shared/tk-batch-collect'
import {checkAppsScriptHealth} from '../../shared/apps-script-client'
import {callAppsScript} from '../../shared/apps-script-client'
import {fetchAudienceProfile} from './client'
import {UiHelper} from './helpers'
import {scrapeSelectedInfluencers} from './scraper'
import {backfillAudienceProfiles, startAutoCollect} from './auto-collect'
import {readBaseParamsFromUrl} from './paginator'
import {fetchSearchPage, getSearchUrlWithoutPageNum, type SearchInfluencer} from './search-api'
import {pauseLongTask, resumeLongTask} from './long-task'
import {buildExtraDataFromProfile, classifyGender, extractSearchExtra} from './profile-mapping'
import {startSyncWorker} from '../../shared/sheets-sync'
import type {InfluencerPlatform, NoxInfluencer} from './types'

declare const window: Window & {
    __NOX_MESSAGE_HANDLER_LOADED__?: boolean
}

let audienceCollectInProgress = false
let tkCollectInProgress = false
let autoCollectPaused = false


function initNoxMessageHandler(): void {
    if (window.__NOX_MESSAGE_HANDLER_LOADED__) return
    window.__NOX_MESSAGE_HANDLER_LOADED__ = true

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (isNoxLogMessage(msg)) {
            UiHelper.log(msg.message)
            return
        }

        if (msg?.type === NOX_PAUSE_AUTO_COLLECT_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) { sendResponse({ok: false, error: 'taskId required'}); return true }
            sendResponse({ok: true, accepted: true})
            void runFireAndForget(taskId, async (rt) => {
                rt.log('暂停长任务...')
                await pauseLongTask()
                autoCollectPaused = true
                rt.log('已暂停')
                return {paused: true}
            })
            return true
        }

        if (msg?.type === NOX_RESUME_AUTO_COLLECT_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) { sendResponse({ok: false, error: 'taskId required'}); return true }
            sendResponse({ok: true, accepted: true})
            void runFireAndForget(taskId, async (rt) => {
                rt.log('继续长任务...')
                await resumeLongTask()
                autoCollectPaused = false
                rt.log('已继续')
                return {resumed: true}
            })
            return true
        }

        if (msg?.type === NOX_COLLECT_AUDIENCE_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) { sendResponse({ok: false, error: 'taskId required'}); return true }
            sendResponse({ok: true, accepted: true})
            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                rt.log('触发受众采集（依赖当前页 DOM 上已勾选的博主）...')
                await collectAudienceFromNox()
                rt.log('受众采集流程结束')
                return {ok: true}
            })
            return true
        }

        if (msg?.type === NOX_BACKFILL_PROFILES_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) { sendResponse({ok: false, error: 'taskId required'}); return true }
            const batchSize = Math.max(1, Number(msg.batchSize) || 100)
            sendResponse({ok: true, accepted: true})
            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                if (audienceCollectInProgress || tkCollectInProgress) {
                    throw new Error('another nox task is in progress')
                }
                let influencers: NoxInfluencer[]
                try {
                    const resp = await callAppsScript<{ok: boolean; items: NoxInfluencer[]}>('loadInfluencersByField', {
                        platform: 'tiktok',
                        field: 'genderTag',
                        operator: 'empty',
                        limit: batchSize
                    })
                    influencers = resp.items || []
                } catch (error) {
                    throw new Error(`拉取空画像博主失败: ${truncateError(error, 200)}`)
                }
                if (influencers.length === 0) {
                    rt.log('没有待回填的空画像博主')
                    return {batchSize, processed: 0, succeeded: 0, failed: 0}
                }
                rt.log(`开始回填 ${influencers.length} 个空画像博主`)
                await UiHelper.setBusyState({backfillCollecting: true})
                try {
                    const {succeededCount: succeeded, failedCount: failed} = await backfillAudienceProfiles(
                        influencers.map((item) => item.channelId),
                        (m) => rt.log(`[回填画像] ${m}`)
                    )
                    rt.log(`回填结束：成功 ${succeeded}，失败 ${failed}`)
                    return {batchSize, processed: influencers.length, succeeded, failed}
                } finally {
                    await UiHelper.setBusyState({backfillCollecting: false})
                }
            })
            return true
        }

        if (msg?.type === NOX_COLLECT_TIKTOK_POOL_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) { sendResponse({ok: false, error: 'taskId required'}); return true }
            if (audienceCollectInProgress || tkCollectInProgress) {
                sendResponse({ok: false, error: 'another nox task is in progress'}); return true
            }
            const batchSize = Math.max(1, Number(msg.batchSize) || 500)
            const maxVideoCount = Math.max(1, Number(msg.maxVideoCount) || 50)
            const sortType: 'hot' | 'recent' = msg.sortType === 'hot' ? 'hot' : 'recent'
            const minLikeRate = Number(msg.minLikeRate) || 0.02
            const maxDurationSec = Number(msg.maxDurationSec) || 60
            const nowPool = Date.now()
            const defaultFromPool = new Date(new Date().getFullYear(), 0, 1).getTime()
            const fromTs = Number(msg.fromTs) || defaultFromPool
            const toTs = Number(msg.toTs) || nowPool

            sendResponse({ok: true, accepted: true})
            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                tkCollectInProgress = true
                await UiHelper.setBusyState({tkCollecting: true})
                try {
                    const noxExecutor = createTkBatchExecutor({
                        log: (m) => rt.log(m),
                        label: (_progress, inf) => `${inf.genderTag}${buildInfluencerLabel(inf)}`,
                        throwIfCancelled: () => rt.throwIfCancelled()
                    })

                    await runTkBatchCollect(noxExecutor, {batchSize, fromTs, toTs, minLikeRate, maxDurationSec, sortType, maxVideoCount})
                    return {batchSize, completed: true}
                } finally {
                    tkCollectInProgress = false
                    await UiHelper.setBusyState({tkCollecting: false})
                }
            })
            return true
        }

        if (msg?.type === NOX_AUTO_COLLECT_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) {
                sendResponse({ok: false, error: 'taskId required'})
                return true
            }
            if (tkCollectInProgress || audienceCollectInProgress) {
                sendResponse({ok: false, error: 'another nox task is in progress'})
                return true
            }
            const targetCount = Math.max(1, Number(msg.targetCount) || 5000)
            const collectProfile = msg.collectProfile !== false
            const startPageNum = Math.max(1, Number(msg.startPageNum) || 1)

            sendResponse({ok: true, accepted: true})
            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                const baseParams = readBaseParamsFromUrl()
                rt.log(`启动自动采集：目标 ${targetCount}，画像=${collectProfile}，起始页 ${startPageNum}`)
                rt.log(`base params: ${JSON.stringify(baseParams)}`)

                await UiHelper.setBusyState({autoCollecting: true})
                autoCollectPaused = false
                try {
                    await startAutoCollect(
                        {targetCount, collectProfile, baseParams, startPageNum},
                        (m) => {
                            UiHelper.setAutoCollectStatus(m)
                            UiHelper.log(m)
                            rt.log(m)
                        }
                    )
                } finally {
                    await UiHelper.setBusyState({autoCollecting: false})
                    UiHelper.setAutoCollectStatus('')
                }
                return {targetCount, collectProfile, startPageNum, completed: true}
            })
            return true
        }
        return
    })
}

function buildInfluencerLabel(influencer: {name: string; username: string}): string {
    return influencer.name || `@${influencer.username}`
}

function summarizeInfluencers(influencers: NoxInfluencer[]): {FF: number; F: number; N: number; M: number; MM: number} {
    const summary = {FF: 0, F: 0, N: 0, M: 0, MM: 0}
    for (const influencer of influencers) {
        const key = influencer.genderTag.replace('-', '') as keyof typeof summary
        summary[key] += 1
    }
    return summary
}

async function fetchCurrentPageSearchInfluencers(): Promise<Map<string, SearchInfluencer>> {
    const baseParams = readBaseParamsFromUrl()
    const currentPage = Math.max(1, Number(baseParams.pageNum) || 1)
    const page = await fetchSearchPage(baseParams, currentPage)
    return new Map(page.influencers.map((inf) => [inf.id, inf]))
}

async function collectAudienceItem(
    item: {channelId: string; platform: string; username: string; name: string},
    searchInf: SearchInfluencer | undefined,
    index: number,
    total: number
): Promise<NoxInfluencer> {
    const progress = `[${index + 1}/${total}]`
    const displayName = buildInfluencerLabel(item)
    try {
        UiHelper.log(`${progress} 获取受众数据: ${displayName}...`)
        const profile = await fetchAudienceProfile(item.channelId)
        const genderTag = classifyGender(profile.gender.female, profile.gender.male)
        const extraData = buildExtraDataFromProfile(profile, searchInf ? extractSearchExtra(searchInf) : {})
        UiHelper.log(`${progress} ${genderTag} ${displayName} (♀${(profile.gender.female * 100).toFixed(1)}% ♂${(profile.gender.male * 100).toFixed(1)}%)`)
        return {
            ...item,
            platform: item.platform as NoxInfluencer['platform'],
            country: searchInf?.country || '',
            genderTag,
            femaleRatio: profile.gender.female,
            maleRatio: profile.gender.male,
            followers: searchInf?.followers,
            totalVideos: searchInf?.totalVideos,
            noxScore: searchInf?.noxScore,
            archivedVideoCount: 0,
            lastError: '',
            extraData,
            updatedAt: new Date().toISOString(),
        }
    } catch (error) {
        UiHelper.log(`${progress} 获取受众数据失败: ${displayName} - ${truncateError(error, 200)}`)
        return {
            ...item,
            platform: item.platform as NoxInfluencer['platform'],
            country: searchInf?.country || '',
            genderTag: 'N-',
            femaleRatio: 0,
            maleRatio: 0,
            followers: searchInf?.followers,
            totalVideos: searchInf?.totalVideos,
            noxScore: searchInf?.noxScore,
            archivedVideoCount: 0,
            lastError: truncateError(error, 200),
        }
    }
}

async function collectAudienceFromNox(): Promise<void> {
    if (audienceCollectInProgress || tkCollectInProgress) return

    const selected = scrapeSelectedInfluencers()
    if (selected.length === 0) {
        UiHelper.log('请先在页面上勾选博主')
        return
    }

    const platform = selected[0]?.platform as InfluencerPlatform | undefined
    if (!platform) {
        UiHelper.log('未识别当前平台')
        return
    }

    let currentPageSearchMap = new Map<string, SearchInfluencer>()
    if (platform === 'tiktok') {
        try {
            currentPageSearchMap = await fetchCurrentPageSearchInfluencers()
        } catch (error) {
            UiHelper.log(`读取当前页 Search API 失败: ${truncateError(error, 200)}`)
            return
        }
    }

    const currentPageSelected = selected
        .filter((item) => {
            if (platform !== 'tiktok') return true
            return currentPageSearchMap.has(item.channelId)
        })
        .map((item) => {
            const searchInf = currentPageSearchMap.get(item.channelId)
            if (!searchInf) return item
            return {
                ...item,
                username: searchInf.alias || item.username,
                name: searchInf.nickName || item.name,
            }
        })

    const skippedCount = selected.length - currentPageSelected.length
    if (currentPageSelected.length === 0) {
        UiHelper.log(platform === 'tiktok' ? '当前页没有可处理的已勾选博主' : '请先在页面上勾选博主')
        return
    }

    UiHelper.log(`已选中 ${currentPageSelected.length} 个博主 (${platform})，仅处理当前页`)
    if (skippedCount > 0) {
        UiHelper.log(`已忽略 ${skippedCount} 个非当前页勾选项`)
    }

    audienceCollectInProgress = true
    await UiHelper.setBusyState({audienceCollecting: true})
    try {
        const influencers: NoxInfluencer[] = []
        for (let i = 0; i < currentPageSelected.length; i += 1) {
            if (i > 0) await sleepRandom(2000, 5000)
            const item = currentPageSelected[i]
            influencers.push(await collectAudienceItem(item, currentPageSearchMap.get(item.channelId), i, currentPageSelected.length))
        }
        const summary = summarizeInfluencers(influencers)
        UiHelper.log(`分类汇总: FF=${summary.FF} F=${summary.F} N=${summary.N} M=${summary.M} MM=${summary.MM}`)

        const now = new Date().toISOString()
        const sheetsPayload = influencers.map(inf => ({
            channelId: inf.channelId,
            username: inf.username,
            name: inf.name,
            country: inf.country || '',
            status: inf.status || 'unused',
            genderTag: inf.genderTag,
            archivedVideoCount: inf.archivedVideoCount || 0,
            followers: inf.followers,
            totalVideos: inf.totalVideos,
            noxScore: inf.noxScore,
            lastError: inf.lastError || '',
            extraData: inf.extraData || '',
            createdAt: inf.createdAt || now,
            updatedAt: now,
        }))
        await enqueueUpsertInfluencers(platform, sheetsPayload)
        UiHelper.log(`已推送 ${influencers.length} 条到 Sheets 同步队列`)
    } catch (error) {
        UiHelper.log(`画像采集异常: ${truncateError(error, 300)}`)
    } finally {
        audienceCollectInProgress = false
        await UiHelper.setBusyState({audienceCollecting: false})
    }
}

async function collectFromTikTokPool(): Promise<void> {
    if (audienceCollectInProgress || tkCollectInProgress) return

    const params = await showDialog({
        title: 'TK采集设置',
        fields: TK_BATCH_COLLECT_FIELDS
    })
    if (!params) return

    const batchSize = Number(params.batchSize) || 500
    const maxVideoCount = Number(params.videoCount) || 50
    const sortType: 'hot' | 'recent' = params.sortType === 'hot' ? 'hot' : 'recent'
    const minLikeRate = Number(params.minLikeRate) || 0.02
    const maxDurationSec = Number(params.maxDurationSec) || 60
    const todayNox = new Date()
    const defaultFromNox = new Date(todayNox.getFullYear(), 0, 1)
    const fromTs = params.startDate ? new Date(params.startDate as string).getTime() : defaultFromNox.getTime()
    const toTs = params.endDate ? new Date(params.endDate as string + 'T23:59:59').getTime() : todayNox.getTime()

    tkCollectInProgress = true
    await UiHelper.setBusyState({tkCollecting: true})
    try {
        const noxExecutor = createTkBatchExecutor({
            log: (m) => UiHelper.log(m),
            label: (_progress, inf) => `${inf.genderTag}${buildInfluencerLabel(inf)}`
        })

        await runTkBatchCollect(noxExecutor, {
            batchSize,
            fromTs,
            toTs,
            minLikeRate,
            maxDurationSec,
            sortType,
            maxVideoCount
        })
    } catch (error) {
        UiHelper.log(`批量采集异常: ${truncateError(error, 300)}`)
    } finally {
        tkCollectInProgress = false
        await UiHelper.setBusyState({tkCollecting: false})
    }
}

async function backfillMissingProfiles(): Promise<void> {
    if (audienceCollectInProgress || tkCollectInProgress) return

    const params = await showDialog({
        title: '回填画像',
        fields: [
            {key: 'batchSize', label: '回填博主数', type: 'number', value: 100, min: 1},
            {key: 'info', label: '按性别标签为空筛选，并重跑 audience 画像', type: 'info'}
        ],
        confirmText: '开始'
    })
    if (!params) return

    const batchSize = Number(params.batchSize) || 100

    let influencers: NoxInfluencer[]
    try {
        const resp = await callAppsScript<{ok: boolean; items: NoxInfluencer[]}>('loadInfluencersByField', {
            platform: 'tiktok',
            field: 'genderTag',
            operator: 'empty',
            limit: batchSize
        })
        influencers = resp.items || []
    } catch (error) {
        UiHelper.log(`拉取空画像博主失败: ${truncateError(error, 200)}`)
        return
    }

    if (influencers.length === 0) {
        UiHelper.log('没有待回填的空画像博主')
        return
    }

    UiHelper.log(`开始回填 ${influencers.length} 个空画像博主`)

    await UiHelper.setBusyState({backfillCollecting: true})
    try {
        const {succeededCount: succeeded, failedCount: failed} = await backfillAudienceProfiles(
            influencers.map((item) => item.channelId),
            (msg) => UiHelper.log(`[回填画像] ${msg}`)
        )
        UiHelper.log(`回填结束：成功 ${succeeded}，失败 ${failed}`)
    } finally {
        await UiHelper.setBusyState({backfillCollecting: false})
    }
}


async function autoCollect(): Promise<void> {
    const baseParams = readBaseParamsFromUrl()
    const currentPage = Math.max(1, Number(baseParams.pageNum) || 1)

    const result = await showDialog({
        title: '自动采集',
        fields: [
            {key: 'targetCount', label: '目标博主数量', type: 'number', value: 5000, min: 1},
            {key: 'collectProfile', label: '同时采集画像', type: 'checkbox', value: true},
            {key: 'resumeFromSheets', label: '使用 Sheets 进度继续', type: 'checkbox', value: true},
            {key: 'info', label: '当前筛选条件已读取，预计耗时视数量而定', type: 'info'}
        ],
        confirmText: '开始'
    })
    if (!result) return

    const targetCount = Number(result.targetCount) || 5000
    const collectProfile = result.collectProfile === true
    let startPageNum = currentPage
    if (result.resumeFromSheets === true) {
        try {
            const pageResp = await callAppsScript<{ok: boolean; found?: boolean; pageNum?: number; error?: string}>('getNoxPage', {
                url: getSearchUrlWithoutPageNum()
            })
            if (pageResp.ok && pageResp.found && pageResp.pageNum) {
                startPageNum = Math.max(1, Number(pageResp.pageNum) || currentPage)
                UiHelper.log(`使用 Sheets 进度，从第 ${startPageNum} 页继续`)
            } else {
                UiHelper.log(`Sheets 未找到当前筛选进度，从当前页（第 ${currentPage} 页）开始`)
            }
        } catch (error) {
            UiHelper.log(`读取 Sheets 页码失败，从当前页开始: ${truncateError(error, 200)}`)
        }
    }

    await UiHelper.setBusyState({autoCollecting: true})
    autoCollectPaused = false

    await startAutoCollect(
        {targetCount, collectProfile, baseParams, startPageNum},
        (msg) => {
            UiHelper.setAutoCollectStatus(msg)
            UiHelper.log(msg)
        }
    )

    await UiHelper.setBusyState({autoCollecting: false})
    UiHelper.setAutoCollectStatus('')
}

async function pauseResumeAutoCollect(): Promise<void> {
    if (!autoCollectPaused) {
        autoCollectPaused = true
        await pauseLongTask()
        UiHelper.log('已暂停')
    } else {
        autoCollectPaused = false
        await resumeLongTask()
        UiHelper.log('已继续')
    }
}

export function setup(): void {
    initNoxMessageHandler()
    startSyncWorker()

    void UiHelper.inject({
        onCollectAudience: collectAudienceFromNox,
        onBackfillProfiles: backfillMissingProfiles,
        onCollectTikTok: collectFromTikTokPool,
        onAutoCollect: autoCollect,
        onPauseResume: pauseResumeAutoCollect,
    })

    void checkAppsScriptHealth().then((result) => {
        UiHelper.setSheetsAlive(result.ok)
        if (!result.ok) {
            alert(`Google Sheets 不可用，所有采集功能已禁用\n原因：${result.error}`)
        }
    })
}
