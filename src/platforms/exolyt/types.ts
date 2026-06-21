// 封装层入参：本层只接后端名透传，不做强类型 / 前端名映射 / 默认值。
// 取最宽松形态——后端名 KV 透传；ExolytSearchBody 是其结构化子集，searchVideos 签名保持宽松。
export type ExolytSearchParams = Record<string, unknown>

// 三入口归一后的原始输入（后端名，未填默认/未校验）——URL 解析输出 / 条件表单逻辑层输入 / CLI KV 共用此形态
// 各字段可缺省（缺失才填默认）；likesMin/accountType 允许字符串（URL/CLI 来源）由 buildSearchBody 收敛为 number
export interface ExolytRawSearchInput {
    sort?: unknown
    likesMin?: unknown
    mood?: unknown
    dateStart?: unknown
    dateEnd?: unknown
    regions?: unknown
    hashtags?: unknown
    followers?: unknown
    accountType?: unknown
}

// 后端 hashtag 检索项：实测 /video-insight/search 以 or:[{type:'hashtag',id}] 承载多/单 hashtag（非扁平 hashtags 串）
export interface ExolytSearchTerm {
    type: 'hashtag'
    id: string
}

// 组装 + 校验后的后端 search body（+page + 可选 or 检索项）——纯 JSON 可序列化（string/number/null/array）
// hashtag 经 or 数组承载（后端真实契约）；regions/followers/accountType 仍以扁平字段透传（后端兼容接受）
export interface ExolytSearchBody {
    sort: 'views_most' | 'views_least' | 'likes_most' | 'likes_least' | 'newest' | 'oldest'
    likesMin: number
    page: number
    mood: 'positive' | 'neutral' | 'negative' | null
    dateStart: string
    dateEnd: string
    regions: string[]
    followers: string
    accountType: number
    or?: ExolytSearchTerm[]
}

// search/detail 返回结构化 raw：保留后端原始响应 body 供上层取数，外加最小提取
// raw 为 page-bridge 解析后的 JSON（unknown）
export interface ExolytSearchResult {
    videoIds: string[]
    raw: unknown
}

export interface ExolytVideoDetail {
    videoId: string
    raw: unknown
}
