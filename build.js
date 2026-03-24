import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import manifest from './src/manifest.js'

mkdirSync('dist', { recursive: true })

const mediaPrompt = readFileSync('src/prompts/media.md', 'utf8')
const scriptApiBase = process.env.SCRIPT_API_BASE || ''
const scriptApiKey = process.env.SCRIPT_API_KEY || ''

if (!scriptApiBase) {
  throw new Error('Missing SCRIPT_API_BASE. 请在 .env 中配置该参数。')
}

const common = {
  bundle: true,
  minify: true,
  target: 'chrome100',
  sourcemap: true,
  define: {
    __MEDIA_PROMPT__: JSON.stringify(mediaPrompt),
    __SCRIPT_API_BASE__: JSON.stringify(scriptApiBase),
    __SCRIPT_API_KEY__: JSON.stringify(scriptApiKey)
  }
}

await Promise.all([
  build({ ...common, entryPoints: ['src/shared/content.ts'], outfile: 'dist/content.js' }),
  build({ ...common, entryPoints: ['src/shared/background.ts'], outfile: 'dist/background.js' })
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
