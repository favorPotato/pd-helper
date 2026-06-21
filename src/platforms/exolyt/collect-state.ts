// exolyt 浮窗采集的纯内存态：零落盘、关闭即止。
// 续采靠 Sheets 远程去重（重开浮窗重新检索），故此处不持久化任何状态——
// 内存丢失等价于"会话结束"，符合 spec「关闭即止、内存态丢弃」边界。

export type ExolytItemStatus = 'searched' | 'detailed' | 'failed' | 'zipped'

export interface ExolytCollectItem {
    videoId: string
    status: ExolytItemStatus
    // exolyt detail raw，采详情后填入，采视频时随消息下行给 tiktok tab 组 zip
    exolytRaw?: unknown
    // 最近一次失败原因（错误码或人读串），仅 failed 态有意义
    lastError?: string
}

// 条目列表：videoId → 条目；用 Map 保插入序，便于浮窗按检索顺序逐条推进
const items = new Map<string, ExolytCollectItem>()

// 跨次检索去重：本会话已纳入列表的 videoId 全集，避免改筛选重检索时重复入列
const seenVideoIds = new Set<string>()

// 暂停标志：采集轮询每条前自查，true 时停在当前条目前（不中断已在途的单条）
let paused = false

// ---- 暂停/继续 ----

export function isPaused(): boolean {
    return paused
}

export function pause(): void {
    paused = true
}

export function resume(): void {
    paused = false
}

// ---- 检索去重 ----

export function hasSeen(videoId: string): boolean {
    return seenVideoIds.has(videoId)
}

// 本次检索得到的 videoId 批量入列：跳过已见者，新条目以 searched 态落入并标记已见。
// 返回真正新增的条目（供浮窗日志报「本次新增 N」）。
export function addSearched(videoIds: string[]): ExolytCollectItem[] {
    const added: ExolytCollectItem[] = []
    for (const videoId of videoIds) {
        if (seenVideoIds.has(videoId)) continue
        seenVideoIds.add(videoId)
        const item: ExolytCollectItem = {videoId, status: 'searched'}
        items.set(videoId, item)
        added.push(item)
    }
    return added
}

// ---- 读 ----

export function getItem(videoId: string): ExolytCollectItem | undefined {
    return items.get(videoId)
}

export function listItems(): ExolytCollectItem[] {
    return [...items.values()]
}

export function listByStatus(status: ExolytItemStatus): ExolytCollectItem[] {
    return [...items.values()].filter((it) => it.status === status)
}

// 失败重试队列：status==='failed' 子集，供「再点采视频」对队列重跑
export function listRetryQueue(): ExolytCollectItem[] {
    return listByStatus('failed')
}

export interface ExolytStateCounts {
    searched: number
    detailed: number
    zipped: number
    failed: number
}

// 状态栏一行计数「已检索 N · 已详情 M · 已出包 K · 失败 F」
export function getCounts(): ExolytStateCounts {
    const counts: ExolytStateCounts = {searched: 0, detailed: 0, zipped: 0, failed: 0}
    for (const it of items.values()) {
        counts[it.status]++
    }
    return counts
}

// ---- 改 ----

// 标采详情成功：附 exolytRaw、清残留 lastError、转 detailed
export function markDetailed(videoId: string, exolytRaw: unknown): ExolytCollectItem | undefined {
    const item = items.get(videoId)
    if (!item) return undefined
    item.status = 'detailed'
    item.exolytRaw = exolytRaw
    item.lastError = undefined
    return item
}

// 标出包成功：转 zipped 终态（视频字节就地落盘，本端不留）
export function markZipped(videoId: string): ExolytCollectItem | undefined {
    const item = items.get(videoId)
    if (!item) return undefined
    item.status = 'zipped'
    item.lastError = undefined
    return item
}

// 标失败：转 failed 进重试队列、记错因。GONE/AUTH_WALL 终态由调用方判断后走 remove，不进此函数。
export function markFailed(videoId: string, lastError: string): ExolytCollectItem | undefined {
    const item = items.get(videoId)
    if (!item) return undefined
    item.status = 'failed'
    item.lastError = lastError
    return item
}

// ---- 删 ----

// 移出列表：GONE/AUTH_WALL 终态跳过时摘除条目。
// 保留 seenVideoIds 记录，避免同会话重检索把已判终态者重新拉回列表。
export function removeItem(videoId: string): boolean {
    return items.delete(videoId)
}

// 整体清空：浮窗关闭/会话结束时丢弃全部内存态
export function clearAll(): void {
    items.clear()
    seenVideoIds.clear()
    paused = false
}
