import { describe, expect, mock, test } from 'bun:test';
import type { PanelSettings } from '../src/types/settings';

mock.module('cloudflare:sockets', () => ({
    connect: () => {
        throw new Error('socket probe should not run in this test');
    }
}));
Object.assign(globalThis, { VERSION: 'test' });

const FAKE_SETTINGS = {
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
    dohUrl: '',
    mainDomain: 'example.com'
};

function stubEnv(): Env {
    return { kv: { async get() { return null; }, async put() { } } } as unknown as Env;
}

// Populates globalSettings (ports, hostname, ...) exactly like a real request.
async function initGlobals() {
    const { init } = await import('../src/settings/settings');
    Object.assign(globalThis, { EMBEDED_SETTINGS: FAKE_SETTINGS });
    init(new Request('https://example.com/preview/panel'), {} as Env);
}

describe('clean IP entry parsing', () => {
    test('splits host, optional port, and # name with trimming', async () => {
        const { splitIpAndName } = await import('../src/cores/naming');

        expect(splitIpAndName('143.112.242.123')).toEqual({ host: '143.112.242.123', name: '' });
        expect(splitIpAndName(' 143.112.242.123 # Fast-Direct ')).toEqual({ host: '143.112.242.123', name: 'Fast-Direct' });
        expect(splitIpAndName('104.16.1.1:443#Cloudflare-DE')).toEqual({ host: '104.16.1.1', name: 'Cloudflare-DE' });
        expect(splitIpAndName('[2606:4700::1]:443#Tunnel')).toEqual({ host: '[2606:4700::1]', name: 'Tunnel' });
        expect(splitIpAndName('[2606:4700::1]#Tunnel')).toEqual({ host: '[2606:4700::1]', name: 'Tunnel' });
        // A bare IPv6 literal must keep its colons.
        expect(splitIpAndName('2606:4700::1')).toEqual({ host: '2606:4700::1', name: '' });
        expect(splitIpAndName('www.speedtest.net#Fast')).toEqual({ host: 'www.speedtest.net', name: 'Fast' });
        // A bare `# Name` keeps the (empty) host so validation can report it.
        expect(splitIpAndName('# Only a name')).toEqual({ host: '', name: 'Only a name' });
    });

    test('treats whitespace-only and empty names as unnamed', async () => {
        const { splitIpAndName } = await import('../src/cores/naming');

        expect(splitIpAndName('1.2.3.4#   ')).toEqual({ host: '1.2.3.4', name: '' });
        expect(splitIpAndName('1.2.3.4#')).toEqual({ host: '1.2.3.4', name: '' });
        expect(splitIpAndName('')).toEqual({ host: '', name: '' });
        expect(splitIpAndName('   ')).toEqual({ host: '', name: '' });
    });

    test('keeps everything after the first # as the name, verbatim', async () => {
        const { splitIpAndName } = await import('../src/cores/naming');

        expect(splitIpAndName('1.2.3.4#Fast#Direct')).toEqual({ host: '1.2.3.4', name: 'Fast#Direct' });
        // Case and Unicode are preserved.
        expect(splitIpAndName('EXAMPLE.com#X')).toEqual({ host: 'EXAMPLE.com', name: 'X' });
        expect(splitIpAndName('1.2.3.4#\u{1F1E9}\u{1F1EA} Frankfurt')).toEqual({ host: '1.2.3.4', name: '\u{1F1E9}\u{1F1EA} Frankfurt' });
    });

    test('strips any trailing numeric port, even an out-of-range one', async () => {
        const { splitIpAndName } = await import('../src/cores/naming');

        // Resilient over strict: configs dial every selected TLS port anyway,
        // so the suffix is informational and never forwarded.
        expect(splitIpAndName('1.2.3.4:99999#X').host).toBe('1.2.3.4');
        expect(splitIpAndName('1.2.3.4:#X')).toEqual({ host: '1.2.3.4:', name: 'X' });
        // A value that is only a port has no host to strip into.
        expect(splitIpAndName(':443').host).toBe(':443');
    });

    test('dial addresses derived from clean IPs never carry the dropped port', async () => {
        const { cleanIpHost } = await import('../src/cores/naming');

        expect(cleanIpHost('104.16.1.1:443#Cloudflare-DE')).toBe('104.16.1.1');
        expect(cleanIpHost('[2606:4700::1]:8443#Tunnel')).toBe('[2606:4700::1]');
        expect(cleanIpHost('[::ffff:1.2.3.4]:2053#Nat64')).toBe('[::ffff:1.2.3.4]');
        // Legacy forms are untouched.
        expect(cleanIpHost('143.112.242.123')).toBe('143.112.242.123');
        expect(cleanIpHost('2606:4700::1')).toBe('2606:4700::1');
        expect(cleanIpHost('EXAMPLE.com#X')).toBe('EXAMPLE.com');
    });
});

