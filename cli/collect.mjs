import {resolve} from 'node:path'
import {homedir} from 'node:os'
import {callPd} from './rpc.mjs'
import {CdpError} from './transport.mjs'
import {reconnectSession} from './attach.mjs'
import {emit, emitSynthetic, ttyLog, sleep, numFlag} from './io.mjs'
import {exitFor} from './codes.mjs'
import {ensureVideoLibDirs, videoExists, writeRawJson, moveVideoIntoLib, listRawVideoIds} from './video-lib.mjs'

// 透传给 exolytSearch 的筛选字段（url 走 --url，9 字段走 --param）
const FILTER_KEYS = ['sort', 'likesMin', 'mood', 'dateStart', 'dateEnd', 'regions', 'hashtags', 'followers', 'accountType']
const TERMINAL_STATUS = new Set(['done', 'cancelled', 'error', 'orphaned'])

// loop.mjs 的 runCall 收到 result 帧只 emit、不回值；本变体复用同一 tail 轮询骨架，
// 但 result 帧 return 业务结果给调用方落盘。result payload = {result: <CS 返回值>}（见 background.ts:418），
// 故 f.data.result 即业务数据；?? f.data 兜底防 payload 形态变动。
// error/cancelled/timeout 一律抛 CdpError，由调用方 try/catch 归类。
async function runCallAndCollect(session, opts) {
    const callRes = await callPd(session, 'call', [opts.method, opts.params])
    const taskId = callRes.taskId
    ttyLog(`[pd-helper-cli] started taskId=${taskId} tabId=${callRes.tabId ?? 'n/a'}`)

    let lastSeq = 0
    let lastStatusAt = 0
    const startedAt = Date.now()
    const pollIntervalMs = opts.pollIntervalMs || 2000
    const statusIntervalMs = opts.statusIntervalMs || 30000

    async function call(method, args) {
        try {
            return await callPd(session, method, args)
        } catch (e) {
            if (!(e instanceof CdpError)) throw e
            if (e.code !== 'CDP_DISCONNECTED') throw e
            await reconnectSession(session)
            const list = await callPd(session, 'listTasks', [{all: true}]).catch(() => [])
            if (!list.some(t => t.taskId === taskId)) {
                throw new CdpError('TASK_LOST', `task ${taskId} not found after reconnect`)
            }
            return await callPd(session, method, args)
        }
    }

    while (true) {
        if (Date.now() - startedAt > opts.timeoutMs) {
            try { await call('cancel', [taskId]) } catch { /* ignore */ }
            throw new CdpError('TIMEOUT', `exceeded ${opts.timeoutMs}ms`)
        }

        const tail = await call('tail', [taskId, lastSeq])

        for (const f of tail.logs) {
            if (f.type === 'result') return f.data.result ?? f.data
            if (f.type === 'cancelled') throw new CdpError('CANCELLED', `task ${taskId} cancelled`)
            if (f.type === 'error') {
                throw new CdpError(String(f.data.code || 'UNKNOWN_ERROR'), String(f.data.message || 'task error'))
            }
            // 流式进度帧回调（如 exolytDetail 边采边落）：仅 progress 帧、传了 onProgress 时触发；
            // 未传回调（tkFetchVideo/exolytMarkCollected 等）时行为零变化。
            if (opts.onProgress && f.type === 'progress' && f.data) opts.onProgress(f.data)
        }
        lastSeq = tail.nextSeq

        if (tail.hasMore) continue

        if (Date.now() - lastStatusAt > statusIntervalMs) {
            const status = await call('status', [taskId])
            if ('error' in status) throw new CdpError('TASK_LOST', String(status.error))
            if (TERMINAL_STATUS.has(status.status)) {
                if (status.status === 'cancelled') throw new CdpError('CANCELLED', `task ${taskId} cancelled`)
                if (status.status === 'error') throw new CdpError(status.errorCode || 'UNKNOWN_ERROR', 'task error')
                if (status.status === 'orphaned') throw new CdpError('TASK_LOST', 'task became orphaned')
                // done 但本轮 tail 未见 result 帧——多为「瞬时 done」竞态：CS 秒回（如候选 0 返 {detailed:0}），
                // node 在 tail 取到 result 帧前就轮到 status 检查（首轮 lastStatusAt=0 尤甚）。SW 侧 finalizeTask
                // 把 result 帧与 done 态同步入 buffer（facade finalizeTask），故 done 后补一次 tail 必能取到迟到 result。
                // 仍取不到才是真 buffer 溢出无 result，抛 TASK_LOST。
                const finalTail = await call('tail', [taskId, lastSeq])
                for (const f of finalTail.logs) {
                    if (f.type === 'result') return f.data.result ?? f.data
                    if (f.type === 'cancelled') throw new CdpError('CANCELLED', `task ${taskId} cancelled`)
                    if (f.type === 'error') {
                        throw new CdpError(String(f.data.code || 'UNKNOWN_ERROR'), String(f.data.message || 'task error'))
                    }
                    if (opts.onProgress && f.type === 'progress' && f.data) opts.onProgress(f.data)
                }
                lastSeq = finalTail.nextSeq
                throw new CdpError('TASK_LOST', 'task done without result frame')
            }
            lastStatusAt = Date.now()
        }

        await sleep(pollIntervalMs)
    }
}

