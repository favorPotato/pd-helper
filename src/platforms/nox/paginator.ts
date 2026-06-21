import {isSessionError} from '../../shared/alarm'
import {paginateGeneric, type PaginateStop} from '../../shared/collect/paginator'
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
    stopped: PaginateStop
}

export {readBaseParamsFromUrl}

// thin-wrap：翻页/节奏/熔断逻辑上移 shared/collect（Story 1.7，行为等价）；本文件只绑定 nox 的 fetch/字段
// long-task.ts 内存 checkpoint 与博主驱动编排（auto-collect/search-api/profile-mapping）不在本次改动内（FR-15）
export async function paginate(
    opts: PaginateOptions,
    onProgress: (msg: string) => void
): Promise<PaginateResult> {
    const {targetCount, baseParams, startPageNum = 1} = opts
    const pageSize = Number(baseParams.pageSize) || 100

    const result = await paginateGeneric<SearchInfluencer>({
        targetCount,
        startPageNum,
        pageSize,
        existingIds: opts.existingIds,
        idOf: (inf) => inf.id,
        fetchPage: async (pageNum) => {
            const page = await fetchSearchPage(baseParams, pageNum)
            return {items: page.influencers, totalPage: page.totalPage, totalSize: page.totalSize}
        },
        isSessionError,
        onPageCollected: opts.onPageCollected
    }, onProgress)

    return {
        influencers: result.collected,
        totalPages: result.totalPages,
        totalSize: result.totalSize,
        nextPageNum: result.nextPageNum,
        stopped: result.stopped
    }
}
