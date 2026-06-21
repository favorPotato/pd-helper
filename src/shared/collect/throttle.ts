// 通用采集节奏/限流。
// 反风控：翻页越快越易触发限流/封号，节奏值为保守经验值，勿为提速调小
import {sleepRandom} from '../timing'

// 翻页节奏分级休眠（pageNum%longEvery / pageNum%midEvery / 否则 三档），默认值取 nox 现行经验值
// onProgress 在长休/中休前提示
export interface PageRhythmOptions {
    // 每多少页一次长休（默认 30）
    longEvery?: number
    // 每多少页一次中休（默认 10）
    midEvery?: number
    longRangeMs?: readonly [number, number]
    midRangeMs?: readonly [number, number]
    shortRangeMs?: readonly [number, number]
    longHint?: string
    midHint?: string
}

const DEFAULTS = {
    longEvery: 30,
    midEvery: 10,
    longRangeMs: [300_000, 600_000] as const,
    midRangeMs: [30_000, 60_000] as const,
    shortRangeMs: [1500, 3000] as const,
    longHint: '长休 5~10分钟...',
    midHint: '中休 30~60秒...'
}

// 翻页成功后按页号决定休眠档位：长休 > 中休 > 短休
// pageNum 取「即将请求的下一页号」（自增后取模）
export async function sleepForPage(pageNum: number, onProgress: (msg: string) => void, opts: PageRhythmOptions = {}): Promise<void> {
    const longEvery = opts.longEvery ?? DEFAULTS.longEvery
    const midEvery = opts.midEvery ?? DEFAULTS.midEvery
    const longRange = opts.longRangeMs ?? DEFAULTS.longRangeMs
    const midRange = opts.midRangeMs ?? DEFAULTS.midRangeMs
    const shortRange = opts.shortRangeMs ?? DEFAULTS.shortRangeMs

    if (pageNum % longEvery === 0) {
        onProgress(opts.longHint ?? DEFAULTS.longHint)
        await sleepRandom(longRange[0], longRange[1])
    } else if (pageNum % midEvery === 0) {
        onProgress(opts.midHint ?? DEFAULTS.midHint)
        await sleepRandom(midRange[0], midRange[1])
    } else {
        await sleepRandom(shortRange[0], shortRange[1])
    }
}

// 错误退避：未达熔断阈值时单次错后短退避
export async function sleepAfterError(rangeMs: readonly [number, number] = [3000, 6000]): Promise<void> {
    await sleepRandom(rangeMs[0], rangeMs[1])
}
