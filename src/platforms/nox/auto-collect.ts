import {sleepRandom} from '../../shared/timing'
import {isSessionError, showAlarm} from '../../shared/alarm'
import {callAppsScript} from '../../shared/apps-script-client'
import {enqueueUpsertInfluencers, enqueueUpdateStatus, enqueueUpsertNoxPage, getSyncStatus, HARD_WATERMARK} from '../../shared/sheets-sync'
import {
    getCheckpoint,
    patchCheckpoint,
    startNoxAutoCollect,
    pauseLongTask,
    resumeLongTask,
    type LongTaskCheckpoint,
    type NoxAutoCollectParams,
} from './long-task'
import {paginate} from './paginator'
import {fetchAudienceProfile} from './client'
import {buildExtraDataFromProfile, classifyGender, extractSearchExtra, type SearchExtra} from './profile-mapping'
import {getSearchUrlWithoutPageNum, type SearchInfluencer} from './search-api'
import type {NoxInfluencer} from './types'

let mainLoopRunning = false

async function loadProfiledChannelIds(onStatus: (msg: string) => void): Promise<Set<string>> {
    try {
        const resp = await callAppsScript<{ok: boolean; items: NoxInfluencer[]}>('loadInfluencersByField', {
            platform: 'tiktok',
            field: 'genderTag',
            operator: 'notEmpty',
            limit: 0,
        })
        const ids = new Set((resp.items || []).map(item => String(item.channelId || '')).filter(Boolean))
        onStatus(`已加载 ${ids.size} 个已回填画像博主，自动跳过`)
        return ids
    } catch (error) {
        onStatus(`加载已回填画像集合失败，将不跳过已回填项: ${error instanceof Error ? error.message : String(error)}`)
        return new Set()
    }
}

interface ProfilingRunContext {
    channelIds: string[]
    cursor: number
    succeededCount: number
    failedCount: number
    searchData: Record<string, SearchExtra>
    profiledIds?: Set<string>
}

interface ProfilingRunHooks {
    waitBeforeItem?: (onStatus: (msg: string) => void) => Promise<boolean>
    onProgressPersist?: (state: {cursor: number; succeededCount: number; failedCount: number; lastFailedReason?: string}) => Promise<void>
    onSessionError?: () => Promise<void>
}

async function waitIfPaused(onStatus: (msg: string) => void): Promise<boolean> {
    while (true) {
        const cp = await getCheckpoint()
        if (!cp) return false
        if (cp.state === 'done' || cp.state === 'failed') return false
        if (cp.state === 'running') return true
        onStatus('任务已暂停，等待恢复...')
        await sleepRandom(3000, 3000)
    }
}

