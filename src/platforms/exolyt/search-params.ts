import {withPdCode} from '../../shared/cli-bridge/cs-runtime'
import type {ExolytSearchBody, ExolytRawSearchInput} from './types'

// 检索入参收口（CS 侧，纯函数）：三入口 → 前端名映射 → 组装 → 默认填充 → 白名单校验 → 纯 JSON body
// 校验落 CS 就近：非法值经 withPdCode(err,'INVALID_PARAM') 抛带前缀错误，绝不静默回落默认；
// 校验对象是组装后的 body，组装在 CS，校验跟着 CS 最省一次「下发→回传重组」。

// 枚举白名单全集来自实地核对 exolyt 站点筛选面板（react-select option 底层 value）：
// sort 6 值、mood null+3、accountType 0(不限)/1(已验证)
const SORT_WHITELIST = ['views_most', 'views_least', 'likes_most', 'likes_least', 'newest', 'oldest'] as const
const MOOD_WHITELIST = ['positive', 'neutral', 'negative'] as const
const ACCOUNT_TYPE_WHITELIST = [0, 1] as const

// followers 是 min_max 区间串：UI 给离散档位、后端收区间串，故用格式正则而非枚举全集（不依赖档位枚举即可守格式）
const FOLLOWERS_RE = /^\d+_\d+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// 默认 search 参数：缺失才填、不覆盖入口值、不替代校验
// regions 业务锁 BR 但工具层可配——故作默认而非硬编码常量，入口给值即用入口值
const DEFAULT_REGIONS = ['BR']
const DEFAULT_FOLLOWERS = '0_100000'
const DEFAULT_ACCOUNT_TYPE = 0
const DEFAULT_LIKES_MIN = 1000
const DEFAULT_SORT = 'likes_most'

// 上限 200 硬约束：试用账号硬顶 200，翻页合并去重到此即止
export const SEARCH_RESULT_LIMIT = 200

function invalid(reason: string): never {
    throw withPdCode(new Error(`[INVALID_PARAM] exolyt 检索参数非法：${reason}`), 'INVALID_PARAM')
}

// 运行时今天 -1 日的 YYYY-MM-DD（默认日期 = 昨天单日，dateStart=dateEnd）
function yesterday(): string {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

// 前端 query 名 → 后端名映射：areas→regions、videoSort→sort（站点实地核对）；其余前端名与后端名同名直透
// likesMax 一律丢弃（赞数仅下限，冻结）——不进映射结果、不组装进 body
function mapFrontKey(key: string): string | null {
    if (key === 'areas') return 'regions'
    if (key === 'videoSort') return 'sort'
    if (key === 'likesMax') return null
    return key
}

// 解析 exolyt 前端筛选 URL 的 query 串为原始输入对象（后端名）
// 数组字段（regions/hashtags）站点用逗号分隔串；likesMin/accountType 站点给数字串，此处保留原串交 buildSearchBody 收敛
export function parseSearchUrl(url: string): ExolytRawSearchInput {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        invalid(`URL 无法解析：${url}`)
    }
    const out: ExolytRawSearchInput = {}
    parsed.searchParams.forEach((value: string, rawKey: string) => {
        const key = mapFrontKey(rawKey)
        if (key === null) return
        if (key === 'regions' || key === 'hashtags') {
            // 逗号分隔串 → 数组；空串视为不带（交默认填充）
            const arr = value.split(',').map((s) => s.trim()).filter(Boolean)
            ;(out as Record<string, unknown>)[key] = arr
        } else {
            ;(out as Record<string, unknown>)[key] = value
        }
    })
    return out
}

// 把原始入口值收敛为强类型：仅在「是数字串」时转 number，非法格式留原值交校验拦（绝不静默回落默认）
function coerceNumber(raw: unknown): unknown {
    if (typeof raw === 'number') return raw
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw)
    return raw
}

