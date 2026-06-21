// 通用翻页骨架（Story 1.7 自 nox paginator.ts 泛化上移，行为等价）
// 顺序翻页 + 目标计数停止 + 去重 + 分级节奏 + 连续错熔断 + 会话失效短路——nox 博主采集复用，exolyt 不翻页不用本模块
import {sleepForPage, sleepAfterError, type PageRhythmOptions} from './throttle'

export type PaginateStop = 'target_reached' | 'no_more_pages' | 'circuit_broken' | 'session_expired'

// 单页抓取返回：items=本页条目、totalPage=后端总页数（>0 才更新）、totalSize=后端总量
export interface PageFetchResult<T> {
    items: T[]
    totalPage: number
    totalSize: number
}

export interface PaginateGenericOptions<T> {
    targetCount: number
    startPageNum?: number
    pageSize: number
    existingIds?: Iterable<string>
    // 从条目取去重键
    idOf: (item: T) => string
    // 抓第 pageNum 页
    fetchPage: (pageNum: number) => Promise<PageFetchResult<T>>
    // 会话失效判定（命中即 session_expired 短路，不计熔断）
    isSessionError: (error: unknown) => boolean
    // 本页新增（去重后）落地回调；nextPageNum=下一页号
    onPageCollected?: (pageNew: T[], nextPageNum: number) => Promise<void>
    // 连续错熔断阈值（默认 3，与 nox 现行一致）
    circuitThreshold?: number
    rhythm?: PageRhythmOptions
}

export interface PaginateGenericResult<T> {
    collected: T[]
    totalPages: number
    totalSize: number
    nextPageNum: number
    stopped: PaginateStop
}

export async function paginateGeneric<T>(
    opts: PaginateGenericOptions<T>,
    onProgress: (msg: string) => void
): Promise<PaginateGenericResult<T>> {
    const {targetCount, startPageNum = 1, pageSize, idOf, fetchPage, isSessionError, onPageCollected} = opts
    const threshold = opts.circuitThreshold ?? 3
    const seenIds = new Set<string>(opts.existingIds || [])
    const collected: T[] = []
    let pageNum = startPageNum
    let totalPages = Math.max(startPageNum, Math.ceil(targetCount / pageSize))
    let totalSize = 0
    let consecutiveErrors = 0

    while (collected.length < targetCount && pageNum <= totalPages) {
        try {
            onProgress(`翻页 ${pageNum}/${totalPages} · 已收 ${collected.length}/${targetCount}`)
            const page = await fetchPage(pageNum)
            if (page.totalPage > 0) totalPages = page.totalPage
            totalSize = page.totalSize
            consecutiveErrors = 0

            if (page.items.length === 0) {
                if (onPageCollected) await onPageCollected([], pageNum)
                return {collected, totalPages, totalSize, nextPageNum: pageNum, stopped: 'no_more_pages'}
            }

            const pageNew: T[] = []
            for (const item of page.items) {
                const id = idOf(item)
                if (seenIds.has(id)) continue
                seenIds.add(id)
                collected.push(item)
                pageNew.push(item)
                if (collected.length >= targetCount) break
            }

            if (onPageCollected) {
                await onPageCollected(pageNew, pageNum + 1)
            }

            pageNum += 1

            await sleepForPage(pageNum, onProgress, opts.rhythm)
        } catch (error) {
            consecutiveErrors += 1
            if (isSessionError(error)) {
                return {collected, totalPages, totalSize, nextPageNum: pageNum, stopped: 'session_expired'}
            }
            if (consecutiveErrors >= threshold) {
                onProgress(`连续 ${consecutiveErrors} 次错误，熔断停止`)
                return {collected, totalPages, totalSize, nextPageNum: pageNum, stopped: 'circuit_broken'}
            }
            onProgress(`第 ${pageNum} 页错误 (${consecutiveErrors}/${threshold}): ${error instanceof Error ? error.message : String(error)}`)
            await sleepAfterError()
        }
    }

    return {
        collected,
        totalPages,
        totalSize,
        nextPageNum: pageNum,
        stopped: collected.length >= targetCount ? 'target_reached' : 'no_more_pages'
    }
}
