import {CdpError, httpJson, connectWs} from './transport.mjs'
import {sleep} from './io.mjs'

function getTargetId(t) {
    return t.targetId || t.id || ''
}

function listExtensionSws(targets) {
    return targets.filter(t => t.type === 'service_worker' && typeof t.url === 'string' && t.url.includes('chrome-extension://'))
}

const PD_HELPER_NAME = 'pd-helper'

async function probeSwIsPdHelper(wsUrl) {
    let conn = null
    try {
        conn = await connectWs(wsUrl)
        const res = await conn.send('Runtime.evaluate', {
            expression: `(() => { try { return chrome.runtime.getManifest().name; } catch (e) { return ''; } })()`,
            returnByValue: true,
            awaitPromise: false
        })
        // noinspection JSUnresolvedReference,JSUnresolvedVariable -- res 是 CDP Runtime.evaluate 的响应，.result 字段由 CDP 协议保证存在，IDE 无类型信息故误报
        return String(res.result?.value || '') === PD_HELPER_NAME
    } catch {
        return false
    } finally {
        if (conn) conn.close()
    }
}

async function discoverViaJson(base, extIdHint) {
    const targets = await httpJson(`${base}/json`)
    const sws = listExtensionSws(targets)
    for (const sw of sws) {
        if (!sw.webSocketDebuggerUrl) continue
        const m = String(sw.url || '').match(/chrome-extension:\/\/([a-p]{32})\//)
        const extId = m ? m[1] : ''
        const ok = extIdHint
            ? extId === extIdHint
            : await probeSwIsPdHelper(sw.webSocketDebuggerUrl)
        if (ok) {
            return {
                extId,
                title: sw.title || '',
                webSocketDebuggerUrl: sw.webSocketDebuggerUrl,
                targetId: getTargetId(sw),
                via: 'json'
            }
        }
    }
    return null
}

export async function listPageTargets(base, predicate) {
    const list = await httpJson(`${base}/json`)
    return list.filter(t => t.type === 'page'
        && typeof t.webSocketDebuggerUrl === 'string'
        && predicate(String(t.url || '')))
}

// noinspection JSUnusedGlobalSymbols -- 实际由 loop.mjs 的 tryReconnect() import 并调用（CDP 断线重连路径）
export async function reconnectSession(session) {
    try { session.conn.close() } catch { /* ignore */ }
    const fresh = await attachToServiceWorker(session.cdpUrl, session.opts)
    session.conn = fresh.conn
    session.sessionId = fresh.sessionId
    session.target = fresh.target
    session.via = fresh.via
}

export async function attachToServiceWorker(cdpUrl, opts = {}) {
    const base = cdpUrl.replace(/\/+$/, '')

    try {
        const target = await discoverViaJson(base, opts.extId)
        if (target) {
            const conn = await connectWs(target.webSocketDebuggerUrl)
            try { await conn.send('Debugger.enable') } catch { /* ignore */ }
            try { await conn.send('Runtime.enable') } catch { /* ignore */ }
            return {conn, via: 'json', target, cdpUrl, opts}
        }
    } catch (e) {
        if (e instanceof CdpError && e.code === 'CHROME_NOT_FOUND') throw e
    }

    const version = await httpJson(`${base}/json/version`)
    if (!version.webSocketDebuggerUrl) throw new CdpError('SW_DEAD', '未拿到 browser webSocketDebuggerUrl')

    const conn = await connectWs(version.webSocketDebuggerUrl)
    try {
        const session = await dormantWakeAndAttach(conn, version.webSocketDebuggerUrl, opts.extId)
        session.cdpUrl = cdpUrl
        session.opts = opts
        return session
    } catch (e) {
        conn.close()
        throw e
    }
}

async function dormantWakeAndAttach(conn, browserWsUrl, extIdHint) {
    const captures = []
    const off = conn.onEvent((ev) => {
        if (ev.method !== 'Target.attachedToTarget') return
        const info = ev.params
        const t = info.targetInfo
        const sid = info.sessionId
        if (!t || !sid) return
        if (t.type === 'service_worker' && String(t.url || '').includes('chrome-extension://')) {
            captures.push({sessionId: sid, targetInfo: t})
        }
    })

    try {
        await conn.send('Target.setDiscoverTargets', {discover: true})
        await conn.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
            filter: [{type: 'service_worker', exclude: false}]
        })

        const pdExtId = extIdHint || await detectPdHelperExtId(conn).catch(() => '')
        if (!pdExtId) throw new CdpError('SW_DEAD', '未能枚举到 pd-helper 扩展 ID（可用 --ext-id 提供）')

        const matchPd = () => captures.find(c => String(c.targetInfo.url || '').includes(`chrome-extension://${pdExtId}/`))

        await sleep(300)

        if (!matchPd()) {
            await wakeViaPageSession(conn, pdExtId)
            const deadline = Date.now() + 5000
            while (!matchPd() && Date.now() < deadline) await sleep(100)
        }

        const cap = matchPd()
        if (!cap) throw new CdpError('SW_DEAD', `pd-helper SW 唤醒后仍未 attach (extId=${pdExtId})`)

        const t = cap.targetInfo
        const sessionId = cap.sessionId
        const target = {
            extId: pdExtId,
            title: t.title || '',
            webSocketDebuggerUrl: browserWsUrl,
            targetId: getTargetId(t),
            via: 'browser'
        }

        try { await conn.send('Runtime.enable', {}, sessionId) } catch { /* ignore */ }
        try { await conn.send('Debugger.enable', {}, sessionId) } catch { /* ignore */ }

        return {conn, sessionId, via: 'browser', target, cdpUrl: '', opts: {}}
    } finally {
        off()
    }
}

