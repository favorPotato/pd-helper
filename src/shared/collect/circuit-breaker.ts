// 通用错误熔断（漏桶模型）。被 collector.detailPhase 的并发池（默认 5 worker）共享调用，
// recordOk/recordErr 跨 worker 交错——严格「连续 N 错」语义在并发下不成立：后端局部退化
// （部分 429、部分成功）时偶尔的成功就会把「连续」清零→永不熔断、持续猛打被限流后端（违反 NFR-1）。
// 故改漏桶：recordErr 计数 +1、recordOk 计数 max(0, -1)（封顶 0，不清零）；count>=maxConsecutive 时
// recordErr 抛出原 error 熔断。即错误「多于」成功才触发——孤立瞬时错被后续成功抵消不误熔断、
// 持续高错误率累积触发。透传原 error（已带 [CODE]），熔断本身不新增码。
// 参考 nox paginator 的 >=3 阈值；nox 不引用本模块（其熔断为内联计数，FR-15 不动）

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
                // 保留 1.2 已归一的码（末次错的 [CODE]/pdCode）：限流→RATE_LIMITED、会话失效→LOGIN_REQUIRED、余者保留原码
                // 直接 throw 原 error 而非重包装——避免裸 throw 丢码退化 UNKNOWN_ERROR（决策点 8）
                throw error
            }
        },
        consecutive() {
            return count
        }
    }
}
