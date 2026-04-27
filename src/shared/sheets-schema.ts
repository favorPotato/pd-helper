export const SHEET_NAMES = {
    tkInfluencers: 'tk博主',
    tkVideos: 'tk视频',
    igInfluencers: 'ig博主',
    igVideos: 'ig视频',
} as const

export const INFLUENCER_HEADERS: Record<string, string> = {
    channelId: '频道ID',
    username: '用户名',
    name: '昵称',
    country: '国家',
    status: '状态',
    genderTag: '性别标签',
    followers: '粉丝数',
    totalVideos: '视频数',
    qualifyingRate: '合格率',
    postRate: '预估月更',
    archivedVideoCount: '入库数',
    noxScore: 'Nox评分',
    lastError: '错误信息',
    extraData: '扩展数据',
    createdAt: '入库时间',
    updatedAt: '更新时间',
}

export const INFLUENCER_COLUMN_ORDER = [
    'channelId', 'username', 'name', 'country',
    'status', 'genderTag', 'followers', 'totalVideos', 'qualifyingRate', 'postRate', 'archivedVideoCount', 'noxScore',
    'lastError', 'extraData', 'createdAt', 'updatedAt',
] as const

export const VIDEO_HEADERS: Record<string, string> = {
    videoId: '视频ID',
    videoJson: '视频数据',
}

export const VIDEO_COLUMN_ORDER = ['videoId', 'videoJson'] as const

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


