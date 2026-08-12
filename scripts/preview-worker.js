const MOCK_SETTINGS = {
    accID: 'local-preview',
    accEmail: 'preview@example.invalid',
    apiToken: '',
    vlUUID: '00000000-0000-4000-8000-000000000001',
    trPass: 'preview-only-password',
    securePath: 'preview',
    proxyIpMode: 'proxyip',
    proxyIPs: [],
    prefixes: [],
    fallback: '',
    dohUrl: 'https://cloudflare-dns.com/dns-query',
    mainDomain: 'example.com'
};

// The real Worker expects a Cloudflare KV binding. Keep preview state local to
// this Wrangler process so the UI can be explored without a Cloudflare account.
const values = new Map([
    // Avoid the Warp account registration request during a mock preview.
    ['warpAccounts', '[]']
]);

const wantsJson = (options) => options === 'json' || options?.type === 'json';

const mockKv = {
    async get(key, options) {
        const value = values.get(String(key));
        if (value === undefined) return null;
        return wantsJson(options) ? JSON.parse(value) : value;
    },

    async put(key, value) {
        values.set(String(key), String(value));
    },

    async delete(key) {
        values.delete(String(key));
    },

    async list(options = {}) {
        const prefix = options.prefix ?? '';
        const keys = [...values.keys()]
            .filter(key => key.startsWith(prefix))
            .map(name => ({ name }));
        return { keys, list_complete: true, cursor: '' };
    }
};

// The production bundle normally receives this global from BPB Wizard. This
// adapter intentionally supplies placeholders only for local UI exploration.
Object.assign(globalThis, { EMBEDED_SETTINGS: MOCK_SETTINGS });

const workerModule = await import('../dist/worker.js');
const worker = workerModule.default;

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Make the preview URL immediately useful: opening its root redirects
        // to the panel so relative API URLs resolve below /preview/panel.
        if (url.pathname === '/' && request.method === 'GET') {
            const panelUrl = new URL('/preview/panel', request.url);
            panelUrl.search = url.search;
            return Response.redirect(panelUrl, 302);
        }

        // Do not allow legacy Wizard bindings from the host to trip the guard in
        // this deliberately local-only adapter.
        const { UUID: _legacyUuid, TR_PASS: _legacyPassword, ...safeEnv } = env;
        return worker.fetch(request, { ...safeEnv, kv: mockKv }, ctx);
    }
};
