// Story 1.1 跨 epic 锚点契约冻结：以下取值为 Epic 2/3/4 共同引用的单一真相源，留模板不留值会致下游返工

// 链路B（tk 详情/视频）是否已采到该 videoId 的视频文件——经 _collect.video 表达
// not_attempted=从未触发链路B（区别于触发后失败）；failed=触发但失败；gone/auth_wall=终态不可采；pending=过渡可重试
export type VideoState = 'not_attempted' | 'ok' | 'failed' | 'gone' | 'auth_wall' | 'pending'

// 资源（raw JSON）是否已落盘——枚举刻意比 VideoState 窄，够区分「未采 vs 失败」即可，不复用 video 全集
export type ResourceState = 'not_attempted' | 'ok' | 'failed'

// _collect 旁路文件内容：每个 videoId 一份，记录三类产物的采集态
// 物理载体 = raws/{platform}/{videoId}._collect.json（与 raw 同目录、._collect 中缀消歧），绝不写入 raw JSON 顶层
// —— 守 FR-11「raw 只读」：Epic 2 覆写 video 态时改的是旁路文件，不回写 raw
export interface CollectMeta {
    video: VideoState
    exolyt: ResourceState
    tkRaw: ResourceState
}

// 链路A（本 epic）落盘时固定写入的 _collect 初值：exolyt raw 已落、video/tkRaw 尚未触发链路B
// 由 1.5/1.6 落盘引用本常量，避免下游手写枚举易错
export const LINK_A_COLLECT_META: CollectMeta = {exolyt: 'ok', video: 'not_attempted', tkRaw: 'not_attempted'}

// 共用采集 checkpoint 单一套形态（架构决策点 4）：带 type 字段区分维度（exolyt-detail / tk-download / nox-auto-collect），非两份
// 本 story 只冻结类型形态；IDB 实现/shared/collect 抽取在 1.5（就地）/1.7（上移）。SW 重启时 running→orphaned 不自动续跑
export interface CollectCheckpoint {
    id: string
    type: string
    state: 'running' | 'paused' | 'done' | 'failed'
    updatedAt: number
    cursor: unknown
    params: Record<string, unknown>
}

// 本 epic checkpoint 维度判别串
export const CHECKPOINT_TYPE_EXOLYT_DETAIL = 'exolyt-detail'

// 输出根默认值与环境变量兜底键——约定记录于此供 CLI 侧解析引用
// 注意：env 解析在 cli 侧（process.env 合法），扩展 bundle 内禁读 process.env，故本 story 仅冻结约定不在运行时取值
// 批根 = <root>/_collect-output/<batchId>/，其下 raws/exolyt/ + raws/tiktok/ + videos/（index/ 不在采集产物内）
// 目录布局：raws/exolyt/{videoId}.json（exolyt detail raw，只读）、视频 videos/{videoId}.{ext} 平铺
// —— 无博主维度、不按 videoId 建子目录
export const COLLECT_OUTPUT_DIR = '_collect-output'
export const COLLECT_OUTPUT_OUT_ENV = 'PD_HELPER_COLLECT_OUT'

// batchId 续采复用规则（冻结于注释，IDB 实现在 1.5）：
// 生成规则——时间戳优先，紧凑串 <yyyyMMdd-HHmmss>（禁含路径非法字符），一经生成即写入 checkpoint.params 作该批唯一定位键
// 续采复用——不生成新 batchId，从 checkpoint（按 type='exolyt-detail'）读回既有 batchId 写回同目录，否则破 SM-3；亦支持 --batch 显式指定

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
