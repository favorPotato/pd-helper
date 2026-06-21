import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join, resolve} from 'node:path'
import {rawPath} from './video-lib.mjs'
import {exitFor} from './codes.mjs'

// INDEX 独立生成（Epic 3 / FR-12·FR-13 / SM-4 / OQ-4）
// 纯派生：只读 raws/* + 外部选品 JSON → 写 index/<YYYY-MM>.json，零状态文件、不回写 raw、不读 INDEX 自身。
// 客观字段两次重生成须一致（幂等）；topComments 稳定排序（点赞降序，并列按 commentId 升序）。
// 字段映射经 ~/Downloads/31402 真实 raw 逐条实测锁定（见各 derive 注释）。

// ── 贴纸占位清洗：复用既有规则（commit cf605a7，src/platforms/tiktok/collector.ts:289-297）──
// [贴纸] 为占位符：清成空格交空白折叠处理，纯贴纸清洗后为空串、整条剔除。mjs 不能 import ts 源，故同款复刻。
const STICKER_PLACEHOLDER = /\[贴纸\]/g

function normalizeCommentText(value) {
    return String(value || '')
        .replace(STICKER_PLACEHOLDER, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function asObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
}

function trimStr(v) {
    return typeof v === 'string' ? v.trim() : ''
}

function toFiniteNumber(v) {
    const n = typeof v === 'string' ? Number(v) : v
    return typeof n === 'number' && Number.isFinite(n) ? n : null
}

// ISO 字符串 / unix 秒(字符串或数字) → 'YYYY-MM'；取不到返回 ''（调用方归 unknown 分桶）
function toYearMonth(value) {
    if (value === null || value === undefined || value === '') return ''
    let ms = null
    const asNum = toFiniteNumber(value)
    if (asNum !== null && (typeof value === 'number' || /^\d+$/.test(String(value)))) {
        ms = asNum < 1e12 ? asNum * 1000 : asNum   // <1e12 视为秒级
    } else if (typeof value === 'string') {
        const t = Date.parse(value)
        if (Number.isFinite(t)) ms = t
    }
    if (ms === null) return ''
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return ''
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// ── 客观字段派生（来源经实测锁定）──

// desc：主 tk `desc` → 兜底 exolyt `title`（exolyt 无 desc，标题文本在 title）
function deriveDesc(ex, tk) {
    return trimStr(tk?.desc) || trimStr(ex?.title)
}

// username：主 tk `author.uniqueId` → 兜底 exolyt `user.uniqueId`
function deriveUsername(ex, tk) {
    return trimStr(asObject(tk?.author)?.uniqueId) || trimStr(asObject(ex?.user)?.uniqueId)
}

// videoDuration(ms)：主 exolyt `duration`（已是 ms）→ 兜底 tk `video.duration`（秒，×1000）
function deriveDurationMs(ex, tk) {
    const exMs = toFiniteNumber(ex?.duration)
    if (exMs !== null) return exMs
    const sec = toFiniteNumber(asObject(tk?.video)?.duration)
    return sec !== null ? sec * 1000 : null
}

// hashtags：主 exolyt `hashtags[].name` → 兜底 tk `textExtra[].hashtagName` / `challenges[].title`；去重剥 #
function deriveHashtags(ex, tk) {
    const out = []
    const seen = new Set()
    const push = (raw) => {
        const tag = String(raw || '').replace(/^#+/, '').trim()
        if (!tag) return
        const key = tag.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        out.push(tag)
    }
    const exTags = Array.isArray(ex?.hashtags) ? ex.hashtags : []
    for (const h of exTags) push(asObject(h)?.name)
    if (out.length) return out
    const te = Array.isArray(tk?.textExtra) ? tk.textExtra : []
    for (const e of te) push(asObject(e)?.hashtagName)
    const ch = Array.isArray(tk?.challenges) ? tk.challenges : []
    for (const e of ch) push(asObject(e)?.title)
    return out
}

// 发布月份：主 tk `createTime`（unix 秒字符串，权威发布时间）→ 兜底 exolyt `uploadDate`（ISO）
function derivePublishYearMonth(ex, tk) {
    // createTime 为 0/'0'（缺值占位）时按 unix 秒会落 1970-01 错桶，故仅正有效值才解析，否则兜底 exolyt
    const tkSec = toFiniteNumber(tk?.createTime)
    const fromTk = tkSec !== null && tkSec > 0 ? toYearMonth(tk.createTime) : ''
    if (fromTk) return fromTk
    return toYearMonth(ex?.uploadDate)
}

// topComments：tk `comments[]`（exolyt comments 仅整数计数，无文本）。
// 点赞前 10：diggCount 降序、并列按 commentId 升序二级排序（保幂等）；贴纸清洗后判空剔除。
function deriveTopComments(tk) {
    const list = Array.isArray(tk?.comments) ? tk.comments : null
    if (!list) return []
    const rows = []
    for (const c of list) {
        const o = asObject(c)
        if (!o) continue
        const text = normalizeCommentText(o.text)
        if (!text) continue   // 纯贴纸/空白剔除（同 shouldKeepComment 判空）
        const likes = toFiniteNumber(o.diggCount) ?? 0
        const cid = trimStr(o.commentId)
        rows.push({text, likes, cid})
    }
    rows.sort((a, b) => (b.likes - a.likes) || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0))
    return rows.slice(0, 10).map((r) => r.text)
}

// ── 状态列：据散文件存在性组合派生（不据枚举）──
const STATUS_FULL = 'full'                 // 三件套齐：exolyt raw + tiktok raw + video
const STATUS_EXOLYT_ONLY = 'exolyt_only'   // 仅 exolyt 已采（tk 段未采/失败）
const STATUS_PARTIAL = 'partial'           // 其他不齐组合（容错可辨）

const STATUS_LABEL = {
    [STATUS_FULL]: '三件套齐',
    [STATUS_EXOLYT_ONLY]: '仅exolyt已采(tk段未采/失败)',
    [STATUS_PARTIAL]: '部分缺失'
}

function deriveStatus(presence) {
    const {exolyt, tiktok, video} = presence
    if (exolyt && tiktok && video) return STATUS_FULL
    if (exolyt && !tiktok && !video) return STATUS_EXOLYT_ONLY
    return STATUS_PARTIAL
}

// 视频库根定位：与 collect 同约定（--root 优先，否则 --seq → ~/Downloads/<seq>，否则 env/默认）
function resolveLibRoot(args) {
    const seq = args.flags.seq ? String(args.flags.seq) : ''
    if (args.flags.root) return resolve(args.flags.root)
    if (seq) return resolve(homedir(), 'Downloads', seq)
    return resolve(process.env.PD_HELPER_VIDEO_ROOT || './video-lib')
}

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
        return null
    }
}

