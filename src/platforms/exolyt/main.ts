import {runFireAndForget, withPdCode} from '../../shared/cli-bridge/cs-runtime'
import {EXOLYT_SEARCH_COLLECT_REMOTE} from '../../shared/remote-collect'
import {collectExolyt} from './collector'
import type {ExolytRawSearchInput} from './types'

// import 红线（NFR-4/AC4）：仅 cs-runtime + remote-collect 常量 + 同目录模块
// 严禁 facade/persistence/business-dispatchers（含 chrome.tabs/storage.session）——进 CS 即崩

declare const window: Window & {
    __EXOLYT_HANDLER_LOADED__?: boolean
}

// 异常是否已带 pdCode（withPdCode 挂在 error.pdCode）——已带则不被 main 兜底码覆盖，保 collector 的 INVALID_PARAM 上行
function hasPdCode(error: Error): boolean {
    return typeof (error as Error & {pdCode?: unknown}).pdCode === 'string'
}

function initExolytMessageHandler(): void {
    if (window.__EXOLYT_HANDLER_LOADED__) return
    window.__EXOLYT_HANDLER_LOADED__ = true

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return

        if (msg.type === EXOLYT_SEARCH_COLLECT_REMOTE) {
            const taskId = typeof msg.taskId === 'string' && msg.taskId.length ? msg.taskId : ''
            if (!taskId) {
                sendResponse({ok: false, error: 'taskId required'})
                return true
            }

            // ack 协议：同步 ack → return true → 进度/结果全程经 runFireAndForget 上行，绝不在 ack 回业务结果
            sendResponse({ok: true, accepted: true})

            // dispatcher 透传两路径：rawUrl（粘前端筛选 URL，优先）或 input（9 字段 KV，条件表单/CLI）
            const rawUrl = typeof msg.rawUrl === 'string' && msg.rawUrl.length ? msg.rawUrl : undefined
            const input = msg.input && typeof msg.input === 'object' ? msg.input as ExolytRawSearchInput : undefined

            void runFireAndForget(taskId, async (rt) => {
                rt.throwIfCancelled()
                // 校验/组装在 collector → search-params（CS 就近），非法值已带 [INVALID_PARAM] pdCode
                try {
                    return await collectExolyt({rawUrl, input}, rt)
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error))
                    // 仅在异常未带 pdCode 时兜底 UNKNOWN_ERROR——不覆盖 collector 已打的 INVALID_PARAM 等码
                    return Promise.reject(hasPdCode(err) ? err : withPdCode(err, 'UNKNOWN_ERROR'))
                }
            })
            return true
        }
    })
}

export function setup(): void {
    initExolytMessageHandler()
}