// 组装 body：缺失才填默认、入口给值不被覆盖；page 默认 1（翻页由 searchPhase 逐页覆盖）；
// hashtag 经 or:[{type:'hashtag',id}] 承载（后端真实契约，实测旧扁平 hashtags+searchMode 多值返回空）。
export function buildSearchBody(input: ExolytRawSearchInput): ExolytSearchBody {
    // 空串标量与空数组皆视为「未给值」回落默认：URL 解析路径会带 ?areas= / ?dateStart= 等空值，
    // 若判为已给则空 regions:[] 静默丢 BR 业务锁、空串标量经 validate 误报 INVALID_PARAM。
    // CLI 路径 passStr/passArr 已先剔空，永不命中此分支，故行为不变。
    const has = (k: keyof ExolytRawSearchInput): boolean => {
        const v = input[k]
        if (v === undefined || v === null) return false
        if (typeof v === 'string') return v !== ''
        if (Array.isArray(v)) return v.length > 0
        return true
    }
    const day = yesterday()

    const regions = has('regions') ? input.regions : DEFAULT_REGIONS
    const hashtags = has('hashtags') ? input.hashtags : []
    const sort = has('sort') ? input.sort : DEFAULT_SORT
    const likesMin = has('likesMin') ? coerceNumber(input.likesMin) : DEFAULT_LIKES_MIN
    const accountType = has('accountType') ? coerceNumber(input.accountType) : DEFAULT_ACCOUNT_TYPE
    const followers = has('followers') ? input.followers : DEFAULT_FOLLOWERS
    const dateStart = has('dateStart') ? input.dateStart : day
    const dateEnd = has('dateEnd') ? input.dateEnd : day
    // mood 默认 null（实测范例 mood:null = 不限情绪）；入口给值才带枚举
    const mood = has('mood') ? input.mood : null

    const body: ExolytSearchBody = {
        sort: sort as ExolytSearchBody['sort'],
        likesMin: likesMin as number,
        page: 1,
        mood: mood as ExolytSearchBody['mood'],
        dateStart: dateStart as string,
        dateEnd: dateEnd as string,
        regions: regions as string[],
        followers: followers as string,
        accountType: accountType as number
    }

    // hashtag 统一走后端 or 契约：or:[{type:'hashtag',id}]（实测后端按此识别；旧扁平 hashtags+searchMode 多值返回空）
    const hashtagList = (Array.isArray(hashtags) ? hashtags : []) as string[]
    if (hashtagList.length > 0) {
        body.or = hashtagList.map((id) => ({type: 'hashtag', id}))
    }

    return body
}

// 白名单校验（A5 规格表，后端名）：非法枚举/缺数组/格式错 → INVALID_PARAM，禁三元静默回落默认
export function validateSearchBody(body: ExolytSearchBody): void {
    if (!Array.isArray(body.regions)) invalid('regions 须为数组')
    if (body.or !== undefined) {
        if (!Array.isArray(body.or)) invalid('or 须为数组')
        for (const term of body.or) {
            if (!term || typeof term !== 'object' || term.type !== 'hashtag' || typeof term.id !== 'string' || !term.id) {
                invalid(`or 项须为 {type:'hashtag',id:<非空串>}，实得 ${JSON.stringify(term)}`)
            }
        }
    }

    if (typeof body.followers !== 'string' || !FOLLOWERS_RE.test(body.followers)) {
        invalid(`followers 须为 min_max 区间串（如 0_100000），实得 ${JSON.stringify(body.followers)}`)
    }

    if (typeof body.accountType !== 'number' || !(ACCOUNT_TYPE_WHITELIST as readonly number[]).includes(body.accountType)) {
        invalid(`accountType 不在白名单 ${JSON.stringify(ACCOUNT_TYPE_WHITELIST)}，实得 ${JSON.stringify(body.accountType)}`)
    }

    if (typeof body.sort !== 'string' || !(SORT_WHITELIST as readonly string[]).includes(body.sort)) {
        invalid(`sort 不在白名单 ${JSON.stringify(SORT_WHITELIST)}，实得 ${JSON.stringify(body.sort)}`)
    }

    // mood 允许 null（不限），非 null 时须在枚举白名单
    if (body.mood !== null && (typeof body.mood !== 'string' || !(MOOD_WHITELIST as readonly string[]).includes(body.mood))) {
        invalid(`mood 须为 null 或白名单 ${JSON.stringify(MOOD_WHITELIST)}，实得 ${JSON.stringify(body.mood)}`)
    }

    if (typeof body.likesMin !== 'number' || !Number.isFinite(body.likesMin)) {
        invalid(`likesMin 须为 number，实得 ${JSON.stringify(body.likesMin)}`)
    }

    if (typeof body.dateStart !== 'string' || !DATE_RE.test(body.dateStart)) {
        invalid(`dateStart 须为 YYYY-MM-DD，实得 ${JSON.stringify(body.dateStart)}`)
    }
    if (typeof body.dateEnd !== 'string' || !DATE_RE.test(body.dateEnd)) {
        invalid(`dateEnd 须为 YYYY-MM-DD，实得 ${JSON.stringify(body.dateEnd)}`)
    }
}

// 三入口统一收口：原始输入对象（URL 解析输出 / 条件表单逻辑层输入 / CLI KV）→ 校验通过的纯 JSON body
// 表单逻辑层（UI deferred）与 URL 解析走同一路径——皆经 ExolytRawSearchInput 进此函数
export function resolveSearchBody(input: ExolytRawSearchInput): ExolytSearchBody {
    const body = buildSearchBody(input)
    validateSearchBody(body)
    return body
}
