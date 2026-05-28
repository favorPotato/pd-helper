// CLI 共用工具
// 注意：CLI 是独立顶层目录，不与扩展端共享 import；这里复刻 shared/timing.ts:delay 的最小实现

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// 解析 string flag 到数值，空/无效时返回 fallback；用于替代 `Number(x) || default` 的 falsy-zero 陷阱
export function numFlag(value: string | undefined, fallback: number): number {
    if (value === undefined || value === '') return fallback
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
}
