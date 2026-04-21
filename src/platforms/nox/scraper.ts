import type {InfluencerPlatform} from './types'

export interface ScrapedInfluencer {
    channelId: string
    platform: InfluencerPlatform
    username: string
    name: string
}

function detectPlatform(): InfluencerPlatform | null {
    const path = window.location.pathname
    if (path.startsWith('/search/tiktok/channel')) return 'tiktok'
    if (path.startsWith('/search/instagram/channel')) return 'instagram'
    return null
}

function getChannelLinkSelector(platform: InfluencerPlatform): string {
    return `a[href*="/${platform}/channel/"]`
}

export function scrapeSelectedInfluencers(): ScrapedInfluencer[] {
    const platform = detectPlatform()
    if (!platform) return []

    const linkSelector = getChannelLinkSelector(platform)
    const items = document.querySelectorAll('.youtube-channel-item')
    const result: ScrapedInfluencer[] = []

    items.forEach((item) => {
        const checkbox = item.querySelector('.el-checkbox__input')
        if (!checkbox?.classList.contains('is-checked')) return

        const link = item.querySelector(linkSelector)
        if (!(link instanceof HTMLAnchorElement)) return

        const channelIdMatch = link.href.match(/\/(tiktok|instagram)\/channel\/(\d+)/)
        if (!channelIdMatch) return

        const name = item.querySelector('.title-container .title')?.textContent?.trim() || ''
        const rawAlias = item.querySelector('.influencer-alias')?.textContent?.trim() || ''
        const username = rawAlias.replace(/^@/, '')
        if (!username) return

        result.push({
            channelId: channelIdMatch[2],
            platform,
            username,
            name
        })
    })

    return result
}

export function getSelectedCount(): number {
    return document.querySelectorAll('.youtube-channel-item .el-checkbox__input.is-checked').length
}
