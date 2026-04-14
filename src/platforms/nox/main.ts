import {requestCollectVideoCount, requestCollectYearRange} from '../../shared/collect-params'
import {mapWithConcurrency} from '../../shared/async'
import {truncateError} from '../../shared/errors'
import {safeSendMessage} from '../../shared/messaging'
import {
    isNoxLogMessage,
    PREPARE_TK_TAB,
    type PrepareTkTabResponse,
    TK_COLLECT_VIA_TAB,
    type TkCollectViaTabResponse
} from '../../shared/remote-collect'
import {sleepRandom} from '../../shared/timing'
import {fetchAudienceGender} from './client'
import {UiHelper} from './helpers'
import {scrapeSelectedInfluencers} from './scraper'
import {loadNoxInfluencerPool, removeNoxInfluencersFromPool, upsertNoxInfluencerPool} from './state'
import type {NoxInfluencer} from './types'

declare const window: Window & {
    __NOX_MESSAGE_HANDLER_LOADED__?: boolean
}

const NOX_AUDIENCE_CONCURRENCY = 8

let audienceCollectInProgress = false
let tkCollectInProgress = false

function initNoxMessageHandler(): void {
    if (window.__NOX_MESSAGE_HANDLER_LOADED__) return
    window.__NOX_MESSAGE_HANDLER_LOADED__ = true

    chrome.runtime.onMessage.addListener((msg) => {
        if (!isNoxLogMessage(msg)) return
        UiHelper.log(msg.message)
    })
}

function classifyGender(femaleRatio: number, maleRatio: number): string {
    if (femaleRatio >= 0.70) return 'FF-'
    if (femaleRatio >= 0.55) return 'F-'
    if (maleRatio >= 0.70) return 'MM-'
    if (maleRatio >= 0.55) return 'M-'
    return 'N-'
}

function buildInfluencerLabel(influencer: {name: string; tiktokUsername: string}): string {
    return influencer.name || `@${influencer.tiktokUsername}`
}

function summarizeInfluencers(influencers: NoxInfluencer[]): {FF: number; F: number; N: number; M: number; MM: number} {
    const summary = {FF: 0, F: 0, N: 0, M: 0, MM: 0}
    for (const influencer of influencers) {
        const key = influencer.genderTag.replace('-', '') as keyof typeof summary
        summary[key] += 1
    }
    return summary
}

