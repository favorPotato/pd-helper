import {showDialog} from '../../shared/custom-dialog'
import {truncateError} from '../../shared/errors'
import {safeSendMessage} from '../../shared/messaging'
import {
    isNoxLogMessage,
    PREPARE_TK_TAB,
    type PrepareTkTabResponse,
    TK_COLLECT_VIA_TAB,
    TK_PROFILE_METRICS_VIA_TAB,
    type TkProfileMetricsResponse,
    type TkCollectViaTabResponse
} from '../../shared/remote-collect'
import {sleepRandom} from '../../shared/timing'
import {enqueueUpdateStatus, enqueueUpsertInfluencers} from '../../shared/sheets-sync'
import {checkAppsScriptHealth} from '../../shared/apps-script-client'
import {callAppsScript} from '../../shared/apps-script-client'
import {fetchAudienceProfile} from './client'
import {UiHelper} from './helpers'
import {scrapeSelectedInfluencers} from './scraper'
import {backfillAudienceProfiles, startAutoCollect, resumeAutoCollect} from './auto-collect'
import {readBaseParamsFromUrl} from './paginator'
import {fetchSearchPage, getSearchUrlWithoutPageNum, type SearchInfluencer} from './search-api'
import {pauseLongTask} from './long-task'
import {buildExtraDataFromProfile, classifyGender, extractSearchExtra} from './profile-mapping'
import {startSyncWorker} from '../../shared/sheets-sync'
import type {InfluencerPlatform, NoxInfluencer} from './types'

declare const window: Window & {
    __NOX_MESSAGE_HANDLER_LOADED__?: boolean
}

let audienceCollectInProgress = false
let tkCollectInProgress = false
let autoCollectPaused = false

const NO_QUALIFYING_VIDEO_ERROR = '当前博主没有符合要求的视频'