describe('clean IP validation', () => {
    test('accepts host:port and named entries', async () => {
        await initGlobals();
        const { validateSettings } = await import('../src/settings/validators');
        const defaults = (await import('../src/settings/settings')).getKvSettings();

        const errors = validateSettings({
            ...defaults,
            ...FAKE_SETTINGS,
            ports: [443],
            cleanIPs: ['104.16.1.1:443#Cloudflare-DE', '143.112.242.123#Fast-Direct', '[2606:4700::1]#Tunnel']
        } as unknown as PanelSettings);

        expect(errors).toBeNull();
    });

    test('rejects empty hosts and garbage hosts after splitting', async () => {
        await initGlobals();
        const { validateSettings } = await import('../src/settings/validators');
        const defaults = (await import('../src/settings/settings')).getKvSettings();

        const errors = validateSettings({
            ...defaults,
            ...FAKE_SETTINGS,
            ports: [443],
            cleanIPs: ['#Only a name', 'not_a_host#Bad', '1.2.3.4.5#Bad']
        } as unknown as PanelSettings);

        expect(errors).not.toBeNull();
        const cleanIpError = errors!.find(error => error.field === 'Clean IPs - Domains');
        expect(cleanIpError).toBeDefined();
        const joined = cleanIpError!.message.join('\n');
        expect(joined).toContain('(empty host)');
        expect(joined).toContain('not_a_host');
        expect(joined).toContain('1.2.3.4.5');
    });

    test('rejects a bare port-only entry', async () => {
        await initGlobals();
        const { validateSettings } = await import('../src/settings/validators');
        const defaults = (await import('../src/settings/settings')).getKvSettings();

        const errors = validateSettings({
            ...defaults,
            ...FAKE_SETTINGS,
            ports: [443],
            cleanIPs: [':443']
        } as unknown as PanelSettings);

        expect(errors).not.toBeNull();
        expect(errors!.some(error => error.field === 'Clean IPs - Domains')).toBe(true);
    });
});

describe('classic remarks with custom names', () => {
    test('shows a custom name in place of the generic type and keeps legacy naming', async () => {
        await initGlobals();
        const { generateRemark } = await import('../src/cores/utils');
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);

        try {
            settings.cleanIPs = ['143.112.242.123#Fast-Direct', '203.0.113.7'];

            const named = await generateRemark(stubEnv(), 1, 443, '143.112.242.123', 'vless', 'example.com', false, false);
            expect(named).toBe('💦 1. VLESS - Fast-Direct : 443');

            // Legacy entries without `#` keep the default formatting.
            const unnamed = await generateRemark(stubEnv(), 2, 443, '203.0.113.7', 'vless', 'example.com', false, false);
            expect(unnamed).toBe('💦 2. VLESS - Clean IP : 443');

            const domain = await generateRemark(stubEnv(), 3, 443, 'www.speedtest.net', 'trojan', 'example.com', false, false);
            expect(domain).toBe('💦 3. Trojan - Domain : 443');
        } finally {
            Object.assign(settings, original);
        }
    });

    test('matches bracketed IPv6 entries regardless of bracket form', async () => {
        await initGlobals();
        const { generateRemark } = await import('../src/cores/utils');
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);

        try {
            settings.cleanIPs = ['[2606:4700::1]#Tunnel'];
            const named = await generateRemark(stubEnv(), 1, 443, '[2606:4700::1]', 'vless', 'example.com', false, false);
            expect(named).toBe('💦 1. VLESS - Tunnel : 443');

            // Same host written without brackets still resolves the label.
            settings.cleanIPs = ['2606:4700::1#Tunnel'];
            const unbracketed = await generateRemark(stubEnv(), 1, 443, '[2606:4700::1]', 'vless', 'example.com', false, false);
            expect(unbracketed).toBe('💦 1. VLESS - Tunnel : 443');
        } finally {
            Object.assign(settings, original);
        }
    });

    test('composes fragment, CDN markers, chain sign, and non-default ports', async () => {
        await initGlobals();
        const { generateRemark } = await import('../src/cores/utils');
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);

        try {
            settings.cleanIPs = ['104.16.1.1#Fast'];
            settings.customCdnAddrs = ['104.16.1.1'];

            const marked = await generateRemark(stubEnv(), 1, 8443, '104.16.1.1', 'vless', 'example.com', true, true);
            expect(marked).toBe('💦 1. 🔗 VLESS F C - Fast : 8443');

            const plainPort = await generateRemark(stubEnv(), 2, 2053, '104.16.1.1', 'trojan', 'example.com', false, false);
            expect(plainPort).toBe('💦 2. Trojan C - Fast : 2053');
        } finally {
            Object.assign(settings, original);
        }
    });

    test('upstream label takes precedence over a custom name', async () => {
        await initGlobals();
        const { generateRemark } = await import('../src/cores/utils');
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);

        try {
            settings.upstreamParams = { upstreamServer: '1.2.3.4', upstreamPort: 443 };
            settings.cleanIPs = ['1.2.3.4#Fast'];

            const upstream = await generateRemark(stubEnv(), 1, 443, '1.2.3.4', 'vless', 'example.com', false, true);
            expect(upstream).toBe('💦 1. 🔗 VLESS - Upstream Proxy');
        } finally {
            Object.assign(settings, original);
        }
    });

    test('duplicate hosts resolve deterministically to the last label', async () => {
        await initGlobals();
        const { generateRemark } = await import('../src/cores/utils');
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);

        try {
            settings.cleanIPs = ['1.2.3.4#First', '1.2.3.4#Second'];
            const named = await generateRemark(stubEnv(), 1, 443, '1.2.3.4', 'vless', 'example.com', false, false);
            expect(named).toBe('💦 1. VLESS - Second : 443');
        } finally {
            Object.assign(settings, original);
        }
    });

    test('Unicode names survive into the remark', async () => {
        await initGlobals();
        const { generateRemark } = await import('../src/cores/utils');
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);

        try {
            settings.cleanIPs = ['5.6.7.8#\u{1F1E9}\u{1F1EA} Frankfurt'];
            const named = await generateRemark(stubEnv(), 4, 443, '5.6.7.8', 'vless', 'example.com', false, false);
            expect(named).toBe(`💦 4. VLESS - \u{1F1E9}\u{1F1EA} Frankfurt : 443`);
        } finally {
            Object.assign(settings, original);
        }
    });
});

