// 固定大小并发池 + 并发数夹紧（Story 1.7 自 exolyt concurrency.ts 平移上移，行为等价）
// 本模块为 exolyt 专用并发池——nox 博主采集为顺序翻页、不用本模块（FR-15）

// SM-C1 反风控：默认并发保守留余量、触发 exolyt 限流/封号比慢更糟，勿为提速调高
export const DEFAULT_CONCURRENCY = 5
// 上限为硬门——越界夹到 [1,15]，不得绕过提速
export const MAX_CONCURRENCY = 15

// 并发数越界夹紧（非 INVALID_PARAM 失败）：它是工具内部反风控参数、非业务筛选，操作者误传不应致整批失败
// >15→15（上限硬门）、<1 或非有限数→回落默认 5
export function clampConcurrency(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONCURRENCY
    const floored = Math.floor(value)
    if (floored < 1) return DEFAULT_CONCURRENCY
    if (floored > MAX_CONCURRENCY) return MAX_CONCURRENCY
    return floored
}

export interface CancelSignal {
    throwIfCancelled(): void
}

// 池中止结果：aborted=是否因 worker 抛错（熔断/取消）提前停；reason=触发中止的错误（供上层判定）。
// 可选返回，调用方拿到对象后只读字段；不感知 aborted 的现有调用方（解构 await 忽略返回值）照常工作。
export interface ConcurrencyResult {
    aborted: boolean
    reason?: unknown
}

// 固定大小并发池：concurrency 个 worker 并发从 items 队列取任务调 worker(item)，slot 完成即取下一个直至队列空
// 取每个 item 前查共享中止信号——已中止则停止取新 item 自然退出（不再发请求），其余 slot 一并感知收敛
// worker 抛出（熔断 recordErr 达阈值 / 取消）→ 置共享中止位、记 reason，不再 reject 整池：
//   其余 slot 见中止位后自然退出，池以「已完成结果」正常 resolve，回报 aborted+reason 供上层裁决
// 已落数据由 worker 自身累加进外部数组——本池中止不清外部已采，调用方据返回数组保留已采（AC3 ④）
export async function runWithConcurrency<T>(
    items: readonly T[],
    worker: (item: T, index: number) => Promise<void>,
    concurrency: number,
    cancel?: CancelSignal
): Promise<ConcurrencyResult> {
    const total = items.length
    if (total === 0) return {aborted: false}

    const width = Math.max(1, Math.min(concurrency, total))
    let next = 0
    // 共享中止信号：任一 slot 因 worker 抛错（或外部取消）置位，其余 slot 取新 item 前感知即退出
    let aborted = false
    let reason: unknown

    async function runSlot(): Promise<void> {
        while (true) {
            if (aborted) return
            try {
                cancel?.throwIfCancelled()
            } catch (error) {
                aborted = true
                reason = error
                return
            }
            const current = next
            if (current >= total) return
            next += 1
            try {
                await worker(items[current], current)
            } catch (error) {
                // worker 抛出 = 熔断阈值触发或不可恢复错：置共享中止位让全池收敛，已采数据已落外部数组不丢
                aborted = true
                reason = error
                return
            }
        }
    }

    await Promise.all(Array.from({length: width}, () => runSlot()))
    return {aborted, reason}
}
