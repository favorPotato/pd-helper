import {cmdSearch, cmdDetail} from './collect.mjs'
import {cmdIndex} from './index-gen.mjs'
import {cmdCategories} from './categories.mjs'
import {usage} from './argv.mjs'
import {exitFor} from './codes.mjs'

// search/detail 需 SW/CDP attach；index/categories 纯本地派生。main 据 exolytNeedsSession 决定是否先 attach。
const REMOTE_SUBS = new Set(['search', 'detail'])

export function exolytNeedsSession(sub) {
    return REMOTE_SUBS.has(sub)
}

// 剥掉 rest[0]（子命令名），让各子命令照常读自己的位置参数（如 categories <name>）
export async function runExolytCommand(session, args) {
    const sub = args.rest[0]
    const subArgs = {...args, rest: args.rest.slice(1)}
    switch (sub) {
        case 'search':
            return await cmdSearch(session, subArgs)
        case 'detail':
            return await cmdDetail(session, subArgs)
        case 'index':
            return cmdIndex(subArgs)
        case 'categories':
            return cmdCategories(subArgs)
        default:
            process.stderr.write(`unknown exolyt subcommand: ${sub || '(none)'}\n\n${usage()}`)
            return exitFor('INVALID_PARAM')
    }
}
