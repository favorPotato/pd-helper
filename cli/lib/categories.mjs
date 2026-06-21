import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'

// 分类→hashtags 映射资产随 CLI 发布（cli/assets/），扩展 bundle 不内嵌（OQ-5：默认 CLI 配置文件侧）
// 相对本文件定位，不依赖 cwd——CLI 从任意目录跑都读得到
const ASSET_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'hashtags-BR-17cats.json')

function loadCategories() {
    const raw = JSON.parse(readFileSync(ASSET_PATH, 'utf8'))
    return raw.categories || {}
}

// 列全部中文分类名
export function listCategoryNames() {
    return Object.keys(loadCategories())
}

// 取某中文分类的 hashtags 数组；未知分类返回 null（调用方区分「无此类」与「类为空」）
export function hashtagsForCategory(name) {
    const cats = loadCategories()
    const entry = cats[name]
    if (!entry) return null
    return Array.isArray(entry.hashtags) ? entry.hashtags : []
}