// 一次性预扫三个目录构建查表集（F9：避免主循环内每条重扫目录 / 多次 existsSync）。
//  - exolytRawIds / tiktokRawIds：raws/<platform>/ 下 <id>.json 的 id 集（去 .json）
//  - videoMatch(id)：等价于 video-lib 的 videoExists 语义（文件名 === id 或以 `${id}.` 开头），
//    用预扫的 videos 目录文件名集在本文件内 O(1) 判定（exact 全名集 + 各文件名的点号前缀集）。
function scanLibDirs(libRoot) {
    const readNamesJson = (dir) => {
        const ids = new Set()
        if (!existsSync(dir)) return ids
        for (const name of readdirSync(dir)) {
            if (name.endsWith('.json')) ids.add(name.slice(0, -5))
        }
        return ids
    }
    const exolytRawIds = readNamesJson(join(libRoot, 'raws', 'exolyt'))
    const tiktokRawIds = readNamesJson(join(libRoot, 'raws', 'tiktok'))

    // videos 目录：全名集 + 每个文件名的所有「点号前缀」集（覆盖 `${id}.` 前缀匹配，且 id 自身可含点）
    const videoExact = new Set()
    const videoDotPrefix = new Set()
    const videosDir = join(libRoot, 'videos')
    if (existsSync(videosDir)) {
        for (const name of readdirSync(videosDir)) {
            videoExact.add(name)
            let dot = name.indexOf('.')
            while (dot !== -1) {
                videoDotPrefix.add(name.slice(0, dot))
                dot = name.indexOf('.', dot + 1)
            }
        }
    }
    const videoMatch = (id) => videoExact.has(id) || videoDotPrefix.has(id)

    return {exolytRawIds, tiktokRawIds, videoMatch}
}

