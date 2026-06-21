import {cmdCollect} from './collect.mjs'
import {cmdIndex} from './index-gen.mjs'
import {cmdCategories} from './categories.mjs'
import {usage} from './argv.mjs'
import {exitFor} from './codes.mjs'

// exolyt 命令族分发器（与 sheet.mjs 同范式：一个命令族一个顶层模块，main 直接 import）
// collect 需 SW/CDP attach；index/categories 纯本地派生。main 据 exolytNeedsSession 决定是否先 attach。
const REMOTE_SUBS = new Set(['collect'])

export function exolytNeedsSession(sub) {
    return REMOTE_SUBS.has(sub)
}

// 子参数移位：剥掉 rest[0]（子命令名），让各子命令照常读自己的位置参数（如 categories <name>）
export async function runExolytCommand(session, args) {
    const sub = args.rest[0]
    const subArgs = {...args, rest: args.rest.slice(1)}
    switch (sub) {
        case 'collect':
            return await cmdCollect(session, subArgs)
        case 'index':
            return cmdIndex(subArgs)
        case 'categories':
            return cmdCategories(subArgs)
        default:
            process.stderr.write(`unknown exolyt subcommand: ${sub || '(none)'}\n\n${usage()}`)
            return exitFor('INVALID_PARAM')
    }
}
