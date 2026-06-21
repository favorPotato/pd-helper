// 本文件只承载 exolyt 检索/detail 数据类型（封装层入参 + search body + search/detail 结果）

// exolyt 封装层入参（1.2）：本层只接后端名透传，不做 9 字段强类型 / 前端名映射 / 默认值（属 1.3）
// 故取最不约束 1.3 的形态——后端名 KV 透传，避免与 1.3 的强类型 search body 冲突
// 1.3 的 ExolytSearchBody 是其结构化子集，结构化兼容；searchVideos 签名保持宽松（向后兼容 1.2 调用方）
export type ExolytSearchParams = Record<string, unknown>

// 1.3 三入口归一后的原始输入（后端名，未填默认/未校验）——URL 解析输出 / 条件表单逻辑层输入 / CLI KV 共用此形态
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
    type: 'hashtag';
    id: string;
}

// 1.3 组装 + 校验后的后端 search body（+page + 可选 or 检索项）——纯 JSON 可序列化（string/number/null/array）
// 字段带分号属 types 接口局部例外（风格约定）；page 固定 1 见 search-params.ts
// hashtag 经 or 数组承载（后端真实契约）；regions/followers/accountType 仍以扁平字段透传（后端兼容接受）
export interface ExolytSearchBody {
    sort: 'views_most' | 'views_least' | 'likes_most' | 'likes_least' | 'newest' | 'oldest';
    likesMin: number;
    page: number;
    mood: 'positive' | 'neutral' | 'negative' | null;
    dateStart: string;
    dateEnd: string;
    regions: string[];
    followers: string;
    accountType: number;
    or?: ExolytSearchTerm[];
}

// search/detail 返回结构化 raw：保留后端原始响应 body 供上层取数，外加本 story 对账够用的最小提取
// raw 为 page-bridge 解析后的 JSON（unknown，1.3/1.4 再按需强类型化）
export interface ExolytSearchResult {
    videoIds: string[]
    raw: unknown
}

export interface ExolytVideoDetail {
    videoId: string
    raw: unknown
}
