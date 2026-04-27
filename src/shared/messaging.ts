function checkChromeRuntime(): boolean {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        console.error('[Extension] chrome.runtime not available')
        return false
    }
    return true
}

export async function safeSendMessage<T>(message: object): Promise<T | null> {
    if (!checkChromeRuntime()) {
        throw new Error('Extension context invalidated. Please refresh the page.')
    }

    try {
        return await chrome.runtime.sendMessage(message) as T
    } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error)
        if (messageText.includes('Extension context invalidated') || messageText.includes('Could not establish connection')) {
            throw new Error('Extension context invalidated. Please refresh the page.')
        }
        throw error
    }
}
