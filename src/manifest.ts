export default {
    manifest_version: 3,
    name: 'ig_helper',
    version: '0.7.2',
    description: 'instagram 运营助手',
    permissions: [
        'scripting',
        'downloads',
        'webRequest',
        'cookies',
        'storage',
        'tabs',
        'activeTab'
    ],
    host_permissions: [
        '*://*.instagram.com/*',
        '*://*.cdninstagram.com/*',
        '*://*.fbcdn.net/*',
        '*://lookaside.fbsbx.com/*',
        '*://*.tiktok.com/*',
        '*://*.tiktokcdn.com/*',
        '*://*.tiktokcdn-us.com/*',
        '*://*.tiktokv.com/*',
        '*://*.noxinfluencer.com/*'
    ],
    background: {service_worker: 'background.js'},
    content_scripts: [
        {
            matches: ['*://*.instagram.com/*', '*://*.tiktok.com/*', '*://*.noxinfluencer.com/*'],
            js: ['content.js'],
            run_at: 'document_idle'
        }
    ],
    web_accessible_resources: [
        {
            resources: ['page-bridge.js'],
            matches: ['*://*.tiktok.com/*']
        }
    ]
}
