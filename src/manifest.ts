export default {
    manifest_version: 3,
    name: 'ig_helper',
    version: '0.1.0',
    description: 'instagram 运营助手',
    permissions: ['scripting', 'downloads'],
    host_permissions: ['*://*.instagram.com/*'],
    background: {service_worker: 'background.js'},
    content_scripts: [
        {
            matches: ['*://*.instagram.com/*'],
            js: ['content.js'],
            run_at: 'document_idle'
        }
    ],
    web_accessible_resources: []
}
