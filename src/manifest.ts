export default {
    manifest_version: 3,
    name: 'ig_helper',
    version: '0.2.1',
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
        '*://*.tiktok.com/*',
        '*://*.tiktokcdn.com/*',
        '*://*.tiktokcdn-us.com/*',
        '*://*.tiktokv.com/*'
    ],
    background: {service_worker: 'background.js'},
    content_scripts: [
        {
            matches: ['*://*.instagram.com/*', '*://*.tiktok.com/*'],
            js: ['content.js'],
            run_at: 'document_idle'
        }
    ],
    web_accessible_resources: []
}
