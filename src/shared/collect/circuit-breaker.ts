// 通用错误熔断（漏桶模型），供并发场景的并发池跨 worker 共享调用。
// 与 paginator 内联的顺序「连续 N 错」计数熔断语义不同：在并发下 recordOk/recordErr 跨 worker 交错，
// 严格「连续」语义不成立——后端局部退化（部分 429、部分成功）时偶尔的成功会把「连续」清零→永不熔断、
// 持续猛打被限流后端。故改漏桶：recordErr 计数 +1、recordOk 计数 max(0, -1)（封顶 0，不清零）；
// count>=maxConsecutive 时 recordErr 抛出原 error 熔断。即错误「多于」成功才触发——孤立瞬时错被后续成功
// 抵消不误熔断、持续高错误率累积触发。透传原 error（已带 [CODE]），熔断本身不新增码。

export interface CircuitBreaker {
    // 记一次成功：桶计数 -1（封顶 0，不清零）——错多于成功才会累积到阈值
    recordOk(): void
    // 记一次错：桶计数 +1；达 maxConsecutive 抛出「触发原因错误」中止——透传原 error（已带 [CODE]），熔断本身不新增码
    recordErr(error: unknown): void
    // 当前桶计数（漏桶水位）
    consecutive(): number
}

export function makeCircuitBreaker(maxConsecutive: number): CircuitBreaker {
    let count = 0
    return {
        recordOk() {
            count = Math.max(0, count - 1)
        },
        recordErr(error: unknown) {
            count += 1
            if (count >= maxConsecutive) {
                // 直接 throw 原 error 而非重包装——保留末次错已归一的码（[CODE]/pdCode），避免重包装丢码退化 UNKNOWN_ERROR
                throw error
            }
        },
        consecutive() {
            return count
        }
    }
}
