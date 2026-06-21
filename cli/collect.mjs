import {resolve} from 'node:path'
import {homedir} from 'node:os'
import {callPd} from './rpc.mjs'
import {CdpError} from './transport.mjs'
import {reconnectSession} from './attach.mjs'
import {emit, emitSynthetic, ttyLog, sleep, numFlag} from './io.mjs'
import {exitFor} from './codes.mjs'
import {ensureVideoLibDirs, videoExists, writeRawJson, moveVideoIntoLib} from './lib/video-lib.mjs'

// 透传给 exolytSearchCollect 的筛选字段（url 走 --url，9 字段走 --param）
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
                // done 但 tail 未携 result 帧（buffer 溢出）：无业务数据可取
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

export async function cmdCollect(session, args) {
    // 视频库根 = 浏览器默认下载目录（BitBrowser 约定 ~/Downloads/<seq>）；视频天然落此、raws 也写此
    const seq = args.flags.seq ? String(args.flags.seq) : ''
    const libRoot = args.flags.root
        ? resolve(args.flags.root)
        : seq
            ? resolve(homedir(), 'Downloads', seq)
            : resolve(process.env.PD_HELPER_VIDEO_ROOT || './video-lib')
    const downloadDir = libRoot  // 下载目录 = 视频库根，视频先平铺落此再 mv 进 videos/
    const timeoutMs = numFlag(args.flags.timeout, 3600, 1) * 1000
    const pollIntervalMs = numFlag(args.flags['poll-interval'], 2000, 1)
    const statusIntervalMs = numFlag(args.flags['status-interval'], 30000, 1)

    // 筛选条件：--url 透传前端筛选 URL；9 字段走 --param k=v（params 已 autoCoerce）
    const searchParams = {}
    if (args.flags.url) searchParams.url = args.flags.url
    for (const k of FILTER_KEYS) {
        if (args.params[k] !== undefined) searchParams[k] = args.params[k]
    }
    if (!searchParams.url && Object.keys(searchParams).length === 0) {
        console.error('collect: 需提供 --url <前端筛选URL> 或至少一个筛选字段（--param sort=... 等）')
        return exitFor('INVALID_PARAM')
    }

    ensureVideoLibDirs(libRoot)

    // ── 第一段 exolyt：整批检索 + detail，落 raws/exolyt/ ──
    let details
    try {
        details = await runCallAndCollect(session, {
            method: 'exolytSearchCollect',
            params: searchParams,
            timeoutMs, pollIntervalMs, statusIntervalMs
        })
    } catch (e) {
        const code = e instanceof CdpError ? e.code : 'UNKNOWN_ERROR'
        emitSynthetic('', 'error', {phase: 'exolyt', code, message: e instanceof Error ? e.message : String(e)})
        return exitFor(code)
    }
    if (!Array.isArray(details)) {
        emitSynthetic('', 'error', {phase: 'exolyt', code: 'UNKNOWN_ERROR', message: 'exolyt 返回非数组结果'})
        return exitFor('UNKNOWN_ERROR')
    }

    const videoIds = []
    let exolytWritten = 0
    let exolytSkipped = 0
    for (const detail of details) {
        const id = exolytVideoId(detail)
        if (!id) continue
        videoIds.push(id)
        const r = writeRawJson(libRoot, 'exolyt', id, detail)
        if (r.written) exolytWritten += 1
        else exolytSkipped += 1
    }
    ttyLog(`[pd-helper-cli] exolyt 落盘 written=${exolytWritten} skipped=${exolytSkipped} 共 ${videoIds.length} 条`)

    // ── 第二段 tk：串行单采；视频经 anchor 下载平铺落 downloadDir，等下载完 mv 进 videos/ ──
    let tkOk = 0
    let tkSkippedVideo = 0
    let videoMoved = 0
    let videoMissing = 0
    const uncollectable = []  // 采不动清单：GONE/AUTH_WALL/失败逐条记录，不中断整批
    for (const id of videoIds) {
        if (videoExists(libRoot, id)) {
            tkSkippedVideo += 1
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
            // 视频下载落 downloadDir 平铺，等下完 mv 归位到 videos/（best-effort，不阻断 raw）
            const mv = await moveVideoIntoLib(downloadDir, libRoot, tid)
            if (mv.moved) videoMoved += 1
            else { videoMissing += 1; ttyLog(`[pd-helper-cli] 视频未落盘/超时 ${tid}（raw 已存，best-effort）`) }
        } catch (e) {
            const code = e instanceof CdpError ? e.code : 'UNKNOWN_ERROR'
            uncollectable.push({videoId: id, code, message: e instanceof Error ? e.message : String(e)})
            ttyLog(`[pd-helper-cli] tk 采不动 ${id}: [${code}] ${e instanceof Error ? e.message : String(e)}`)
        }
    }

    // ── 接缝⑦ summary ──
    emit({
        v: 1, type: 'summary', taskId: '', seq: -1, ts: Date.now(),
        data: {
            searched: videoIds.length,
            exolyt: {written: exolytWritten, skipped: exolytSkipped, total: exolytWritten + exolytSkipped},
            tk: {ok: tkOk, skippedExisting: tkSkippedVideo},
            video: {moved: videoMoved, missing: videoMissing},
            uncollectable,
            uncollectableCount: uncollectable.length,
            root: libRoot
        }
    })
    return 0
}