// CS 端 ExolytVideoDetail.videoId / tk itemStruct.id —— 两平台 videoId 字段名不同，分别取
function exolytVideoId(detail) {
    return detail && typeof detail.videoId === 'string' ? detail.videoId : ''
}

function tkVideoId(itemStruct) {
    return itemStruct && typeof itemStruct.id === 'string' ? itemStruct.id : ''
}

// 解析公共上下文：视频库根（= 浏览器默认下载目录，BitBrowser 约定 ~/Downloads/<seq>）+ 轮询参数。
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

// 收集筛选条件：--url 透传前端筛选 URL；9 字段走 --param k=v（params 已 autoCoerce）。
// 返回 null 表示既无 url 也无任何筛选字段（调用方据此报 INVALID_PARAM）。
function collectSearchParams(args) {
    const searchParams = {}
    if (args.flags.url) searchParams.url = args.flags.url
    for (const k of FILTER_KEYS) {
        if (args.params[k] !== undefined) searchParams[k] = args.params[k]
    }
    if (!searchParams.url && Object.keys(searchParams).length === 0) return null
    return searchParams
}

// ── tk 段：对一批 videoId 串行单采（含 V19 续采补写回 + E2-B 连续验证码整批终止）──
// 视频经 anchor 下载平铺落 downloadDir，等下载完 mv 进 videos/；写回远程去重表口径统一在「下载后」。
// 返回统计 + captchaAborted（整批因连续验证码中止）。
async function runTkPhase(session, ctx, videoIds) {
    const {libRoot, downloadDir, timeoutMs, pollIntervalMs, statusIntervalMs} = ctx
    let tkOk = 0
    let tkSkippedVideo = 0
    let videoMoved = 0
    let videoMissing = 0
    const uncollectable = []  // 采不动清单：GONE/AUTH_WALL/失败逐条记录，不中断整批
    // 连续验证码计数（作用域=本次采集）：仅「成功」清零、仅「CAPTCHA」累加；
    // GONE/登录墙/其他错误中性（不加不清）——连续 3 次验证码判定环境被风控、整批终止。
    let captchaStreak = 0
    let captchaAborted = false
    for (const id of videoIds) {
        if (videoExists(libRoot, id)) {
            tkSkippedVideo += 1
            // 续采漂移修复（V19）：本地视频已存在跳过下载，但远程去重表可能因首跑写回失败而缺这条，
            // 故此处补一次写回（入队、幂等），使去重表最终一致；写回仍 best-effort，失败不阻断续采。
            try {
                await runCallAndCollect(session, {
                    method: 'exolytMarkCollected',
                    params: {videoId: id},
                    timeoutMs, pollIntervalMs, statusIntervalMs
                })
            } catch (e) {
                ttyLog(`[pd-helper-cli] 远程去重补写回失败 ${id}（已存在视频，best-effort）: ${e instanceof Error ? e.message : String(e)}`)
            }
            captchaStreak = 0  // 已存在=本地成功命中，证明前序环境活着，清零
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
                // 口径：视频下载完成后才把 videoId 写回远程去重表格（与链路B 一致）。
                // best-effort——写回失败不丢已落视频，仅记日志（本地存在性仍可在重跑时跳过）
                try {
                    await runCallAndCollect(session, {
                        method: 'exolytMarkCollected',
                        params: {videoId: tid},
                        timeoutMs, pollIntervalMs, statusIntervalMs
                    })
                } catch (e) {
                    ttyLog(`[pd-helper-cli] 远程去重写回失败 ${tid}（视频已落，best-effort）: ${e instanceof Error ? e.message : String(e)}`)
                }
            } else { videoMissing += 1; ttyLog(`[pd-helper-cli] 视频未落盘/超时 ${tid}（raw 已存，best-effort）`) }
        } catch (e) {
            const code = e instanceof CdpError ? e.code : 'UNKNOWN_ERROR'
            uncollectable.push({videoId: id, code, message: e instanceof Error ? e.message : String(e)})
            ttyLog(`[pd-helper-cli] tk 采不动 ${id}: [${code}] ${e instanceof Error ? e.message : String(e)}`)
            // E2-B 连续验证码判定：仅 CAPTCHA 累加；GONE/登录墙/其他错误中性（不动计数），当条已记 uncollectable 继续下一条。
            if (code === 'CAPTCHA') {
                captchaStreak += 1
                if (captchaStreak >= 3) {
                    captchaAborted = true
                    ttyLog('[pd-helper-cli] 连续 3 次验证码，疑似环境被风控，整批终止；已落散文件全部保留')
                    break
                }
            }
        }
    }
    if (captchaAborted) {
        emitSynthetic('', 'error', {
            phase: 'tk', code: 'CAPTCHA',
            message: '连续 3 次验证码，疑似环境被风控，整批中止；请换 IP / 换环境或稍后重试。已落散文件全部保留'
        })
    }
    return {tkOk, tkSkippedVideo, videoMoved, videoMissing, uncollectable, captchaAborted}
}

