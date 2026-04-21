import {requestCollectVideoCount, requestCollectYearRange} from '../../shared/collect-params'
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
import {
    clearInfluencerPool,
    loadInfluencerPool,
    removeInfluencersFromPool,
    upsertInfluencerPool
} from './state'
import {fetchAudienceGender} from './client'
import {UiHelper, UrlHelper} from './helpers'
import {scrapeSelectedInfluencers} from './scraper'
import type {InfluencerPlatform, NoxInfluencer} from './types'

declare const window: Window & {
    __NOX_MESSAGE_HANDLER_LOADED__?: boolean
}

let audienceCollectInProgress = false
let tkCollectInProgress = false

const NO_QUALIFYING_VIDEO_ERROR = '当前博主没有符合要求的视频'

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

async function collectAudienceProfile(item: {channelId: string; platform: string; username: string; name: string}, index: number, total: number): Promise<NoxInfluencer> {
    const progress = `[${index + 1}/${total}]`
    const displayName = buildInfluencerLabel(item)
    try {
        UiHelper.log(`${progress} 获取受众数据: ${displayName}...`)
        const gender = await fetchAudienceGender(item.channelId)
        const genderTag = classifyGender(gender.female, gender.male)
        UiHelper.log(`${progress} ${genderTag} ${displayName} (♀${(gender.female * 100).toFixed(1)}% ♂${(gender.male * 100).toFixed(1)}%)`)
        return {
            ...item,
            platform: item.platform as NoxInfluencer['platform'],
            genderTag,
            femaleRatio: gender.female,
            maleRatio: gender.male
        }
    } catch (error) {
        UiHelper.log(`${progress} 获取受众数据失败: ${displayName} - ${truncateError(error, 200)}`)
        return {
            ...item,
            platform: item.platform as NoxInfluencer['platform'],
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

    const platform = selected[0]?.platform as InfluencerPlatform | undefined
    if (!platform) {
        UiHelper.log('未识别当前平台')
        return
    }

    UiHelper.log(`已选中 ${selected.length} 个博主 (${platform})`)

    audienceCollectInProgress = true
    await UiHelper.setBusyState({audienceCollecting: true})
    try {
        const influencers: NoxInfluencer[] = []
        for (let i = 0; i < selected.length; i += 1) {
            if (i > 0) await sleepRandom(2000, 5000)
            influencers.push(await collectAudienceProfile(selected[i], i, selected.length))
        }
        const summary = summarizeInfluencers(influencers)
        UiHelper.log(`分类汇总: FF=${summary.FF} F=${summary.F} N=${summary.N} M=${summary.M} MM=${summary.MM}`)
        const upsertResult = await upsertInfluencerPool(platform, influencers)
        UiHelper.log(`画像已加入池子：新增 ${upsertResult.added}，更新 ${upsertResult.updated}，当前共 ${upsertResult.total} 人`)
    } catch (error) {
        UiHelper.log(`画像采集异常: ${truncateError(error, 300)}`)
    } finally {
        audienceCollectInProgress = false
        await UiHelper.setBusyState({audienceCollecting: false})
    }
}

async function collectFromTikTokPool(): Promise<void> {
    if (audienceCollectInProgress || tkCollectInProgress) return

    const influencers = await loadInfluencerPool('tiktok')
    if (influencers.length === 0) {
        UiHelper.log('池子中没有 TikTok 博主')
        return
    }

    UiHelper.log(`池子中共有 ${influencers.length} 个 TikTok 博主`)

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
        const noVideoChannelIds: string[] = []

        for (let index = 0; index < influencers.length; index += 1) {
            const influencer = influencers[index]
            const progress = `[${index + 1}/${influencers.length}]`
            const displayName = buildInfluencerLabel(influencer)
            UiHelper.log(`${progress} ${influencer.genderTag}${displayName} → 使用 TikTok 执行页...`)

            try {
                UiHelper.log(`${progress} 开始采集 @${influencer.username}...`)
                const collectResult = await safeSendMessage<TkCollectViaTabResponse>({
                    type: TK_COLLECT_VIA_TAB,
                    tabId: tkTabId,
                    username: influencer.username,
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
                    const errorMsg = collectResult?.error || '未知错误'
                    UiHelper.log(`${progress} 采集失败: ${errorMsg}`)
                    if (errorMsg === NO_QUALIFYING_VIDEO_ERROR) {
                        noVideoChannelIds.push(influencer.channelId)
                    }
                }
            } catch (error) {
                UiHelper.log(`${progress} 异常: ${truncateError(error, 200)}`)
            }

            if (index < influencers.length - 1) {
                UiHelper.log('等待中...')
                await sleepRandom(5000, 8000)
            }
        }

        const toRemove = [...succeededChannelIds, ...noVideoChannelIds]
        const removeResult = await removeInfluencersFromPool('tiktok', toRemove)
        UiHelper.log(`TK采集结束：移除 ${removeResult.removed} 人（成功 ${succeededChannelIds.length}，无视频 ${noVideoChannelIds.length}），池子剩余 ${removeResult.total} 人`)
        UiHelper.log(`全部完成，共处理 ${influencers.length} 个博主`)
    } catch (error) {
        UiHelper.log(`批量采集异常: ${truncateError(error, 300)}`)
    } finally {
        tkCollectInProgress = false
        await UiHelper.setBusyState({tkCollecting: false})
    }
}

async function exportPool(): Promise<void> {
    if (audienceCollectInProgress || tkCollectInProgress) return

    const platform = UrlHelper.getSearchPlatform()
    if (!platform) {
        UiHelper.log('当前页面不支持导出')
        return
    }

    const influencers = await loadInfluencerPool(platform)
    if (influencers.length === 0) {
        UiHelper.log('池子为空，无需导出')
        return
    }

    const json = JSON.stringify(influencers, null, 2)
    const blob = new Blob([json], {type: 'application/json'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `influencer_pool_${platform}_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
    UiHelper.log(`已导出 ${influencers.length} 个博主`)
}

async function clearPool(): Promise<void> {
    if (audienceCollectInProgress || tkCollectInProgress) return

    const platform = UrlHelper.getSearchPlatform()
    if (!platform) {
        UiHelper.log('当前页面不支持清空池子')
        return
    }

    const confirmed = confirm('确认清空池子中所有博主？')
    if (!confirmed) return

    const result = await clearInfluencerPool(platform)
    UiHelper.log(`已清空池子，移除 ${result.removed} 人`)
    await UiHelper.refreshState()
}

export function setup(): void {
    initNoxMessageHandler()
    void UiHelper.inject({
        onCollectAudience: collectAudienceFromNox,
        onCollectTikTok: collectFromTikTokPool,
        onExportPool: exportPool,
        onClearPool: clearPool
    })
}
