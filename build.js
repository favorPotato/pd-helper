import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import manifest from './src/manifest.js'

mkdirSync('dist', { recursive: true })

const mediaPrompt = readFileSync('src/prompts/media.md', 'utf8')

const common = {
  bundle: true,
  minify: true,
  target: 'chrome100',
  sourcemap: true,
  define: {
    __API_URL__: JSON.stringify(process.env.API_URL || ''),
    __API_KEY__: JSON.stringify(process.env.API_KEY || ''),
    __API_MODEL__: JSON.stringify(process.env.API_MODEL || ''),
    __API_TIMEOUT__: JSON.stringify(process.env.API_TIMEOUT || '120000'),
    __MEDIA_PROMPT__: JSON.stringify(mediaPrompt)
  }
}

await Promise.all([
  build({ ...common, entryPoints: ['src/shared/content.ts'], outfile: 'dist/content.js' }),
  build({ ...common, entryPoints: ['src/shared/background.ts'], outfile: 'dist/background.js' })
])

const apiUrl = process.env.API_URL || ''
let apiHost = ''

if (apiUrl) {
  try {
    apiHost = new URL(apiUrl).host
  } catch (error) {
    console.warn('Invalid API_URL:', apiUrl, error)
  }
}
const manifestOutput = {
  ...manifest,
  host_permissions: [
    ...manifest.host_permissions,
    ...(apiHost ? [`https://${apiHost}/*`] : [])
  ]
}

writeFileSync('dist/manifest.json', JSON.stringify(manifestOutput, null, 2))
