import type {ApiConfig} from '../types'
import {API_KEY, API_MODEL, API_TIMEOUT, API_URL, MEDIA_PROMPT} from './env'

const apiConfig: ApiConfig = {
    url: API_URL,
    key: API_KEY,
    model: API_MODEL,
    timeout: API_TIMEOUT
}


export async function analyzeMedia(mediaUrl: string | string[]): Promise<string | null> {
    if (!apiConfig.url || !apiConfig.key || !apiConfig.model) {
        console.error('缺少 API 配置')
        return null
    }

    const urls = Array.isArray(mediaUrl) ? mediaUrl : [mediaUrl]
    const imageContents = urls
        .filter((url) => typeof url === 'string' && url.length > 0)
        .map((url) => ({type: 'image_url', image_url: {url}, fps: 0.1}))
    if (imageContents.length === 0) return null

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), apiConfig.timeout)

    try {
        const response = await fetch(apiConfig.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiConfig.key}`
            },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [
                    {role: 'system', content: [{type: 'text', text: MEDIA_PROMPT}]},
                    {
                        role: 'user',
                        content: [
                            ...imageContents,
                            {type: 'text', text: '请按照《视频/图片解析通用规范》解析这个文件'}
                        ]
                    }
                ]
            }),
            signal: controller.signal
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
            console.error('API 请求失败:', response.status)
            return null
        }

        const data = await response.json()
        return data.choices?.[0]?.message?.content || null
    } catch (error) {
        clearTimeout(timeoutId)
        console.error('AI 分析异常:', error)
        return null
    }
}