function initNoxMessageHandler(): void {
    if (window.__NOX_MESSAGE_HANDLER_LOADED__) return
    window.__NOX_MESSAGE_HANDLER_LOADED__ = true

    chrome.runtime.onMessage.addListener((msg) => {
        if (!isNoxLogMessage(msg)) return
        UiHelper.log(msg.message)
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
        fields: [
            {key: 'batchSize', label: '采集博主数', type: 'number', value: 500, min: 1},
            {key: 'videoCount', label: '每博主视频数', type: 'number', value: 20, min: 1},
            {key: 'minLikeRate', label: '最低点赞率 (0~1)', type: 'number', value: 0.02, step: 0.01, min: 0, max: 1, group: '过滤条件'},
            {key: 'maxDurationSec', label: '最长视频时长（秒）', type: 'number', value: 60, step: 1, min: 1, group: '过滤条件'},
            {key: 'startDate', label: '起始日期', type: 'date'},
            {key: 'endDate', label: '截止日期', type: 'date'}
        ]
    })
    if (!params) return

    const batchSize = Number(params.batchSize) || 500
    const maxVideoCount = Number(params.videoCount) || 20
    const todayNox = new Date()
    const defaultFromNox = new Date(todayNox); defaultFromNox.setMonth(defaultFromNox.getMonth() - 3)
    const fromTs = params.startDate ? new Date(params.startDate as string).getTime() : defaultFromNox.getTime()
    const toTs = params.endDate ? new Date(params.endDate as string + 'T23:59:59').getTime() : todayNox.getTime()

    let influencers: NoxInfluencer[]
    try {
        const resp = await callAppsScript<{ok: boolean; items: NoxInfluencer[]}>('loadInfluencersByStatus', {
            platform: 'tiktok',
            status: 'unused',
            limit: batchSize
        })
        influencers = (resp.items || []).filter(inf => inf.genderTag)
    } catch (e) {
        UiHelper.log(`从 Sheets 拉取失败: ${truncateError(e, 200)}`)
        return
    }

    if (influencers.length === 0) {
        UiHelper.log('Sheets 中没有未采博主（或画像未回填）')
        return
    }

    UiHelper.log(`从 Sheets 拉取 ${influencers.length} 个未采博主`)

    tkCollectInProgress = true
    await UiHelper.setBusyState({tkCollecting: true})
    try {
        const prepareResult = await safeSendMessage<PrepareTkTabResponse>({type: PREPARE_TK_TAB})
        if (!prepareResult?.ok || !prepareResult.tabId) {
            UiHelper.log(`TikTok 执行页不可用: ${prepareResult?.error || '未知错误'}`)
            return
        }

        UiHelper.log(`复用 TikTok 执行页: ${prepareResult.href || '当前站内页'}`)
        let tkTabId = prepareResult.tabId
        const succeededChannelIds: string[] = []
        const noVideoChannelIds: string[] = []

        for (let index = 0; index < influencers.length; index += 1) {
            const influencer = influencers[index]
            const progress = `[${index + 1}/${influencers.length}]`
            const displayName = buildInfluencerLabel(influencer)
            UiHelper.log(`${progress} ${influencer.genderTag}${displayName} → 使用 TikTok 执行页...`)

            try {
                UiHelper.log(`${progress} 开始采集 @${influencer.username}...`)
                let metricsSummary = ''
                const metricsResult = await safeSendMessage<TkProfileMetricsResponse>({
                    type: TK_PROFILE_METRICS_VIA_TAB,
                    tabId: tkTabId,
                    username: influencer.username,
                    minLikeRate: Number(params.minLikeRate) || 0.02,
                    maxDurationSec: Number(params.maxDurationSec) || 60,
                })
                if (metricsResult?.ok) {
                    metricsSummary = metricsResult.qualifyingRate != null ? `${(metricsResult.qualifyingRate * 100).toFixed(1)}%` : ''
                    await enqueueUpdateStatus('tiktok', influencer.channelId, {
                        qualifyingRate: metricsResult.qualifyingRate,
                        postRate: metricsResult.postRate ?? '',
                        updatedAt: new Date().toISOString()
                    })
                } else {
                    const errorMsg = metricsResult?.error || '指标预估失败'
                    if (errorMsg.includes('当前博主已关闭评论功能')) {
                        UiHelper.log(`${progress} ${errorMsg}，跳过`)
                        await enqueueUpdateStatus('tiktok', influencer.channelId, {
                            status: 'failed',
                            lastError: errorMsg.slice(0, 200),
                            updatedAt: new Date().toISOString()
                        })
                        continue
                    }
                    UiHelper.log(`${progress} ${errorMsg}，重建 TK tab 后重试...`)
                    const resetResult = await safeSendMessage<{ok: boolean; removed?: number; removeFailed?: number; closedTabs?: number; error?: string}>({type: 'reset_tk_tab', tabId: tkTabId})
                    if (!resetResult?.ok) {
                        const resetError = resetResult?.error || 'reset_tk_tab 无响应'
                        UiHelper.log(`${progress} TK tab 重建失败: ${resetError}`)
                        await enqueueUpdateStatus('tiktok', influencer.channelId, {
                            status: 'failed',
                            lastError: resetError.slice(0, 200),
                            updatedAt: new Date().toISOString()
                        })
                        continue
                    }
                    UiHelper.log(`${progress} TK tab 重建完成: 关闭 ${resetResult.closedTabs || 0} 个 tab，清理 ${resetResult.removed || 0} 个 cookie，失败 ${resetResult.removeFailed || 0}`)
                    const newTab = await safeSendMessage<PrepareTkTabResponse>({type: PREPARE_TK_TAB})
                    if (!newTab?.ok || !newTab.tabId) {
                        const tabError = newTab?.error || '新 TK 执行页不可用'
                        UiHelper.log(`${progress} ${tabError}`)
                        await enqueueUpdateStatus('tiktok', influencer.channelId, {
                            status: 'failed',
                            lastError: tabError.slice(0, 200),
                            updatedAt: new Date().toISOString()
                        })
                        continue
                    }
                    tkTabId = newTab.tabId
                    UiHelper.log(`${progress} 新 TK 执行页就绪: ${newTab.href || '当前站内页'}`)
                    const retryResult = await safeSendMessage<TkProfileMetricsResponse>({
                        type: TK_PROFILE_METRICS_VIA_TAB,
                        tabId: tkTabId,
                        username: influencer.username,
                        minLikeRate: Number(params.minLikeRate) || 0.02,
                        maxDurationSec: Number(params.maxDurationSec) || 60,
                    })
                    if (retryResult?.ok) {
                        metricsSummary = retryResult.qualifyingRate != null ? `${(retryResult.qualifyingRate * 100).toFixed(1)}%` : ''
                        await enqueueUpdateStatus('tiktok', influencer.channelId, {
                            qualifyingRate: retryResult.qualifyingRate,
                            postRate: retryResult.postRate ?? '',
                            updatedAt: new Date().toISOString()
                        })
                    } else {
                        UiHelper.log(`${progress} 重试仍失败，跳过`)
                        await enqueueUpdateStatus('tiktok', influencer.channelId, {
                            status: 'failed',
                            lastError: (retryResult?.error || errorMsg).slice(0, 200),
                            updatedAt: new Date().toISOString()
                        })
                        continue
                    }
                }

                const collectResult = await safeSendMessage<TkCollectViaTabResponse>({
                    type: TK_COLLECT_VIA_TAB,
                    tabId: tkTabId,
                    username: influencer.username,
                    maxVideoCount,
                    fromTs,
                    toTs,
                    minLikeRate: Number(params.minLikeRate) || 0.02,
                    maxDurationSec: Number(params.maxDurationSec) || 60,
                    filenamePrefix: influencer.genderTag,
                })

                if (collectResult?.ok) {
                    succeededChannelIds.push(influencer.channelId)
                    const archivedVideoCount = Number(collectResult.downloadSummary?.succeeded) || 0
                    UiHelper.log(
                        `${progress} 完成: ${collectResult.filename || ''} (${metricsSummary ? `合格率 ${metricsSummary}, ` : ''}下载 ${collectResult.downloadSummary?.succeeded || 0}/${collectResult.downloadSummary?.attempted || 0})`
                    )
                    await enqueueUpdateStatus('tiktok', influencer.channelId, {
                        status: 'used',
                        archivedVideoCount,
                        lastError: '',
                        updatedAt: new Date().toISOString()
                    })
                } else {
                    const errorMsg = collectResult?.error || '未知错误'
                    UiHelper.log(`${progress} 采集失败: ${errorMsg}`)
                    if (errorMsg === NO_QUALIFYING_VIDEO_ERROR) {
                        noVideoChannelIds.push(influencer.channelId)
                        await enqueueUpdateStatus('tiktok', influencer.channelId, {
                            status: 'used',
                            archivedVideoCount: 0,
                            lastError: '',
                            updatedAt: new Date().toISOString()
                        })
                    } else {
                        await enqueueUpdateStatus('tiktok', influencer.channelId, {
                            status: 'failed',
                            lastError: errorMsg.slice(0, 200),
                            updatedAt: new Date().toISOString()
                        })
                    }
                }
            } catch (error) {
                const errorMsg = truncateError(error, 200)
                UiHelper.log(`${progress} 异常: ${errorMsg}`)
                await enqueueUpdateStatus('tiktok', influencer.channelId, {
                    status: 'failed',
                    lastError: errorMsg,
                    updatedAt: new Date().toISOString()
                })
            }

            if (index < influencers.length - 1) {
                UiHelper.log('等待中...')
                await sleepRandom(5000, 8000)
            }
        }

        UiHelper.log(`TK采集结束：成功 ${succeededChannelIds.length}，无视频 ${noVideoChannelIds.length}，共处理 ${influencers.length} 个博主`)
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
        await UiHelper.setBusyState({autoCollecting: true})
        await resumeAutoCollect((msg) => {
            UiHelper.setAutoCollectStatus(msg)
            UiHelper.log(msg)
        })
        await UiHelper.setBusyState({autoCollecting: false})
        UiHelper.setAutoCollectStatus('')
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
