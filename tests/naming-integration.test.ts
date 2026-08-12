import { describe, expect, mock, test } from 'bun:test';

mock.module('cloudflare:sockets', () => ({
    connect: () => {
        throw new Error('socket probe should not run in this test');
    }
}));
Object.assign(globalThis, { VERSION: 'test' });

describe('config-name snapshot integration', () => {
    test('keeps latency records separated by endpoint port', async () => {
        const { getLatencyRecord, setLatency } = await import('../src/cores/latency');
        const values = new Map<string, string>();
        const env = {
            kv: {
                async get(key: string) {
                    const value = values.get(key);
                    return value ? JSON.parse(value) : null;
                },
                async put(key: string, value: string) {
                    values.set(key, value);
                }
            }
        } as unknown as Env;

        await setLatency(env, '1.1.1.1', 80, 8080);
        expect(await getLatencyRecord(env, '1.1.1.1', 8080)).toMatchObject({ ms: 80, port: 8080 });
        expect(await getLatencyRecord(env, '1.1.1.1', 443)).toBeNull();
    });

    test('reuses a frozen name from fake KV and avoids a second write', async () => {
        const { getConfiguredNameWithMetadata } = await import('../src/cores/utils');
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);
        const values = new Map<string, string>();
        let writes = 0;
        const env = {
            kv: {
                async get(key: string) {
                    return values.get(key) ?? null;
                },
                async put(key: string, value: string) {
                    writes++;
                    values.set(key, value);
                }
            }
        } as unknown as Env;

        Object.assign(settings, {
            nameTemplate: '{COUNTRY}',
            nameTemplateVersion: 4,
            nameFormat: 'readable',
            nameMaxLength: 0,
            nameFreezeGeo: true,
            nameGeoMode: 'local',
            nameAddressGroups: [],
            latencyAutoTest: false,
            proxyIpMode: 'off',
            proxyIPs: []
        });

        try {
            const context = {
                index: 1,
                address: 'Example.COM.',
                port: 443,
                proto: 'VLESS',
                geo: {
                    ip: '203.0.113.10',
                    countryCode: 'DE',
                    country: 'Germany',
                    cachedAt: Date.now()
                },
                kind: 'Normal',
                core: 'xray'
            };
            const first = await getConfiguredNameWithMetadata(env, 'classic', context);
            const second = await getConfiguredNameWithMetadata(env, 'classic', context);

            expect(first).toBe(second);
            expect(writes).toBe(1);
            expect(values.size).toBe(1);
        } finally {
            Object.assign(settings, original);
        }
    });

    test('freezes explicit egress-address names, not only country names', async () => {
        const { getConfiguredNameWithMetadata } = await import('../src/cores/utils');
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);
        const values = new Map<string, string>();
        let writes = 0;
        const env = {
            kv: {
                async get(key: string) {
                    return values.get(key) ?? null;
                },
                async put(key: string, value: string) {
                    writes++;
                    values.set(key, value);
                }
            }
        } as unknown as Env;

        Object.assign(settings, {
            nameTemplate: '{EGRESS_IP}',
            nameTemplateVersion: 5,
            nameFormat: 'readable',
            nameMaxLength: 0,
            nameFreezeGeo: true,
            nameGeoMode: 'local',
            nameAddressGroups: [],
            latencyAutoTest: false,
            proxyIpMode: 'off',
            proxyIPs: []
        });

        try {
            const first = await getConfiguredNameWithMetadata(env, 'classic', {
                index: 1,
                address: 'example.com',
                port: 443,
                egressIp: '203.0.113.10',
                geoSource: 'egress',
                geo: { ip: '203.0.113.10', countryCode: 'DE', country: 'Germany', cachedAt: Date.now() },
                proto: 'VLESS',
                kind: 'Normal',
                core: 'xray'
            });
            const second = await getConfiguredNameWithMetadata(env, 'classic', {
                index: 1,
                address: 'example.com',
                port: 443,
                egressIp: '198.51.100.20',
                geoSource: 'egress',
                geo: { ip: '198.51.100.20', countryCode: 'US', country: 'United States', cachedAt: Date.now() },
                proto: 'VLESS',
                kind: 'Normal',
                core: 'xray'
            });

            expect(first).toStartWith('203.0.113.10');
            expect(second).toBe(first);
            expect(writes).toBe(1);
        } finally {
            Object.assign(settings, original);
        }
    });

    test('disables future or invalid template versions during settings normalization', async () => {
        const { getDataset } = await import('../src/settings/kv');
        const { getKvSettings } = await import('../src/settings/settings');
        const defaults = getKvSettings();
        const writes: Array<{ key: string; value: string }> = [];
        const env = {
            kv: {
                async get(key: string) {
                    if (key === 'proxySettings') return {
                        ...defaults,
                        nameTemplate: '{IP}',
                        nameTemplateVersion: 999,
                        nameFormat: 'future-mode',
                        nameGeoMode: 'future-mode',
                        nameAddressGroups: ['Fast: 1.1.1.1', 42],
                        latencyIntervalMin: 1
                    };
                    if (key === 'warpAccounts') return [];
                    if (key === 'telegramBot') return { telegramBotToken: '', telegramUserId: '' };
                    return null;
                },
                async put(key: string, value: string) {
                    writes.push({ key, value });
                }
            }
        } as unknown as Env;

        const settings = await getDataset(env);
        expect(settings.settings.nameTemplate).toBe('');
        expect(settings.settings.nameTemplateVersion).toBe(5);
        expect(settings.settings.nameFormat).toBe('readable');
        expect(settings.settings.nameGeoMode).toBe('auto');
        expect(settings.settings.nameAddressGroups).toEqual(['Fast: 1.1.1.1']);
        expect(settings.settings.latencyIntervalMin).toBe(defaults.latencyIntervalMin);
        expect(writes.some(write => write.key === 'proxySettings')).toBe(true);
    });

    test('accepts bare IPv6 address groups and rejects unsafe group labels', async () => {
        const { validateSettings } = await import('../src/settings/validators');
        const { getKvSettings, init } = await import('../src/settings/settings');
        const originalEmbedded = globalThis.EMBEDED_SETTINGS;
        const embedded = {
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
        };
        globalThis.EMBEDED_SETTINGS = embedded;
        init(new Request('https://example.com/preview/panel'), {} as Env);

        try {
            const base = { ...getKvSettings(), ...embedded };
            const valid = validateSettings({
                ...base,
                nameAddressGroups: ['Fast:', '2606:4700::1111']
            } as never);
            expect(valid).toBeNull();

            const invalid = validateSettings({
                ...base,
                nameAddressGroups: [`Fast${String.fromCodePoint(0x202e)}: 1.1.1.1`]
            } as never);
            expect(invalid?.some(error => error.field === 'Config Name Address Groups'
                && error.message.some(message => message.includes('invisible')))).toBe(true);
        } finally {
            if (originalEmbedded === undefined) {
                delete globalThis.EMBEDED_SETTINGS;
            } else {
                globalThis.EMBEDED_SETTINGS = originalEmbedded;
            }
        }
    });

    test('renames imported Raw URIs without rewriting their payload', async () => {
        const { getURLConfigs } = await import('../src/cores/common');
        const { getKvSettings, init } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);
        const originalFetch = globalThis.fetch;
        const imported = 'vmess://AbCdEf0123#Old%20name';

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
            nameTemplate: '[{KIND}] {PROTO} {IPNAME}',
            nameTemplateVersion: 5,
            nameFormat: 'readable',
            nameMaxLength: 0,
            nameFreezeGeo: false,
            nameGeoMode: 'disabled',
            nameAddressGroups: [],
            latencyAutoTest: false,
            protocols: 'vless',
            ports: [443],
            cleanIPs: [],
            customCdnAddrs: [],
            customDomain: '',
            customConfigs: [imported],
            customSubs: [],
            chainProxy: '',
            upstreamParams: { upstreamServer: '', upstreamPort: 0 }
        });
        globalThis.fetch = (async () => new Response(JSON.stringify({ Answer: [] }))) as typeof fetch;

        try {
            const response = await getURLConfigs({} as Env);
            const decoded = atob(await response.text());
            expect(decoded).toContain('vmess://AbCdEf0123#%5BImported%5D%20VMESS%20Old%20name');
            expect(decoded).not.toContain('vmess://AbCdEf0123#Old%20name');
        } finally {
            globalThis.fetch = originalFetch;
            Object.assign(settings, original);
        }
    });

    test('keeps normal output identifiers aligned across cores', async () => {
        const { getXrCustomConfigs } = await import('../src/cores/xray/configs');
        const { getSbCustomConfig } = await import('../src/cores/sing-box/configs');
        const { getClNormalConfig } = await import('../src/cores/clash/configs');
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);
        const originalFetch = globalThis.fetch;
        const env = {
            kv: {
                async get() { return null; },
                async put() { return undefined; }
            }
        } as unknown as Env;

        Object.assign(settings, {
            nameTemplate: '{KIND} {PROTO} {IP}:{PORT}',
            nameTemplateVersion: 5,
            nameFormat: 'readable',
            nameMaxLength: 0,
            nameFreezeGeo: false,
            nameGeoMode: 'disabled',
            nameAddressGroups: [],
            latencyAutoTest: false,
            protocols: 'vless',
            ports: [443],
            cleanIPs: [],
            customCdnAddrs: [],
            customDomain: '',
            customConfigs: [],
            customSubs: [],
            chainProxy: '',
            upstreamParams: { upstreamServer: '', upstreamPort: 0 }
        });
        globalThis.fetch = (async () => new Response(JSON.stringify({ Answer: [] }))) as typeof fetch;

        try {
            const xray = JSON.parse(await (await getXrCustomConfigs(false, env)).text()) as Array<{ remarks: string }>;
            const xrayNames = xray.map(config => config.remarks);
            expect(new Set(xrayNames).size).toBe(xrayNames.length);
            expect(xrayNames.some(name => name.includes('Best Ping'))).toBe(true);

            const singBox = JSON.parse(await (await getSbCustomConfig(false, env)).text()) as { outbounds: Array<{ tag?: string }> };
            const singBoxTags = singBox.outbounds.map(outbound => outbound.tag).filter((tag): tag is string => Boolean(tag));
            expect(new Set(singBoxTags).size).toBe(singBoxTags.length);
            expect(singBoxTags.some(tag => tag.includes('Normal'))).toBe(true);

            const clash = JSON.parse(await (await getClNormalConfig(env)).text()) as {
                proxies: Array<{ name?: string }>;
                'proxy-groups': Array<{ name?: string }>;
            };
            const clashNames = [
                ...clash.proxies.map(proxy => proxy.name),
                ...clash['proxy-groups'].map(group => group.name)
            ].filter((name): name is string => Boolean(name));
            expect(new Set(clashNames).size).toBe(clashNames.length);
            expect(clashNames.some(name => name.includes('Normal'))).toBe(true);
        } finally {
            globalThis.fetch = originalFetch;
            Object.assign(settings, original);
        }
    });

    test('keeps generated names unique across Warp, Best Ping, and ZIP fixtures', async () => {
        const { getXrWarpConfigs } = await import('../src/cores/xray/configs');
        const { getSbWarpConfig } = await import('../src/cores/sing-box/configs');
        const { getClWarpConfig } = await import('../src/cores/clash/configs');
        const { getWireguardConfigs } = await import('../src/cores/wireguard');
        const JSZip = (await import('jszip')).default;
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);
        const env = {
            kv: {
                async get() { return null; },
                async put() { return undefined; }
            }
        } as unknown as Env;

        Object.assign(settings, {
            nameTemplate: '{KIND} {PROTO} {IP}:{PORT}',
            nameTemplateVersion: 5,
            nameFormat: 'readable',
            nameMaxLength: 0,
            nameFreezeGeo: false,
            nameGeoMode: 'disabled',
            nameAddressGroups: [],
            latencyAutoTest: false,
            warpEndpoints: ['engage.cloudflareclient.com:2408']
        });

        try {
            const xray = JSON.parse(await (await getXrWarpConfigs(false, false, env)).text()) as Array<{ remarks: string }>;
            const xrayNames = xray.map(config => config.remarks);
            expect(new Set(xrayNames).size).toBe(xrayNames.length);
            expect(xrayNames.some(name => name.includes('Warp'))).toBe(true);

            const singBox = JSON.parse(await (await getSbWarpConfig(env)).text()) as { outbounds: Array<{ tag?: string }> };
            const singBoxTags = singBox.outbounds.map(outbound => outbound.tag).filter((tag): tag is string => Boolean(tag));
            expect(new Set(singBoxTags).size).toBe(singBoxTags.length);

            const clash = JSON.parse(await (await getClWarpConfig(false, env)).text()) as {
                proxies: Array<{ name?: string }>;
                'proxy-groups': Array<{ name?: string }>;
            };
            const clashNames = [
                ...clash.proxies.map(proxy => proxy.name),
                ...clash['proxy-groups'].map(group => group.name)
            ].filter((name): name is string => Boolean(name));
            expect(new Set(clashNames).size).toBe(clashNames.length);

            const wireguardResponse = await getWireguardConfigs(false, env);
            const zip = await JSZip.loadAsync(await wireguardResponse.arrayBuffer());
            const files = Object.keys(zip.files);
            expect(files).toHaveLength(1);
            expect(files[0]).toMatch(/\.conf$/u);
            expect(files[0]).not.toMatch(/[\\/:*?"<>|]/u);

            const amneziaResponse = await getWireguardConfigs(true, env);
            const amneziaZip = await JSZip.loadAsync(await amneziaResponse.arrayBuffer());
            const amneziaFiles = Object.keys(amneziaZip.files);
            expect(amneziaFiles).toHaveLength(1);
            expect(amneziaFiles[0]).toMatch(/\.conf$/u);
            expect(amneziaFiles[0]).not.toMatch(/[\\/:*?"<>|]/u);
        } finally {
            Object.assign(settings, original);
        }
    });
});
