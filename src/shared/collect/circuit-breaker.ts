// 通用连续错熔断（Story 1.7 自 exolyt concurrency.ts 平移上移，行为等价）
// 连续语义：中间任一 recordOk 即重置；非累计。达 maxConsecutive 时 recordErr 透传原 error（已带 [CODE]，熔断本身不新增码）
// 参考 nox paginator 的 consecutiveErrors>=3 模式；nox 不引用本模块（其熔断为内联计数，FR-15 不动）

export interface CircuitBreaker {
    recordOk(): void
    // 记一次错并递增连续计数；达 maxConsecutive 抛出「触发原因错误」中止——透传原 error（已带 [CODE]），熔断本身不新增码
    recordErr(error: unknown): void
    consecutive(): number
}

export function makeCircuitBreaker(maxConsecutive: number): CircuitBreaker {
    let consecutive = 0
    return {
        recordOk() {
            consecutive = 0
        },
        recordErr(error: unknown) {
            consecutive += 1
            if (consecutive >= maxConsecutive) {
                // 保留 1.2 已归一的码（末次错的 [CODE]/pdCode）：限流→RATE_LIMITED、会话失效→LOGIN_REQUIRED、余者保留原码
                // 直接 throw 原 error 而非重包装——避免裸 throw 丢码退化 UNKNOWN_ERROR（决策点 8）
                throw error
            }
        },
        consecutive() {
            return consecutive
        }
    }
}
