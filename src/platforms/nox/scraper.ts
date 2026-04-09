export interface ScrapedInfluencer {
    channelId: string
    tiktokUsername: string
    name: string
}

export function scrapeSelectedInfluencers(): ScrapedInfluencer[] {
    const items = document.querySelectorAll('.youtube-channel-item')
    const result: ScrapedInfluencer[] = []

    items.forEach((item) => {
        const checkbox = item.querySelector('.el-checkbox__input')
        if (!checkbox?.classList.contains('is-checked')) return

        const link = item.querySelector('a[href*="/tiktok/channel/"]')
        if (!(link instanceof HTMLAnchorElement)) return

        const channelIdMatch = link.href.match(/\/tiktok\/channel\/(\d+)/)
        if (!channelIdMatch) return

        const name = link.querySelector('.title.ellipsis')?.textContent?.trim() || ''
        const rawAlias = item.querySelector('.influencer-alias')?.textContent?.trim() || ''
        const tiktokUsername = rawAlias.replace(/^@/, '')
        if (!tiktokUsername) return

        result.push({
            channelId: channelIdMatch[1],
            tiktokUsername,
            name
        })
    })

    return result
}

export function getSelectedCount(): number {
    return document.querySelectorAll('.youtube-channel-item .el-checkbox__input.is-checked').length
}
