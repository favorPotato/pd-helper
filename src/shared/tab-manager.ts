import {truncateError} from './errors'
import {delay} from './timing'

export interface TabTarget {
    urlPattern: string
    createUrl: string
    matchRe: RegExp
}

export interface EnsureTabReadyOptions {
    activate?: boolean
    readySelector?: string
    returnToTabId?: number
    selectorTimeoutMs?: number
}

export const IG_TAB: TabTarget = {
    urlPattern: 'https://www.instagram.com/*',
    createUrl: 'https://www.instagram.com/',
    matchRe: /^https:\/\/www\.instagram\.com\//
}

export const TK_TAB: TabTarget = {
    urlPattern: 'https://www.tiktok.com/*',
    createUrl: 'https://www.tiktok.com/',
    matchRe: /^https:\/\/www\.tiktok\.com\//
}

async function activateTab(tabId: number): Promise<void> {
    await chrome.tabs.update(tabId, {active: true})
}

async function restoreTabIfNeeded(tabId: number | undefined, currentTabId: number): Promise<void> {
    if (!tabId || tabId === currentTabId) return
    try {
        await activateTab(tabId)
    } catch {
    }
}

async function queryTabSelector(tabId: number, selector: string): Promise<boolean> {
    const result = await chrome.scripting.executeScript({
        target: {tabId},
        func: (targetSelector: string) => Boolean(document.querySelector(targetSelector)),
        args: [selector]
    })
    return result.some((entry) => entry.result === true)
}

async function getOrCreateTab(target: TabTarget): Promise<chrome.tabs.Tab> {
    const tabs = await chrome.tabs.query({url: target.urlPattern})
    if (tabs.length > 0) {
        return tabs[0]
    }

    return await chrome.tabs.create({
        url: target.createUrl,
        active: false
    })
}

async function waitForTabComplete(tabId: number, matchRe: RegExp, timeoutMs = 20000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const tab = await chrome.tabs.get(tabId)
        if (tab.status === 'complete' && matchRe.test(tab.url || '')) {
            return true
        }
        await delay(250)
    }
    return false
}

async function waitForTabSelector(tabId: number, selector: string, timeoutMs = 15000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        try {
            if (await queryTabSelector(tabId, selector)) {
                return true
            }
        } catch {
        }

        await delay(250)
    }
    return false
}

async function pingContentScript(tabId: number): Promise<unknown> {
    return await chrome.tabs.sendMessage(tabId, {type: 'ping'})
}

async function ensureContentScript(tabId: number): Promise<void> {
    try {
        await pingContentScript(tabId)
        return
    } catch {
    }

    await chrome.scripting.executeScript({
        target: {tabId},
        files: ['content.js']
    })

    await delay(500)
    await pingContentScript(tabId)
}

export async function ensureTabReady(target: TabTarget, options: EnsureTabReadyOptions = {}): Promise<{ok: true; tab: chrome.tabs.Tab} | {ok: false; reason: string; error: string}> {
    try {
        const tab = await getOrCreateTab(target)
        if (!tab.id) {
            return {ok: false, reason: 'tab_error', error: 'missing_tab_id'}
        }

        if (options.activate) {
            await activateTab(tab.id)
        }

        if (!await waitForTabComplete(tab.id, target.matchRe)) {
            if (options.activate) await restoreTabIfNeeded(options.returnToTabId, tab.id)
            return {ok: false, reason: 'tab_error', error: 'timeout_waiting_for_tab_complete'}
        }
        if (options.readySelector && !await waitForTabSelector(tab.id, options.readySelector, options.selectorTimeoutMs)) {
            if (options.activate) await restoreTabIfNeeded(options.returnToTabId, tab.id)
            return {ok: false, reason: 'tab_error', error: `timeout_waiting_for_selector:${options.readySelector}`}
        }
        await ensureContentScript(tab.id)
        if (options.activate) {
            await restoreTabIfNeeded(options.returnToTabId, tab.id)
        }

        return {ok: true, tab}
    } catch (error) {
        return {
            ok: false,
            reason: 'tab_error',
            error: truncateError(error instanceof Error ? error.message : String(error), 500)
        }
    }
}
