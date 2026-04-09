import {build} from 'esbuild'
import {mkdirSync, readFileSync, writeFileSync} from 'fs'
import manifest from './src/manifest.js'

mkdirSync('dist', {recursive: true})

function requireNonEmpty(name, value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Missing ${name}. 请在 .env 中配置该参数。`)
    }
    return value.trim()
}

function requireText(name, value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Missing ${name}.`)
    }
    return value
}

const mediaPrompt = requireText('MEDIA_PROMPT', readFileSync('src/prompts/media.md', 'utf8'))
const scriptApiBase = requireNonEmpty('SCRIPT_API_BASE', process.env.SCRIPT_API_BASE)
const scriptApiKey = requireNonEmpty('SCRIPT_API_KEY', process.env.SCRIPT_API_KEY)
const tiktokMinPlayCount = requireNonEmpty('TIKTOK_MIN_PLAY_COUNT', process.env.TIKTOK_MIN_PLAY_COUNT)
const tiktokMinLikeRate = requireNonEmpty('TIKTOK_MIN_LIKE_RATE', process.env.TIKTOK_MIN_LIKE_RATE)
const tiktokMaxVideoDuration = requireNonEmpty('TIKTOK_MAX_VIDEO_DURATION', process.env.TIKTOK_MAX_VIDEO_DURATION)
const tiktokMinCommentCount = requireNonEmpty('TIKTOK_MIN_COMMENT_COUNT', process.env.TIKTOK_MIN_COMMENT_COUNT)

const common = {
    bundle: true,
    minify: true,
    target: 'chrome100',
    sourcemap: true,
    define: {
        __MEDIA_PROMPT__: JSON.stringify(mediaPrompt),
        __SCRIPT_API_BASE__: JSON.stringify(scriptApiBase),
        __SCRIPT_API_KEY__: JSON.stringify(scriptApiKey),
        __TIKTOK_MIN_PLAY_COUNT__: JSON.stringify(tiktokMinPlayCount),
        __TIKTOK_MIN_LIKE_RATE__: JSON.stringify(tiktokMinLikeRate),
        __TIKTOK_MAX_VIDEO_DURATION__: JSON.stringify(tiktokMaxVideoDuration),
        __TIKTOK_MIN_COMMENT_COUNT__: JSON.stringify(tiktokMinCommentCount)
    }
}

await Promise.all([
    build({...common, entryPoints: ['src/shared/content.ts'], outfile: 'dist/content.js'}),
    build({...common, entryPoints: ['src/shared/background.ts'], outfile: 'dist/background.js'}),
    build({...common, entryPoints: ['src/platforms/tiktok/page-bridge.ts'], outfile: 'dist/page-bridge.js'})
])

let scriptApiPermission = ''

if (scriptApiBase) {
    try {
        const scriptApiUrl = new URL(scriptApiBase)
        scriptApiPermission = `${scriptApiUrl.origin}/*`
    } catch (error) {
        console.warn('Invalid SCRIPT_API_BASE:', scriptApiBase, error)
    }
}

const manifestOutput = {
    ...manifest,
    host_permissions: [
        ...manifest.host_permissions,
        ...(scriptApiPermission ? [scriptApiPermission] : [])
    ]
}

writeFileSync('dist/manifest.json', JSON.stringify(manifestOutput, null, 2))
