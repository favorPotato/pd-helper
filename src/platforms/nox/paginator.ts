import {sleepRandom} from '../../shared/timing'
import {isSessionError} from '../../shared/alarm'
import {fetchSearchPage, readBaseParamsFromUrl, type SearchInfluencer} from './search-api'

export interface PaginateOptions {
    targetCount: number
    baseParams: Record<string, unknown>
    startPageNum?: number
    existingIds?: Set<string>
    onPageCollected?: (influencers: SearchInfluencer[], nextPageNum: number) => Promise<void>
}

export interface PaginateResult {
    influencers: SearchInfluencer[]
    totalPages: number
    totalSize: number
    nextPageNum: number
    stopped: 'target_reached' | 'no_more_pages' | 'circuit_broken' | 'session_expired'
}

export {readBaseParamsFromUrl}

export async function paginate(
    opts: PaginateOptions,
    onProgress: (msg: string) => void
): Promise<PaginateResult> {
    const {targetCount, baseParams, startPageNum = 1} = opts
    const seenIds = new Set<string>(opts.existingIds || [])
    const collected: SearchInfluencer[] = []
    let pageNum = startPageNum
    const pageSize = Number(baseParams.pageSize) || 100
    let totalPages = Math.max(startPageNum, Math.ceil(targetCount / pageSize))
    let totalSize = 0
    let consecutiveErrors = 0

    while (collected.length < targetCount && pageNum <= totalPages) {
        try {
            onProgress(`翻页 ${pageNum}/${totalPages} · 已收 ${collected.length}/${targetCount}`)
            const page = await fetchSearchPage(baseParams, pageNum)
            if (page.totalPage > 0) totalPages = page.totalPage
            totalSize = page.totalSize
            consecutiveErrors = 0

            if (page.influencers.length === 0) {
                if (opts.onPageCollected) await opts.onPageCollected([], pageNum)
                return {influencers: collected, totalPages, totalSize, nextPageNum: pageNum, stopped: 'no_more_pages'}
            }

            const pageNew: SearchInfluencer[] = []
            for (const inf of page.influencers) {
                if (seenIds.has(inf.id)) continue
                seenIds.add(inf.id)
                collected.push(inf)
                pageNew.push(inf)
                if (collected.length >= targetCount) break
            }

            if (opts.onPageCollected) {
                await opts.onPageCollected(pageNew, pageNum + 1)
            }

            pageNum += 1

            if (pageNum % 30 === 0) {
                onProgress('长休 5~10分钟...')
                await sleepRandom(300_000, 600_000)
            } else if (pageNum % 10 === 0) {
                onProgress('中休 30~60秒...')
                await sleepRandom(30_000, 60_000)
            } else {
                await sleepRandom(1500, 3000)
            }
        } catch (error) {
            consecutiveErrors += 1
            if (isSessionError(error)) {
                return {influencers: collected, totalPages, totalSize, nextPageNum: pageNum, stopped: 'session_expired'}
            }
            if (consecutiveErrors >= 3) {
                onProgress(`连续 ${consecutiveErrors} 次错误，熔断停止`)
                return {influencers: collected, totalPages, totalSize, nextPageNum: pageNum, stopped: 'circuit_broken'}
            }
            onProgress(`第 ${pageNum} 页错误 (${consecutiveErrors}/3): ${error instanceof Error ? error.message : String(error)}`)
            await sleepRandom(3000, 6000)
        }
    }

    return {
        influencers: collected,
        totalPages,
        totalSize,
        nextPageNum: pageNum,
        stopped: collected.length >= targetCount ? 'target_reached' : 'no_more_pages'
    }
}
