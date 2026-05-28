// CLI 独立目录不共享扩展端 import，此处复刻 shared/timing.ts:delay 的最小实现

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// 避免 `Number(x) || default` 的 falsy-zero 陷阱（0 是合法值）
export function numFlag(value: string | undefined, fallback: number): number {
    if (value === undefined || value === '') return fallback
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
}
