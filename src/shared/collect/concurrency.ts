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

// 固定大小并发池：concurrency 个 worker 并发从 items 队列取任务调 worker(item)，slot 完成即取下一个直至队列空
// 取每个 item 前 throwIfCancelled——已取消则抛 cancelled 不再起新任务（在途任务自然结束）
// worker 抛出 → 该错冒泡终止整池（熔断中止靠 worker 内 recordErr 在阈值抛出，错冒泡到此处停池）
// 已落数据由 worker 自身累加进外部数组——本池中止不清外部已采，调用方据返回数组保留已采（AC3 ④）
export async function runWithConcurrency<T>(
    items: readonly T[],
    worker: (item: T, index: number) => Promise<void>,
    concurrency: number,
    cancel?: CancelSignal
): Promise<void> {
    const total = items.length
    if (total === 0) return

    const width = Math.max(1, Math.min(concurrency, total))
    let next = 0

    async function runSlot(): Promise<void> {
        while (true) {
            cancel?.throwIfCancelled()
            const current = next
            if (current >= total) return
            next += 1
            await worker(items[current], current)
        }
    }

    // 任一 slot 抛错（取消/熔断中止）即 reject——其余在途任务结束后整体 reject，已采数据已落外部数组不丢
    await Promise.all(Array.from({length: width}, () => runSlot()))
}
