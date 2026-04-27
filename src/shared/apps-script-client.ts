import type {AppsScriptRequestMessage, AppsScriptResponse} from '../types'
import {safeSendMessage} from './messaging'

export async function checkAppsScriptHealth(): Promise<{ok: boolean; error?: string}> {
    try {
        await callAppsScript('loadInfluencersByStatus', {platform: 'tiktok', status: 'unused', limit: 0})
        return {ok: true}
    } catch (e) {
        return {ok: false, error: e instanceof Error ? e.message : String(e)}
    }
}

export async function callAppsScript<T>(action: string, payload: unknown): Promise<T> {
    const message: AppsScriptRequestMessage = {
        type: 'apps_script_request',
        action,
        payload
    }
    const response = await safeSendMessage<AppsScriptResponse>(message)

    if (!response) {
        throw new Error('Apps Script 请求失败: background 无响应')
    }

    if (!response.ok) {
        throw new Error(response.error || `Apps Script 请求失败: ${response.status}`)
    }

    const data = response.data as {ok: boolean; error?: string} & T
    if (!data.ok) {
        throw new Error(`Apps Script 业务错误: ${data.error || 'unknown'}`)
    }

    return data
}
