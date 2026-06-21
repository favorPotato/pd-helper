// SW 侧支持平台的域名匹配——单一来源，供 dispatcher 与 csTest 共用
export interface PlatformSpec {
    name: string
    urls: string[]
}

export const PLATFORM_TIKTOK: PlatformSpec = {name: 'tiktok', urls: ['*://*.tiktok.com/*']}
export const PLATFORM_INSTAGRAM: PlatformSpec = {name: 'instagram', urls: ['*://*.instagram.com/*']}
export const PLATFORM_NOX: PlatformSpec = {name: 'noxinfluencer', urls: ['*://*.noxinfluencer.com/*']}
export const PLATFORM_EXOLYT: PlatformSpec = {name: 'exolyt', urls: ['*://*.exolyt.com/*']}

// 需要"任意已支持平台的 tab"时用（如 csTest）
export const ALL_PLATFORM_URLS: string[] = [
    ...PLATFORM_TIKTOK.urls,
    ...PLATFORM_INSTAGRAM.urls,
    ...PLATFORM_NOX.urls,
    ...PLATFORM_EXOLYT.urls
]
