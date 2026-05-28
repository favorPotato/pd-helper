export const EXTRA_DATA_ORDER = [
    'femaleRatio', 'topRegion', 'topAgeRange', 'interactiveRate',
    'tags', 'estimateVideoPrice', 'estimateVideoViews', 'viewsFollowers',
    'followings', 'isCelebrity', 'isBrand', 'ttseller',
    'language', 'topGender', 'regions', 'maleAge', 'femaleAge',
] as const

export const EXTRA_DATA_LABELS: Record<string, string> = {
    femaleRatio: '女性观众比例',
    topRegion: '粉丝集中地区',
    topAgeRange: '粉丝集中年龄',
    interactiveRate: '互动率',
    tags: '常用标签',
    estimateVideoPrice: '单视频报价',
    estimateVideoViews: '单视频预估播放',
    viewsFollowers: '播粉比',
    followings: '关注数',
    isCelebrity: '是否名人',
    isBrand: '是否品牌号',
    ttseller: 'TikTok Shop 卖家',
    language: '粉丝语言',
    topGender: '受众性别',
    regions: '地区分布',
    maleAge: '男性年龄分布',
    femaleAge: '女性年龄分布',
}

export function formatExtraData(extra: Record<string, unknown>): string {
    const lines: string[] = []
    for (const key of EXTRA_DATA_ORDER) {
        const value = extra[key]
        if (value === undefined || value === null || value === '') continue
        const label = EXTRA_DATA_LABELS[key] || key
        lines.push(`${label}：${value}`)
    }
    for (const key of Object.keys(extra)) {
        if ((EXTRA_DATA_ORDER as readonly string[]).includes(key)) continue
        const value = extra[key]
        if (value === undefined || value === null || value === '') continue
        lines.push(`${key}：${value}`)
    }
    return lines.join('\n')
}