// exolyt search 段：调 exolytSearch（只搜、累积进浏览器内存池），打印本次新增/累计。
// 带 --detail flag 时搜完自动接着跑 detail 收口（cmdDetail）。
export async function cmdSearch(session, args) {
    const ctx = resolveCtx(args)
    const searchParams = collectSearchParams(args)
    if (!searchParams) {
        console.error('search: 需提供 --url <前端筛选URL> 或至少一个筛选字段（--param sort=... 等）')
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
    ttyLog(`[pd-helper-cli] exolyt search 本次新增 ${added} 条，当前累计 searched ${total} 条`)
    emit({v: 1, type: 'summary', taskId: '', seq: -1, ts: Date.now(), data: {phase: 'search', added, total, root: ctx.libRoot}})

    // --detail：搜完自动接 detail 收口（落盘 + tk 段）
    if (args.flags.detail) return await cmdDetail(session, args)
    return 0
}

// exolyt detail 段：对浏览器内存累积池收口。
// = 流式 detail 落盘（每过门一条立即写 raws/exolyt/）+ tk 段（runTkPhase）。
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

    // 续采基准：node 端已落盘的 exolyt raw 即「已完成」事实，透传给 CS 把这些条目剔出待采池。
    // 既不丢未落盘条目（含 detail 被中断后 CS 续跑幽灵 markDetailed 的），又省掉对已落盘条目的 fetchDetail。
    const have = listRawVideoIds(ctx.libRoot, 'exolyt')
    if (have.length) ttyLog(`[pd-helper-cli] exolyt detail 续采基准：已落盘 ${have.length} 条将跳过 fetchDetail`)

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
    // aborted=true：exolyt detail 段熔断/限流中止，任务仍 success，已流式落盘的帧有效——不抛，仅日志说明。
    const detailAborted = !!(result && result.aborted)
    if (detailAborted) {
        ttyLog(`[pd-helper-cli] exolyt detail 段中止（${(result && result.reason) || '原因未知'}）；已落散文件全部保留`)
    }
    ttyLog(`[pd-helper-cli] exolyt detail 落盘 written=${exolytWritten} skipped=${exolytSkipped} 共 ${videoIds.length} 条`)

    // ── tk 段（含 V19 + E2-B captchaStreak 整批终止）──
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
