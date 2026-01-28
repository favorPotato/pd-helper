export function truncateError(input: unknown, maxLen = 500): string {
    let s = String(input ?? '')
    if (s.length > maxLen) s = s.slice(0, maxLen) + '...'
    return s
}