// 列举两平台 raws 目录里的全部 videoId（并集），不据任何枚举/状态文件。
// 复用预扫得到的 raw id 集，避免重复 readdir（F9）。
function listVideoIds(exolytRawIds, tiktokRawIds) {
    return [...new Set([...exolytRawIds, ...tiktokRawIds])].sort()
}

// 外部选品旁路 JSON：{[videoId]:{viralType,category}}；缺失/非法不阻断（返回空映射）
function loadSelect(selectPath) {
    if (!selectPath) return {}
    return asObject(readJson(resolve(selectPath))) || {}
}

export function cmdIndex(args) {
    const libRoot = resolveLibRoot(args)
    if (!existsSync(libRoot)) {
        console.error(`index: 视频库根不存在: ${libRoot}`)
        return exitFor('INVALID_PARAM')
    }
    const select = loadSelect(args.flags.select)

    const {exolytRawIds, tiktokRawIds, videoMatch} = scanLibDirs(libRoot)
    const videoIds = listVideoIds(exolytRawIds, tiktokRawIds)
    const buckets = new Map()   // 'YYYY-MM' | 'unknown' → entries[]

    let withExolyt = 0
    let full = 0
    let exolytOnly = 0
    let partial = 0

    for (const videoId of videoIds) {
        const exPath = rawPath(libRoot, 'exolyt', videoId)
        const tkPath = rawPath(libRoot, 'tiktok', videoId)
        const presence = {
            exolyt: exolytRawIds.has(videoId),
            tiktok: tiktokRawIds.has(videoId),
            video: videoMatch(videoId)
        }
        // exolyt 落库为 {videoId, raw}（见 ExolytVideoDetail），派生字段实际在 raw 下，故下沉一层取 raw
        const exDoc = presence.exolyt ? asObject(readJson(exPath)) : null
        const ex = asObject(exDoc?.raw)
        const tk = presence.tiktok ? asObject(readJson(tkPath)) : null

        if (presence.exolyt) withExolyt += 1
        const status = deriveStatus(presence)
        if (status === STATUS_FULL) full += 1
        else if (status === STATUS_EXOLYT_ONLY) exolytOnly += 1
        else partial += 1

        const sel = asObject(select[videoId]) || {}
        const entry = {
            videoId,
            username: deriveUsername(ex, tk),
            videoDuration: deriveDurationMs(ex, tk),
            desc: deriveDesc(ex, tk),
            hashtags: deriveHashtags(ex, tk),
            topComments: deriveTopComments(tk),
            status,
            statusLabel: STATUS_LABEL[status],
            presence,
            // 外部选品并入（OQ-4）：按 videoId join，缺失留 null 不阻断
            viralType: sel.viralType ?? null,
            category: sel.category ?? null
        }

        const ym = derivePublishYearMonth(ex, tk) || 'unknown'
        if (!buckets.has(ym)) buckets.set(ym, [])
        buckets.get(ym).push(entry)
    }

    const indexDir = join(libRoot, 'index')
    mkdirSync(indexDir, {recursive: true})
    const written = []
    for (const [ym, entries] of [...buckets.entries()].sort()) {
        entries.sort((a, b) => (a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0))
        const outPath = join(indexDir, `${ym}.json`)
        writeFileSync(outPath, JSON.stringify(entries, null, 2) + '\n')
        written.push({month: ym, count: entries.length, path: outPath})
    }

    process.stdout.write(JSON.stringify({
        ok: true,
        root: libRoot,
        videos: videoIds.length,
        months: written,
        status: {full, exolytOnly, partial, withExolyt},
        selectApplied: Object.keys(select).length
    }, null, 2) + '\n')
    return 0
}
