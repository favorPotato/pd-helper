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
    __MEDIA_PROMPT__: JSON.stringify(mediaPrompt)
  }
}

await Promise.all([
  build({ ...common, entryPoints: ['src/shared/content.ts'], outfile: 'dist/content.js' }),
  build({ ...common, entryPoints: ['src/shared/background.ts'], outfile: 'dist/background.js' })
])

writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2))
