import {parseArgs, usage} from './argv.mjs'
import {cmdMethods, cmdList, cmdStatus, cmdCancel, cmdDevReload} from './commands.mjs'
import {attachToServiceWorker} from './attach.mjs'
import {CdpError} from './transport.mjs'
import {exitFor} from './codes.mjs'
import {emit, emitSynthetic, ttyLog, numFlag} from './io.mjs'
import {runCall} from './loop.mjs'

// EPIPE 守卫：下游提前关闭管道时干净退出，否则默认抛 Unhandled error
for (const s of [process.stdout, process.stderr]) {
    s.on('error', (e) => {
        if (e.code === 'EPIPE') process.exit(0)
        throw e
    })
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    if (!args.cmd || args.cmd === '-h' || args.cmd === '--help' || args.cmd === 'help') {
        process.stdout.write(usage())
        return 0
    }

    // noinspection JSUnresolvedReference,JSUnresolvedVariable -- flags 由 parseArgs 动态填充，.cdp 来自 --cdp 命令行参数
    const cdpUrl = args.flags.cdp || process.env.PD_HELPER_CDP || 'http://127.0.0.1:9222'

    const extId = args.flags['ext-id'] || process.env.PD_HELPER_EXT_ID || undefined

    let session
    try {
        session = await attachToServiceWorker(cdpUrl, {extId})
    } catch (e) {
        const code = e instanceof CdpError ? e.code : 'CHROME_NOT_FOUND'
        const msg = e instanceof Error ? e.message : String(e)
        emit({v: 1, type: 'error', taskId: '', seq: -1, ts: Date.now(), data: {code, message: msg}})
        return exitFor(code)
    }
    ttyLog(`[pd-helper-cli] attached via=${session.via} extId=${session.target.extId} title="${session.target.title}"`)

    try {
        switch (args.cmd) {
            case 'methods':
                return await cmdMethods(session, args)
            case 'list':
                return await cmdList(session, args)
            case 'status':
                return await cmdStatus(session, args)
            case 'cancel':
                return await cmdCancel(session, args)
            case 'dev-reload':
                return await cmdDevReload(session, cdpUrl)
            case 'call': {
                const method = args.rest[0]
                if (!method) {
                    console.error('call: missing <method>')
                    return exitFor('INVALID_PARAM')
                }
                const timeoutMs = numFlag(args.flags.timeout, 3600, 1) * 1000
                const pollIntervalMs = numFlag(args.flags['poll-interval'], 2000, 1)
                const statusIntervalMs = numFlag(args.flags['status-interval'], 30000, 1)
                return await runCall(session, {
                    method,
                    params: args.params,
                    timeoutMs,
                    pollIntervalMs,
                    statusIntervalMs
                })
            }
            default:
                process.stderr.write(`unknown command: ${args.cmd}\n\n${usage()}`)
                return exitFor('INVALID_PARAM')
        }
    } catch (e) {
        const code = e instanceof CdpError ? e.code : 'UNKNOWN_ERROR'
        const msg = e instanceof Error ? e.message : String(e)
        emitSynthetic('', 'error', {code, message: msg})
        return exitFor(code)
    } finally {
        session.conn.close()
    }
}

void main().then((code) => {
    // 排空 stdout，防止管道背压下尾帧被 process.exit 截断
    if (process.stdout.writableLength === 0) process.exit(code)
    else process.stdout.once('drain', () => process.exit(code))
})
