export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function sleepRandom(minMs: number, maxMs: number): Promise<void> {
    const lower = Math.max(0, Math.min(minMs, maxMs))
    const upper = Math.max(lower, Math.max(minMs, maxMs))
    const durationMs = Math.floor(Math.random() * (upper - lower + 1)) + lower
    await delay(durationMs)
}
