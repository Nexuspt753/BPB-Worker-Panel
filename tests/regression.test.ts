import { describe, expect, mock, test } from 'bun:test';

mock.module('cloudflare:sockets', () => ({
    connect: () => {
        throw new Error('socket probe should not run in regression tests');
    }
}));
Object.assign(globalThis, { VERSION: 'test' });

describe('technical report regression fixes', () => {
    test('preserves user settings across a panel version bump', async () => {
        const { getDataset } = await import('../src/settings/kv');
        const { getKvSettings } = await import('../src/settings/settings');
        const defaults = getKvSettings();
        const writes: Array<{ key: string; value: string }> = [];
        const usableWarp = [
            { privateKey: 'a', publicKey: 'b', warpIPv6: '2606:4700::1', reserved: 'r1' },
            { privateKey: 'c', publicKey: 'd', warpIPv6: '2606:4700::2', reserved: 'r2' }
        ];
        const env = {
            kv: {
                async get(key: string) {
                    if (key === 'proxySettings') {
                        return {
                            ...defaults,
                            ports: [8443],
                            cleanIPs: ['203.0.113.7'],
                            customCdnHost: 'cdn.example.com',
                            panelVersion: '5.0.0'
                        };
                    }
                    if (key === 'warpAccounts') return usableWarp;
                    if (key === 'telegramBot') return { telegramBotToken: '', telegramUserId: '' };
                    return null;
                },
                async put(key: string, value: string) {
                    writes.push({ key, value });
                }
            }
        } as unknown as Env;

        const dataset = await getDataset(env);

        expect(dataset.settings.ports).toEqual([8443]);
        expect(dataset.settings.cleanIPs).toEqual(['203.0.113.7']);
        expect(dataset.settings.customCdnHost).toBe('cdn.example.com');
        expect(dataset.settings.panelVersion).toBe('test');

        const persisted = writes.find(write => write.key === 'proxySettings');
        expect(persisted).toBeDefined();
        const saved = JSON.parse(persisted!.value) as { ports: number[]; cleanIPs: string[] };
        expect(saved.ports).toEqual([8443]);
        expect(saved.cleanIPs).toEqual(['203.0.113.7']);
    });

    test('share-settings payload excludes proxy credentials', async () => {
        const { getSharedSettings, getKvSettings, init } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);

        Object.assign(globalThis, {
            EMBEDED_SETTINGS: {
                accID: 'test',
                accEmail: 'test@example.invalid',
                apiToken: '',
                vlUUID: '00000000-0000-4000-8000-000000000001',
                trPass: 'test-password',
                securePath: 'preview',
                proxyIpMode: 'off',
                proxyIPs: [],
                prefixes: [],
                fallback: '',
                dohUrl: 'https://dns.example.invalid/dns-query',
                mainDomain: 'example.com'
            }
        });
        init(new Request('https://example.com/preview/panel'), {} as Env);

        Object.assign(settings, {
            chainProxy: 'socks5://user:pass@proxy.example:1080',
            chainProxyParams: { user: 'user', pass: 'pass' },
            upstreamProxy: 'proxy.example:8080',
            upstreamParams: { upstreamServer: 'proxy.example', upstreamPort: 8080 }
        });

        try {
            const shared = getSharedSettings();
            expect(shared).not.toHaveProperty('chainProxy');
            expect(shared).not.toHaveProperty('chainProxyParams');
            expect(shared).not.toHaveProperty('upstreamProxy');
            expect(shared).not.toHaveProperty('upstreamParams');
            expect(shared).not.toHaveProperty('remoteSettings');
            expect(shared).not.toHaveProperty('customDomain');
            expect(shared).not.toHaveProperty('panelVersion');
            expect(shared).toHaveProperty('ports');
        } finally {
            Object.assign(settings, original);
        }
    });
});
