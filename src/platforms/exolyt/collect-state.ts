// exolyt 浮窗采集的纯内存态：零落盘、关闭即止。
// 续采靠 Sheets 远程去重（重开浮窗重新检索），故此处不持久化任何状态——内存丢失等价于会话结束。

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

// 暂停标志：采集轮询每条前自查，true 时停在当前条目前（不中断已在途的单条）
let paused = false

export function isPaused(): boolean {
    return paused
}

export function pause(): void {
    paused = true
}

export function resume(): void {
    paused = false
}

// 本次检索得到的 videoId 批量入列：已在列表者跳过（同会话列表去重，以 items 为准），
// 新条目以 searched 态落入。返回真正新增的条目（供浮窗日志报「本次新增 N」）。
// 业务「采过不采」由远程去重表负责，本端不留冗余去重，故 removeItem 摘除者可重新入列。
export function addSearched(videoIds: string[]): ExolytCollectItem[] {
    const added: ExolytCollectItem[] = []
    for (const videoId of videoIds) {
        if (items.has(videoId)) continue
        const item: ExolytCollectItem = {videoId, status: 'searched'}
        items.set(videoId, item)
        added.push(item)
    }
    return added
}

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

// detail 续采候选（两链路唯一口径）：基集 searched∪detailed，剔除 have 后即待采。
// 纳入 detailed 是因 detail 被中断后续跑会把部分 searched 标为 detailed，仅取 searched 会漏掉这些条目。
// have = 已确认完成集，由调用方按各自落盘语义给：CLI 传 node 已落盘集（raws/exolyt 实际文件），
// 浮窗无磁盘、raw 直存内存，传「已具 exolytRaw 集」（其落盘等价物）。两边经此函数同口径，不再各写各的。
export function listDetailCandidates(have: Set<string>): string[] {
    const candidates: string[] = []
    for (const it of items.values()) {
        if (it.status !== 'searched' && it.status !== 'detailed') continue
        if (have.has(it.videoId)) continue
        candidates.push(it.videoId)
    }
    return candidates
}

// 浮窗「已具 raw」集——浮窗侧 listDetailCandidates 的 have：raw 直存内存，有 raw 即已采完。
export function listVideoIdsWithRaw(): Set<string> {
    const ids = new Set<string>()
    for (const it of items.values()) {
        if (it.exolytRaw !== undefined) ids.add(it.videoId)
    }
    return ids
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

// 移出列表：GONE/AUTH_WALL 终态跳过时摘除条目。摘除后该 id 可被重检索重新入列（去重以远程为准）。
export function removeItem(videoId: string): boolean {
    return items.delete(videoId)
}

// 整体清空：浮窗关闭/会话结束时丢弃全部内存态
export function clearAll(): void {
    items.clear()
    paused = false
}
