import {exitFor} from './codes.mjs'

export const BOOL_FLAGS = new Set(['all', 'help'])

export function parseArgs(raw) {
    const cmd = raw[0] || ''
    const rest = []
    const flags = {}
    const params = {}
    for (let i = 1; i < raw.length; i += 1) {
        const a = raw[i]
        if (a === '--param') {
            if (i + 1 >= raw.length) {
                console.error('invalid --param: missing key=value')
                process.exit(exitFor('INVALID_PARAM'))
            }
            const kv = raw[++i]
            const eq = kv.indexOf('=')
            if (eq < 0) {
                console.error(`invalid --param value: ${kv} (expected key=value)`)
                process.exit(exitFor('INVALID_PARAM'))
            }
            params[kv.slice(0, eq)] = autoCoerce(kv.slice(eq + 1))
            continue
        }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=')
            if (eq > 0) {
                flags[a.slice(2, eq)] = a.slice(eq + 1)
            } else {
                const name = a.slice(2)
                if (BOOL_FLAGS.has(name)) {
                    flags[name] = 'true'
                } else if (i + 1 < raw.length && !raw[i + 1].startsWith('--')) {
                    flags[name] = raw[++i]
                } else {
                    flags[name] = 'true'
                }
            }
            continue
        }
        rest.push(a)
    }
    return {cmd, rest, flags, params}
}

export function autoCoerce(v) {
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === 'null') return null
    // 保留字符串：数值字段由 SW 端 numParam 自行转，避免纯数字 username 被 strParam 判空拒
    return v
}

export function usage() {
    return `pd-helper-cli <command> [options]

Commands:
  call <method> [--param k=v ...]    Start and follow a task to completion
  list [--all]                        List active tasks (--all includes done/cancelled/error)
  status <taskId>                     Snapshot a task's progress
  cancel <taskId>                     Cancel a task
  methods                             List available methods
  sheet <action> [--param k=v ...]    Call an Apps Script / Google Sheets action directly (HTTP, no browser); complex payloads via --payload '<json>'
  dev-reload                          Reload the extension SW and refresh matching tabs (dev only)

Global options:
  --cdp <url>             CDP HTTP endpoint (default: env PD_HELPER_CDP or http://127.0.0.1:9222)
  --ext-id <id>           pd-helper extension id (default: env PD_HELPER_EXT_ID; auto-detect via chrome://extensions/)
  --timeout <seconds>     Total timeout for "call" (default: 3600)
  --poll-interval <ms>    Tail poll interval (default: 2000)
  --status-interval <ms>  Status snapshot interval (default: 30000)

Examples:
  pd-helper-cli call ping --param count=5 --param interval=300 --cdp http://127.0.0.1:31402
  pd-helper-cli methods
  pd-helper-cli sheet loadInfluencersByStatus --param platform=tiktok --param status=unused
  pd-helper-cli sheet upsertNoxPage --payload '{"url":"https://...","pageNum":3}'
`
}
