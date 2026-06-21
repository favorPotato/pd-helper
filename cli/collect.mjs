import {resolve} from 'node:path'
import {homedir} from 'node:os'
import {CdpError} from './transport.mjs'
import {emit, emitSynthetic, ttyLog, numFlag} from './io.mjs'
import {exitFor} from './codes.mjs'
import {runCallAndCollect} from './loop.mjs'
import {ensureVideoLibDirs, scanVideoIdSet, writeRawJson, moveVideoIntoLib, listRawVideoIds} from './video-lib.mjs'

// 透传给 exolytSearch 的筛选字段（url 走 --url，其余走 --param）
const FILTER_KEYS = ['sort', 'likesMin', 'mood', 'dateStart', 'dateEnd', 'regions', 'hashtags', 'followers', 'accountType']

// 两平台 videoId 字段名不同：exolyt detail.videoId / tk itemStruct.id，分别取
function exolytVideoId(detail) {
    return detail && typeof detail.videoId === 'string' ? detail.videoId : ''
}

function tkVideoId(itemStruct) {
    return itemStruct && typeof itemStruct.id === 'string' ? itemStruct.id : ''
}

// 视频库根 = 浏览器默认下载目录（BitBrowser 约定 ~/Downloads/<seq>）
function resolveCtx(args) {
    const seq = args.flags.seq ? String(args.flags.seq) : ''
    const libRoot = args.flags.root
        ? resolve(args.flags.root)
        : seq
            ? resolve(homedir(), 'Downloads', seq)
            : resolve(process.env.PD_HELPER_VIDEO_ROOT || './video-lib')
    return {
        libRoot,
        downloadDir: libRoot,  // 下载目录 = 视频库根，视频先平铺落此再 mv 进 videos/
        timeoutMs: numFlag(args.flags.timeout, 3600, 1) * 1000,
        pollIntervalMs: numFlag(args.flags['poll-interval'], 2000, 1),
        statusIntervalMs: numFlag(args.flags['status-interval'], 30000, 1)
    }
}

// 返回 null 表示既无 url 也无任何筛选字段（调用方据此报 INVALID_PARAM）
function collectSearchParams(args) {
    const searchParams = {}
    if (args.flags.url) searchParams.url = args.flags.url
    for (const k of FILTER_KEYS) {
        if (args.params[k] !== undefined) searchParams[k] = args.params[k]
    }
    if (!searchParams.url && Object.keys(searchParams).length === 0) return null
    return searchParams
}