async function collectAudienceProfile(item: {channelId: string; tiktokUsername: string; name: string}, index: number, total: number): Promise<NoxInfluencer> {
    const progress = `[${index + 1}/${total}]`
    const displayName = buildInfluencerLabel(item)
    try {
        UiHelper.log(`${progress} 获取受众数据: ${displayName}...`)
        const gender = await fetchAudienceGender(item.channelId)
        const genderTag = classifyGender(gender.female, gender.male)
        UiHelper.log(`${progress} ${genderTag} ${displayName} (♀${(gender.female * 100).toFixed(1)}% ♂${(gender.male * 100).toFixed(1)}%)`)
        return {
            ...item,
            genderTag,
            femaleRatio: gender.female,
            maleRatio: gender.male
        }
    } catch (error) {
        UiHelper.log(`${progress} 获取受众数据失败: ${displayName} - ${truncateError(error, 200)}`)
        return {
            ...item,
            genderTag: 'N-',
            femaleRatio: 0,
            maleRatio: 0
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

    UiHelper.log(`已选中 ${selected.length} 个博主`)

    audienceCollectInProgress = true
    await UiHelper.setBusyState({audienceCollecting: true})
    try {
        const influencers = await mapWithConcurrency(selected, NOX_AUDIENCE_CONCURRENCY, (item, index) => collectAudienceProfile(item, index, selected.length))
        const summary = summarizeInfluencers(influencers)
        UiHelper.log(`分类汇总: FF=${summary.FF} F=${summary.F} N=${summary.N} M=${summary.M} MM=${summary.MM}`)
        const upsertResult = await upsertNoxInfluencerPool(influencers)
        UiHelper.log(`画像已加入待采集池：新增 ${upsertResult.added}，更新 ${upsertResult.updated}，当前共 ${upsertResult.total} 人`)
    } catch (error) {
        UiHelper.log(`画像采集异常: ${truncateError(error, 300)}`)
    } finally {
        audienceCollectInProgress = false
        await UiHelper.setBusyState({audienceCollecting: false})
    }
}

async function collectFromTikTokPool(): Promise<void> {
    if (audienceCollectInProgress || tkCollectInProgress) return

    const influencers = await loadNoxInfluencerPool()
    if (influencers.length === 0) {
        UiHelper.log('请先采集画像，再执行 TK采集')
        return
    }

    UiHelper.log(`待采集池中共有 ${influencers.length} 个博主`)

    const maxVideoCount = requestCollectVideoCount()
    if (maxVideoCount === null) return

    const yearRange = requestCollectYearRange()
    if (yearRange === null) return

    tkCollectInProgress = true
    await UiHelper.setBusyState({tkCollecting: true})
    try {

        const prepareResult = await safeSendMessage<PrepareTkTabResponse>({type: PREPARE_TK_TAB})
        if (!prepareResult?.ok || !prepareResult.tabId) {
            UiHelper.log(`TikTok 执行页不可用: ${prepareResult?.error || '未知错误'}`)
            return
        }

        UiHelper.log(`复用 TikTok 执行页: ${prepareResult.href || '当前站内页'}`)
        const tkTabId = prepareResult.tabId
        const succeededChannelIds: string[] = []

        for (let index = 0; index < influencers.length; index += 1) {
            const influencer = influencers[index]
            const progress = `[${index + 1}/${influencers.length}]`
            const displayName = buildInfluencerLabel(influencer)
            UiHelper.log(`${progress} ${influencer.genderTag}${displayName} → 使用 TikTok 执行页...`)

            try {
                UiHelper.log(`${progress} 开始采集 @${influencer.tiktokUsername}...`)
                const collectResult = await safeSendMessage<TkCollectViaTabResponse>({
                    type: TK_COLLECT_VIA_TAB,
                    tabId: tkTabId,
                    username: influencer.tiktokUsername,
                    maxVideoCount,
                    startYear: yearRange.startYear,
                    endYear: yearRange.endYear,
                    filenamePrefix: influencer.genderTag
                })

                if (collectResult?.ok) {
                    succeededChannelIds.push(influencer.channelId)
                    UiHelper.log(
                        `${progress} 完成: ${collectResult.filename || ''} (${collectResult.videoCount || 0} 视频, 下载 ${collectResult.downloadSummary?.succeeded || 0}/${collectResult.downloadSummary?.attempted || 0})`
                    )
                } else {
                    UiHelper.log(`${progress} 采集失败: ${collectResult?.error || '未知错误'}`)
                }
            } catch (error) {
                UiHelper.log(`${progress} 异常: ${truncateError(error, 200)}`)
            }

            if (index < influencers.length - 1) {
                UiHelper.log('等待中...')
                await sleepRandom(5000, 8000)
            }
        }

        const removeResult = await removeNoxInfluencersFromPool(succeededChannelIds)
        UiHelper.log(`TK采集结束：成功移除 ${removeResult.removed} 人，待采集池剩余 ${removeResult.total} 人`)
        UiHelper.log(`全部完成，共处理 ${influencers.length} 个博主`)
    } catch (error) {
        UiHelper.log(`批量采集异常: ${truncateError(error, 300)}`)
    } finally {
        tkCollectInProgress = false
        await UiHelper.setBusyState({tkCollecting: false})
    }
}

export function setup(): void {
    initNoxMessageHandler()
    void UiHelper.inject({onCollectAudience: collectAudienceFromNox, onCollectTikTok: collectFromTikTokPool})
}