async function runPagingPhase(
    cp: LongTaskCheckpoint,
    onStatus: (msg: string) => void,
    profiledIds?: Set<string>
): Promise<{ok: boolean; newInfluencers: SearchInfluencer[]}> {
    const newInfluencers: SearchInfluencer[] = []
    const existingIds = new Set<string>(cp.paging.newChannelIds)
    const searchData: Record<string, SearchExtra> = {...(cp.paging.searchData || {})}
    const remainingCount = Math.max(0, cp.params.targetCount - cp.paging.newChannelIds.length)
    const searchUrl = getSearchUrlWithoutPageNum()

    if (remainingCount === 0) {
        await patchCheckpoint({
            paging: {
                ...cp.paging,
                status: 'done',
            }
        })
        onStatus('目标博主数已完成，跳过翻页阶段')
        return {ok: true, newInfluencers}
    }

    const collectProfile = cp.params.collectProfile
    let profilingSucceeded = 0
    let profilingFailed = 0
    let profilingSessionError = false

    const result = await paginate(
        {
            targetCount: remainingCount,
            baseParams: cp.params.baseParams,
            startPageNum: cp.paging.nextPageNum,
            existingIds,
            onPageCollected: async (pageInfluencers, nextPageNum) => {
                await enqueueUpsertNoxPage(searchUrl, nextPageNum)

                if (pageInfluencers.length === 0) return

                for (const inf of pageInfluencers) {
                    newInfluencers.push(inf)
                    searchData[inf.id] = extractSearchExtra(inf)
                }

                const now = new Date().toISOString()
                const sheetsItems = pageInfluencers.map(inf => ({
                    channelId: inf.id,
                    username: inf.alias,
                    name: inf.nickName,
                    country: inf.country,
                    status: 'unused',
                    followers: inf.followers,
                    totalVideos: inf.totalVideos,
                    noxScore: inf.noxScore,
                    createdAt: now,
                    updatedAt: now,
                }))
                await enqueueUpsertInfluencers('tiktok', sheetsItems)

                await patchCheckpoint({
                    paging: {
                        ...cp.paging,
                        pagedCount: cp.paging.pagedCount + newInfluencers.length,
                        newChannelIds: [...cp.paging.newChannelIds, ...newInfluencers.map(i => i.id)],
                        searchData,
                    }
                })

                if (collectProfile && !profilingSessionError) {
                    const pageChannelIds = pageInfluencers.map(inf => inf.id)
                    const profilingResult = await runProfilingLoop({
                        channelIds: pageChannelIds,
                        cursor: 0,
                        succeededCount: 0,
                        failedCount: 0,
                        searchData,
                        profiledIds,
                    }, onStatus, {
                        waitBeforeItem: waitIfPaused,
                        onSessionError: async () => {
                            profilingSessionError = true
                            await pauseLongTask()
                        },
                    })
                    profilingSucceeded += profilingResult.succeededCount
                    profilingFailed += profilingResult.failedCount
                }
            },
        },
        async (msg) => {
            onStatus(msg)
            await waitIfPaused(onStatus)
        }
    )

    await patchCheckpoint({
        paging: {
            status: result.stopped === 'target_reached' || result.stopped === 'no_more_pages' ? 'done' : 'running',
            nextPageNum: result.nextPageNum,
            totalPages: result.totalPages,
            pagedCount: cp.paging.pagedCount + newInfluencers.length,
            newChannelIds: [...cp.paging.newChannelIds, ...newInfluencers.map(i => i.id)],
            searchData,
        },
        ...(collectProfile ? {
            profiling: {
                status: profilingSessionError ? 'running' : 'done',
                cursor: profilingSucceeded + profilingFailed,
                succeededCount: cp.profiling.succeededCount + profilingSucceeded,
                failedCount: cp.profiling.failedCount + profilingFailed,
            }
        } : {}),
    })

    if (result.stopped === 'session_expired') {
        showAlarm('Nox 登录失效，任务已暂停', 20_000)
        await pauseLongTask()
        return {ok: false, newInfluencers}
    }

    return {ok: true, newInfluencers}
}

async function runProfilingLoop(
    context: ProfilingRunContext,
    onStatus: (msg: string) => void,
    hooks: ProfilingRunHooks = {}
): Promise<{cursor: number; succeededCount: number; failedCount: number; completed: boolean}> {
    let cursor = context.cursor
    let succeededCount = context.succeededCount
    let failedCount = context.failedCount
    const {channelIds, searchData, profiledIds} = context

    for (let i = cursor; i < channelIds.length; i += 1) {
        if (hooks.waitBeforeItem) {
            const canContinue = await hooks.waitBeforeItem(onStatus)
            if (!canContinue) return {cursor, succeededCount, failedCount, completed: false}
        }

        const syncStatus = await getSyncStatus()
        if (syncStatus.pendingQueueSize > HARD_WATERMARK) {
            onStatus(`Sheets 队列阻塞 (${syncStatus.pendingQueueSize})，等待消化...`)
            await sleepRandom(10_000, 15_000)
            i -= 1
            continue
        }

        const channelId = channelIds[i]
        if (profiledIds?.has(channelId)) {
            cursor = i + 1
            onStatus(`画像 ${i + 1}/${channelIds.length} 已回填，跳过`)
            await hooks.onProgressPersist?.({cursor, succeededCount, failedCount})
            continue
        }
        onStatus(`画像 ${i + 1}/${channelIds.length}`)

        try {
            const profile = await fetchAudienceProfile(channelId)
            const genderTag = classifyGender(profile.gender.female, profile.gender.male)
            const extraData = buildExtraDataFromProfile(profile, searchData[channelId] || {})
            cursor = i + 1
            succeededCount += 1
            profiledIds?.add(channelId)

            await enqueueUpdateStatus('tiktok', channelId, {
                genderTag,
                extraData,
                lastError: '',
                updatedAt: new Date().toISOString(),
            })

            await hooks.onProgressPersist?.({
                cursor,
                succeededCount,
                failedCount,
            })

            if (succeededCount % 500 === 0) {
                onStatus('长休 15~30分钟...')
                await sleepRandom(900_000, 1_800_000)
            } else if (succeededCount % 100 === 0) {
                onStatus('中休 2~4分钟...')
                await sleepRandom(120_000, 240_000)
            } else {
                await sleepRandom(2000, 5000)
            }
        } catch (error) {
            if (isSessionError(error)) {
                showAlarm('Nox 登录失效，任务已暂停', 20_000)
                await hooks.onSessionError?.()
                return {cursor, succeededCount, failedCount, completed: false}
            }
            failedCount += 1
            cursor = i + 1
            const lastError = error instanceof Error ? error.message : String(error)
            onStatus(`画像失败 ${i + 1}/${channelIds.length}: ${lastError}`)
            await enqueueUpdateStatus('tiktok', channelId, {
                lastError,
                updatedAt: new Date().toISOString(),
            })
            await hooks.onProgressPersist?.({
                cursor,
                succeededCount,
                failedCount,
                lastFailedReason: lastError,
            })
            await sleepRandom(2000, 5000)
        }
    }

    return {cursor, succeededCount, failedCount, completed: true}
}

