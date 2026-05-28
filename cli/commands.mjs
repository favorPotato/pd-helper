import {callPd} from './rpc.mjs'
import {connectWs} from './transport.mjs'
import {listPageTargets} from './attach.mjs'
import {ttyLog} from './io.mjs'
import {exitFor} from './codes.mjs'

const PLATFORM_HOST_RE = /(?:tiktok|instagram|noxinfluencer)\.com/i

export async function cmdMethods(session) {
    const methods = await callPd(session, 'methods', [])
    process.stdout.write(JSON.stringify(methods) + '\n')
    return 0
}

export async function cmdList(session, args) {
    const all = args.flags.all === 'true'
    const tasks = await callPd(session, 'listTasks', [{all}])
    process.stdout.write(JSON.stringify(tasks, null, 2) + '\n')
    return 0
}

export async function cmdStatus(session, args) {
    const taskId = args.rest[0]
    if (!taskId) {
        console.error('status: missing <taskId>')
        return exitFor('INVALID_PARAM')
    }
    const snap = await callPd(session, 'status', [taskId])
    process.stdout.write(JSON.stringify(snap, null, 2) + '\n')
    return 0
}

export async function cmdCancel(session, args) {
    const taskId = args.rest[0]
    if (!taskId) {
        console.error('cancel: missing <taskId>')
        return exitFor('INVALID_PARAM')
    }
    const r = await callPd(session, 'cancel', [taskId])
    process.stdout.write(JSON.stringify(r) + '\n')
    return 0
}

export async function cmdDevReload(session, cdpUrl) {
    try {
        await session.conn.send('Runtime.evaluate', {
            expression: 'chrome.runtime.reload()',
            awaitPromise: false,
            returnByValue: true,
            userGesture: false
        }, session.sessionId)
    } catch {
        // SW 重启时 evaluate 被打断，可忽略
    }
    ttyLog('[pd-helper-cli] SW reload triggered')

    const sw = cdpUrl.replace(/\/+$/, '')
    let refreshed = 0
    try {
        const targets = await listPageTargets(sw, url => PLATFORM_HOST_RE.test(url))
        for (const t of targets) {
            const conn = await connectWs(t.webSocketDebuggerUrl)
            try {
                await conn.send('Page.reload')
                refreshed += 1
            } catch { /* ignore single-tab refresh errors */ } finally {
                conn.close()
            }
        }
    } catch (e) {
        ttyLog(`[pd-helper-cli] tab refresh skipped: ${e.message}`)
    }
    process.stdout.write(JSON.stringify({ok: true, swReloaded: true, tabsRefreshed: refreshed}) + '\n')
    return 0
}
