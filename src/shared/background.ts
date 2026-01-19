import type {DownloadMessage} from '../types'

chrome.runtime.onMessage.addListener(async (request: DownloadMessage) => {
    if (request.action === 'download') {
        await chrome.downloads.download({url: request.url, filename: request.filename})
    }
})