async function runProfilingPhase(
    cp: LongTaskCheckpoint,
    channelIds: string[],
    onStatus: (msg: string) => void
): Promise<void> {
    await runProfilingLoop({
        channelIds,
        cursor: cp.profiling.cursor,
        succeededCount: cp.profiling.succeededCount,
        failedCount: cp.profiling.failedCount,
        searchData: cp.paging.searchData || {},
    }, onStatus, {
        waitBeforeItem: waitIfPaused,
        onProgressPersist: async ({cursor, succeededCount, failedCount, lastFailedReason}) => {
            await patchCheckpoint({
                profiling: {
                    status: cursor >= channelIds.length ? 'done' : 'running',
                    cursor,
                    succeededCount,
                    failedCount,
                    ...(lastFailedReason ? {lastFailedReason} : {}),
                }
            })
        },
        onSessionError: pauseLongTask,
    })
}

export async function backfillAudienceProfiles(
    channelIds: string[],
    onStatus: (msg: string) => void
): Promise<{succeededCount: number; failedCount: number}> {
    const result = await runProfilingLoop({
        channelIds,
        cursor: 0,
        succeededCount: 0,
        failedCount: 0,
        searchData: {},
    }, onStatus)

    return {
        succeededCount: result.succeededCount,
        failedCount: result.failedCount,
    }
}

export async function startAutoCollect(params: NoxAutoCollectParams, onStatus: (msg: string) => void): Promise<void> {
    if (mainLoopRunning) return
    mainLoopRunning = true

    try {
        const startResult = await startNoxAutoCollect(params)
        if ('error' in startResult) {
            onStatus(`启动失败: ${startResult.error}`)
            return
        }

        onStatus(`任务已启动 (${startResult.taskId})`)
        let cp = await getCheckpoint()
        if (!cp) return

        const profiledIds = params.collectProfile ? await loadProfiledChannelIds(onStatus) : undefined
        onStatus('翻页采集开始...')
        const {ok, newInfluencers} = await runPagingPhase(cp, onStatus, profiledIds)
        if (!ok) return

        cp = await getCheckpoint()
        if (!cp || cp.state !== 'running') return

        await patchCheckpoint({
            state: 'done',
            profiling: {
                ...cp.profiling,
                status: params.collectProfile ? 'done' : 'skipped',
            }
        })
        onStatus(`全部完成！共 ${newInfluencers.length} 个博主${params.collectProfile ? '（含画像）' : ''}`)
        showAlarm('Nox 自动采集完成！', 10_000)
    } finally {
        mainLoopRunning = false
    }
}

export async function resumeAutoCollect(onStatus: (msg: string) => void): Promise<void> {
    if (mainLoopRunning) return
    mainLoopRunning = true

    try {
        await resumeLongTask()
        let cp = await getCheckpoint()
        if (!cp) return

        if (cp.paging.status !== 'done') {
            onStatus('恢复翻页采集...')
            const profiledIds = cp.params.collectProfile ? await loadProfiledChannelIds(onStatus) : undefined
            const {ok} = await runPagingPhase(cp, onStatus, profiledIds)
            if (!ok) return
            cp = await getCheckpoint()
            if (!cp || cp.state !== 'running') return
        }

        if (!cp.params.collectProfile || cp.profiling.status === 'skipped') {
            await patchCheckpoint({state: 'done'})
            showAlarm('Nox 自动采集完成！', 10_000)
            return
        }

        const allChannelIds = cp.paging.newChannelIds
        onStatus(`恢复画像采集，从第 ${cp.profiling.cursor + 1}/${allChannelIds.length} 个开始...`)
        await runProfilingPhase(cp, allChannelIds, onStatus)

        cp = await getCheckpoint()
        if (cp?.state === 'running') {
            await patchCheckpoint({state: 'done'})
            onStatus('全部完成！')
            showAlarm('Nox 自动采集完成！', 10_000)
        }
    } finally {
        mainLoopRunning = false
    }
}