// 对一批 videoId 串行单采。视频经 anchor 下载平铺落 downloadDir，下载完 mv 进 videos/；
// 写回远程去重表口径统一在「下载后」。返回统计 + captchaAborted（整批因连续验证码中止）。
async function runTkPhase(session, ctx, videoIds) {
    const {libRoot, downloadDir, timeoutMs, pollIntervalMs, statusIntervalMs} = ctx
    // 入口预扫 videos/ 一次得已存在 id 集，循环内用 existing.has(id) 替代逐条全目录扫描。
    // 每成功归位一条后用同款规则把落盘文件名增量并入，保持与预扫语义一致。
    const existing = scanVideoIdSet(libRoot)
    const addToExisting = (fileName) => {
        existing.add(fileName)
        let dot = fileName.indexOf('.')
        while (dot !== -1) {
            existing.add(fileName.slice(0, dot))
            dot = fileName.indexOf('.', dot + 1)
        }
    }
    let tkOk = 0
    let tkSkippedVideo = 0
    let videoMoved = 0
    let videoMissing = 0
    const uncollectable = []  // 采不动清单：GONE/AUTH_WALL/失败逐条记录，不中断整批
    // 连续验证码计数：仅成功清零、仅 CAPTCHA 累加，其余错误中性（不加不清）；
    // 连续 3 次判定环境被风控、整批终止。
    let captchaStreak = 0
    let captchaAborted = false
    // 逐条采集循环不变量（与 CS 端 onPackVideo 共同契约，改一处须同步另一处）：
    // ① 去重表写回一律 best-effort：产物落地后才写，写回抛错只记日志、绝不把已成功条目打回失败。
    // ② 终态剔除：被双门剔除/GONE/AUTH_WALL 的条目必须移出候选，不得留在待采集合致重跑重采。
    // ③ 连续验证码 ≥3 整批终止。
    // ④ 单条失败绝不中止整批（逐条 try/catch 继续下一条），除非触发 ③。
    for (const id of videoIds) {
        if (existing.has(id)) {
            tkSkippedVideo += 1
            // 本地视频已存在跳过下载，但远程去重表可能因首跑写回失败而缺这条，
            // 故补一次写回使其最终一致（幂等）；仍 best-effort，失败不阻断续采。
            try {
                await runCallAndCollect(session, {
                    method: 'exolytMarkCollected',
                    params: {videoId: id},
                    timeoutMs, pollIntervalMs, statusIntervalMs
                })
            } catch (e) {
                ttyLog(`[pd-helper-cli] dedup mark-collected write-back failed ${id} (video already exists, best-effort): ${e instanceof Error ? e.message : String(e)}`)
            }
            captchaStreak = 0  // 本地命中证明前序环境活着，清零
            continue
        }
        // videos/ 无此 id，但上轮可能已下载完成、仅因 moveVideoIntoLib 超时滞留在 downloadDir 根目录。
        // 重下前先抢救一次（timeoutMs:0 = 纯单次扫描归位，不等待下载），命中即视同已存在，
        // 不再重新下载，杜绝「超时→重跑重下 + 留孤儿」。
        const rescue = await moveVideoIntoLib(downloadDir, libRoot, id, {timeoutMs: 0})
        if (rescue.moved) {
            tkSkippedVideo += 1
            videoMoved += 1
            addToExisting(rescue.name)
            ttyLog(`[pd-helper-cli] rescued downloaded-but-unmoved video ${id} (stranded in root after last run's download timeout), skip re-download`)
            try {
                await runCallAndCollect(session, {
                    method: 'exolytMarkCollected',
                    params: {videoId: id},
                    timeoutMs, pollIntervalMs, statusIntervalMs
                })
            } catch (e) {
                ttyLog(`[pd-helper-cli] dedup mark-collected write-back failed ${id} (rescued move, best-effort): ${e instanceof Error ? e.message : String(e)}`)
            }
            captchaStreak = 0
            continue
        }
        try {
            const itemStruct = await runCallAndCollect(session, {
                method: 'tkFetchVideo',
                params: {videoId: id},
                timeoutMs, pollIntervalMs, statusIntervalMs
            })
            const tid = tkVideoId(itemStruct) || id
            writeRawJson(libRoot, 'tiktok', tid, itemStruct)
            tkOk += 1
            captchaStreak = 0  // 成功=环境活着，清零
            // 视频下载落 downloadDir 平铺，等下完 mv 归位到 videos/（best-effort，不阻断 raw）
            const mv = await moveVideoIntoLib(downloadDir, libRoot, tid)
            if (mv.moved) {
                videoMoved += 1
                addToExisting(mv.name)
                // 视频下载完成后才把 videoId 写回远程去重表（与 CS 端口径一致）。
                // best-effort：写回失败不丢已落视频，仅记日志（本地存在性仍可在重跑时跳过）
                try {
                    await runCallAndCollect(session, {
                        method: 'exolytMarkCollected',
                        params: {videoId: tid},
                        timeoutMs, pollIntervalMs, statusIntervalMs
                    })
                } catch (e) {
                    ttyLog(`[pd-helper-cli] dedup mark-collected write-back failed ${tid} (video landed, best-effort): ${e instanceof Error ? e.message : String(e)}`)
                }
            } else { videoMissing += 1; ttyLog(`[pd-helper-cli] video not landed/timed out ${tid} (raw saved, best-effort)`) }
        } catch (e) {
            const code = e instanceof CdpError ? e.code : 'UNKNOWN_ERROR'
            uncollectable.push({videoId: id, code, message: e instanceof Error ? e.message : String(e)})
            ttyLog(`[pd-helper-cli] tk uncollectable ${id}: [${code}] ${e instanceof Error ? e.message : String(e)}`)
            // 仅 CAPTCHA 累加；其他错误中性（不动计数），当条已记 uncollectable 继续下一条
            if (code === 'CAPTCHA') {
                captchaStreak += 1
                if (captchaStreak >= 3) {
                    captchaAborted = true
                    ttyLog('[pd-helper-cli] 3 consecutive captchas, environment likely rate-limited, aborting whole batch; all landed files are kept')
                    break
                }
            }
        }
    }
    if (captchaAborted) {
        emitSynthetic('', 'error', {
            phase: 'tk', code: 'CAPTCHA',
            message: '3 consecutive captchas, environment likely rate-limited, whole batch aborted; switch IP / environment or retry later. All landed files are kept'
        })
    }
    return {tkOk, tkSkippedVideo, videoMoved, videoMissing, uncollectable, captchaAborted}
}

