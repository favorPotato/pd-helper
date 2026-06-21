import type {CsRuntime} from '../../shared/cli-bridge/cs-runtime'
import type {ExolytRawSearchInput} from './types'
import {searchVideos} from './api'
import {resolveSearchBody, parseSearchUrl, SEARCH_RESULT_LIMIT} from './search-params'

// 链路A 编排入口（1.3）：三入口 → 映射 → 默认 → 校验 → 组装 9 字段 body → 调 searchVideos → ≤200 videoId
// 本 story 终点 = 拿 videoId 列表即收口，不进 fetchDetail（detail 并发/时长门属 1.4 接力）
// 入参：rawUrl（粘 exolyt 前端 URL，优先）或 input（条件表单逻辑层 / CLI KV，后端名）——二者经同一 resolveSearchBody 收口
export interface ExolytCollectInput {
    rawUrl?: string
    input?: ExolytRawSearchInput
}

export async function collectExolyt(params: ExolytCollectInput, rt: CsRuntime): Promise<string[]> {
    rt.throwIfCancelled()

    // URL 入口优先：粘前端筛选 URL → 解析为后端名原始输入；否则用直传的条件表单/CLI KV
    const rawInput: ExolytRawSearchInput = params.rawUrl ? parseSearchUrl(params.rawUrl) : (params.input ?? {})

    // 组装 + 白名单校验：非法值在此经 withPdCode('INVALID_PARAM') 抛带前缀错误，绝不静默回落默认
    const body = resolveSearchBody(rawInput)
    rt.log(`[exolyt] search body 组装完成 sort=${body.sort} regions=${body.regions.join(',')} hashtags=${body.or?.length ?? 0}`)

    rt.throwIfCancelled()
    // body 为纯 JSON 可序列化对象（string/number/null/array），不含 Headers/AbortSignal/函数——避免 postMessage 结构化克隆静默丢字段
    // 展开为 Record 透传 1.2 searchVideos（ExolytSearchParams=Record）：ExolytSearchBody 无索引签名故浅拷贝桥接，同时去强类型束缚
    const result = await searchVideos({...body})

    // ≤200 硬上限（AC4）：page 固定单页不递增，后端单页即便 >200 也在此截断守上限
    const videoIds = result.videoIds.slice(0, SEARCH_RESULT_LIMIT)
    rt.log(`[exolyt] 检索得 ${result.videoIds.length} 条，截断后 ${videoIds.length} 条 videoId（本 story 收口，detail 交 1.4）`)

    return videoIds
}