async function detectPdHelperExtId(conn) {
    const t = await conn.send('Target.getTargets', {})
    // noinspection JSUnresolvedReference,JSUnresolvedVariable -- t 是 CDP Target.getTargets 的响应，.targetInfos 字段由 CDP 协议保证存在
    let extPage = t.targetInfos.find(x => x.url === 'chrome://extensions/')
    let createdId = ''
    if (!extPage) {
        const ct = await conn.send('Target.createTarget', {url: 'chrome://extensions/'})
        createdId = ct.targetId
        await sleep(800)
        extPage = {targetId: createdId, url: 'chrome://extensions/'}
    }
    const targetId = getTargetId(extPage)
    if (!targetId) return ''

    const at = await conn.send('Target.attachToTarget', {targetId, flatten: true})
    const sid = at.sessionId
    try {
        await conn.send('Runtime.enable', {}, sid)
        const r = await conn.send('Runtime.evaluate', {
            expression: `(() => { try {
                const items = [...document.querySelector("extensions-manager").shadowRoot.querySelector("extensions-item-list").shadowRoot.querySelectorAll("extensions-item")];
                const pd = items.find(e => (e.shadowRoot && e.shadowRoot.querySelector('#name')?.textContent || '').trim() === 'pd-helper');
                return pd ? pd.id : '';
            } catch (e) { return ''; } })()`,
            returnByValue: true,
            awaitPromise: false
        }, sid)
        return String(r.result?.value || '')
    } finally {
        try { await conn.send('Target.detachFromTarget', {sessionId: sid}) } catch { /* ignore */ }
        if (createdId) {
            try { await conn.send('Target.closeTarget', {targetId: createdId}) } catch { /* ignore */ }
        }
    }
}

// ServiceWorker.* 不存在于 browser endpoint，必须在 page session 上调用
async function wakeViaPageSession(conn, extId) {
    const ct = await conn.send('Target.createTarget', {
        url: `chrome-extension://${extId}/manifest.json`
    })
    const pageTid = ct.targetId
    if (!pageTid) return

    try {
        await sleep(300)  // 等 page session ready
        const at = await conn.send('Target.attachToTarget', {targetId: pageTid, flatten: true})
        const pageSid = at.sessionId

        try {
            await conn.send('ServiceWorker.enable', {}, pageSid)
            await conn.send('ServiceWorker.startWorker', {scopeURL: `chrome-extension://${extId}/`}, pageSid)
        } finally {
            try { await conn.send('Target.detachFromTarget', {sessionId: pageSid}) } catch { /* ignore */ }
        }
    } finally {
        try { await conn.send('Target.closeTarget', {targetId: pageTid}) } catch { /* ignore */ }
    }
}