describe('template names with {IPNAME}', () => {
    test('feeds the token when set and degrades like other unavailable tokens', async () => {
        await initGlobals();
        const { generateRemark } = await import('../src/cores/utils');
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);

        try {
            // Bare {IPNAME}: absent names render the engine's generic `--`
            // marker, exactly like any other unavailable token ({CITY}, ...).
            settings.nameTemplate = '{PROTO} {IPNAME} [[ - {IP} ]]';
            settings.cleanIPs = ['143.112.242.123#Fast-Direct', '203.0.113.7'];

            const named = await generateRemark(stubEnv(), 1, 443, '143.112.242.123', 'vless', 'example.com', false, false);
            expect(named).toBe('VLESS Fast-Direct - 143.112.242.123');

            const unnamed = await generateRemark(stubEnv(), 1, 443, '203.0.113.7', 'vless', 'example.com', false, false);
            expect(unnamed).toBe('VLESS -- - 203.0.113.7');

            // Recommended authoring pattern wraps it in an optional section so
            // unnamed addresses omit the label entirely.
            settings.nameTemplate = '{PROTO} [[ {IPNAME} - ]] {IP}';
            const wrappedNamed = await generateRemark(stubEnv(), 1, 443, '143.112.242.123', 'vless', 'example.com', false, false);
            expect(wrappedNamed).toContain('Fast-Direct');
            expect(wrappedNamed).not.toContain('--');

            const wrappedUnnamed = await generateRemark(stubEnv(), 1, 443, '203.0.113.7', 'vless', 'example.com', false, false);
            expect(wrappedUnnamed).not.toContain('Fast-Direct');
            expect(wrappedUnnamed).not.toContain('--');
        } finally {
            Object.assign(settings, original);
        }
    });

    test('keeps identical custom names unique across different hosts', async () => {
        await initGlobals();
        const { generateRemark } = await import('../src/cores/utils');
        const { createNameRegistry } = await import('../src/cores/naming');
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);

        try {
            settings.nameTemplate = '{IPNAME}';
            settings.cleanIPs = ['1.1.1.1#Same', '2.2.2.2#Same'];
            const registry = createNameRegistry();

            const first = await generateRemark(stubEnv(), 1, 443, '1.1.1.1', 'vless', 'example.com', false, false, '', registry);
            const second = await generateRemark(stubEnv(), 2, 443, '2.2.2.2', 'vless', 'example.com', false, false, '', registry);

            expect(first).toBe('Same');
            expect(second).not.toBe(first);
            expect(second.startsWith('Same')).toBe(true);
        } finally {
            Object.assign(settings, original);
        }
    });

    test('aggregate Best-Ping naming ignores per-address labels by design', async () => {
        await initGlobals();
        const { getConfiguredNameWithMetadata } = await import('../src/cores/utils');
        const { getKvSettings } = await import('../src/settings/settings');
        const settings = getKvSettings();
        const original = structuredClone(settings);

        try {
            settings.nameTemplate = '';
            settings.cleanIPs = ['1.1.1.1#Fast'];
            const fallback = '💦 Best Ping 🚀';
            const name = await getConfiguredNameWithMetadata(stubEnv(), fallback, {
                index: 1,
                address: '1.1.1.1',
                proto: 'Best Ping',
                kind: 'Best Ping',
                core: 'xray'
            });
            expect(name).toBe(fallback);
        } finally {
            Object.assign(settings, original);
        }
    });
});