// 调 exolytSearch（只搜、累积进浏览器内存池）。带 --detail 时搜完自动接 cmdDetail 收口。
export async function cmdSearch(session, args) {
    const ctx = resolveCtx(args)
    const searchParams = collectSearchParams(args)
    if (!searchParams) {
        console.error('search: provide --url <frontend filter URL> or at least one filter field (--param sort=... etc.)')
        return exitFor('INVALID_PARAM')
    }

    ensureVideoLibDirs(ctx.libRoot)

    let res
    try {
        res = await runCallAndCollect(session, {
            method: 'exolytSearch',
            params: searchParams,
            timeoutMs: ctx.timeoutMs, pollIntervalMs: ctx.pollIntervalMs, statusIntervalMs: ctx.statusIntervalMs
        })
    } catch (e) {
        const code = e instanceof CdpError ? e.code : 'UNKNOWN_ERROR'
        emitSynthetic('', 'error', {phase: 'exolyt', code, message: e instanceof Error ? e.message : String(e)})
        return exitFor(code)
    }
    const added = Number(res && res.added) || 0
    const total = Number(res && res.total) || 0
    ttyLog(`[pd-helper-cli] exolyt search added ${added} this run, searched ${total} total so far`)
    emit({v: 1, type: 'summary', taskId: '', seq: -1, ts: Date.now(), data: {phase: 'search', added, total, root: ctx.libRoot}})

    if (args.flags.detail) return await cmdDetail(session, args)
    return 0
}

// 对浏览器内存累积池收口：流式 detail 落盘（每过门一条立即写 raws/exolyt/）+ tk 段。
export async function cmdDetail(session, args) {
    const ctx = resolveCtx(args)
    ensureVideoLibDirs(ctx.libRoot)

    const videoIds = []
    let exolytWritten = 0
    let exolytSkipped = 0
    // 流式：每收到一帧 {kind:'exolytDetail',detail} 立即落盘并收集 videoId（边采边落）
    const onProgress = (data) => {
        if (!data || data.kind !== 'exolytDetail' || !data.detail) return
        const detail = data.detail
        const id = exolytVideoId(detail)
        if (!id) return
        videoIds.push(id)
        const r = writeRawJson(ctx.libRoot, 'exolyt', id, detail)
        if (r.written) exolytWritten += 1
        else exolytSkipped += 1
    }

    // 续采基准：node 端已落盘的 exolyt raw 即「已完成」事实，透传给 CS 把这些条目剔出待采池，
    // 既不丢未落盘条目，又省掉对已落盘条目的 fetchDetail。
    const have = listRawVideoIds(ctx.libRoot, 'exolyt')
    if (have.length) ttyLog(`[pd-helper-cli] exolyt detail resume baseline: ${have.length} already saved, will skip fetchDetail`)

    let result
    try {
        result = await runCallAndCollect(session, {
            method: 'exolytDetail',
            params: {have},
            timeoutMs: ctx.timeoutMs, pollIntervalMs: ctx.pollIntervalMs, statusIntervalMs: ctx.statusIntervalMs,
            onProgress
        })
    } catch (e) {
        const code = e instanceof CdpError ? e.code : 'UNKNOWN_ERROR'
        emitSynthetic('', 'error', {phase: 'exolyt', code, message: e instanceof Error ? e.message : String(e)})
        return exitFor(code)
    }
    // aborted=true：detail 段熔断/限流中止，任务仍 success，已流式落盘的帧有效，不抛、仅日志说明。
    const detailAborted = !!(result && result.aborted)
    if (detailAborted) {
        ttyLog(`[pd-helper-cli] exolyt detail phase aborted (${(result && result.reason) || 'reason unknown'}); all landed files are kept`)
    }
    ttyLog(`[pd-helper-cli] exolyt detail saved written=${exolytWritten} skipped=${exolytSkipped} of ${videoIds.length} total`)

    const tk = await runTkPhase(session, ctx, videoIds)

    emit({
        v: 1, type: 'summary', taskId: '', seq: -1, ts: Date.now(),
        data: {
            phase: 'detail',
            searched: videoIds.length,
            exolyt: {written: exolytWritten, skipped: exolytSkipped, total: exolytWritten + exolytSkipped, aborted: detailAborted},
            tk: {ok: tk.tkOk, skippedExisting: tk.tkSkippedVideo},
            video: {moved: tk.videoMoved, missing: tk.videoMissing},
            uncollectable: tk.uncollectable,
            uncollectableCount: tk.uncollectable.length,
            captchaAborted: tk.captchaAborted,
            root: ctx.libRoot
        }
    })
    // 因连续验证码中止：以 CAPTCHA 码退出，提示操作者换 IP / 换环境 / 稍后重试
    if (tk.captchaAborted) return exitFor('CAPTCHA')
    return 0
}
