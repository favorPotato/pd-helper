export interface CollectYearRange {
    startYear: number
    endYear: number
    label: string
}

export function requestCollectVideoCount(): number | null {
    const input = window.prompt('请输入采集视频数量（默认 10）', '')
    if (input === null) return null

    const trimmed = input.trim()
    if (!trimmed) return 10

    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return 10
    return parsed
}

export function parseCollectYearRange(input: string): CollectYearRange {
    const trimmed = input.trim()
    const normalized = trimmed || '2025-2026'
    const single = normalized.match(/^(\d{4})$/)
    if (single) {
        const year = Number.parseInt(single[1], 10)
        return {startYear: year, endYear: year, label: String(year)}
    }

    const range = normalized.match(/^(\d{4})\s*-\s*(\d{4})$/)
    if (range) {
        const left = Number.parseInt(range[1], 10)
        const right = Number.parseInt(range[2], 10)
        const startYear = Math.min(left, right)
        const endYear = Math.max(left, right)
        return {startYear, endYear, label: `${startYear}-${endYear}`}
    }

    return {startYear: 2025, endYear: 2026, label: '2025-2026'}
}

export function requestCollectYearRange(): CollectYearRange | null {
    const input = window.prompt('请输入采集年份（默认 2025-2026）', '')
    if (input === null) return null
    return parseCollectYearRange(input)
}
