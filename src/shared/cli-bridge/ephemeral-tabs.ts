// CLI 导航式采集开的临时后台 tab：dispatcher 登记，任务终态（pd:done）时由 background 取出并关闭
const ephemeralTabs = new Map<string, number>()

export function registerEphemeralTab(taskId: string, tabId: number): void {
    ephemeralTabs.set(taskId, tabId)
}

// 取出即删：同一 tab 只关一次
export function takeEphemeralTab(taskId: string): number | undefined {
    const tabId = ephemeralTabs.get(taskId)
    ephemeralTabs.delete(taskId)
    return tabId
}
