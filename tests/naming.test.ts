import { describe, expect, test } from 'bun:test';
import {
    buildNamePreview,
    createNameRegistry,
    formatName,
    getNameTemplateDiagnostics,
    isValidNameTemplate,
    migrateNameTemplate,
    normalizeAddress,
    parseAddressGroups,
    renderName,
    registerFallbackName,
    stableNameSuffix,
    truncateName,
    uniquifyName
} from '../src/cores/naming';
import { resolveGeo } from '../src/cores/geo';

describe('config-name templates', () => {
    test('rejects malformed and unknown syntax without partial rendering', () => {
        for (const template of ['{{IP}COUNTRY}', '{IP', 'IP}', '{}', '[[{IP}']) {
            expect(isValidNameTemplate(template)).toBe(false);
            expect(getNameTemplateDiagnostics(template).length).toBeGreaterThan(0);
        }
        expect(getNameTemplateDiagnostics('{UNKNOWN}')[0]?.code).toBe('unknown-token');

        expect(renderName('{{IP}COUNTRY}', { index: 1, address: '1.1.1.1' })).toBe('');
        expect(getNameTemplateDiagnostics('{IP}{COUNTRY}')).toHaveLength(0);
    });

    test('omits optional sections only when their tokens have no value', () => {
        expect(renderName('{IP}[[ - {IPNAME}]]', {
            index: 1,
            address: '1.1.1.1'
        })).toBe('1.1.1.1');
        expect(renderName('{IP}[[ - {IPNAME}]]', {
            index: 1,
            address: '1.1.1.1',
            customName: 'Fast edge'
        })).toBe('1.1.1.1 - Fast edge');
    });

    test('migrates old token casing while preserving user text', () => {
        expect(migrateNameTemplate('edge-{flag}-{country}', 1)).toBe('edge-{FLAG}-{COUNTRY}');
        expect(migrateNameTemplate('edge-{flag}', 3)).toBe('edge-{flag}');
    });

    test('truncates by grapheme cluster and keeps format modes predictable', () => {
        expect(truncateName('🇩🇪éxample', 2)).toBe('🇩🇪é');
        expect(formatName('  A   |   B  ', { mode: 'compact' })).toBe('A|B');
        expect(formatName('Café 🚀', { mode: 'ascii' })).toBe('Cafe');
    });

    test('uses stable identity suffixes rather than list order', () => {
        const first = { index: 1, address: '1.1.1.1', port: 443, proto: 'VLESS', kind: 'Normal' };
        const reordered = { ...first, index: 99 };
        expect(stableNameSuffix(first)).toBe(stableNameSuffix(reordered));
        expect(uniquifyName('Germany', '{COUNTRY}', first)).toContain(stableNameSuffix(first));

        const registry = createNameRegistry();
        const one = uniquifyName('same', '{IP}', { ...first, registry });
        const two = uniquifyName('same', '{IP}', { ...first, index: 2, registry });
        expect(one).not.toBe(two);
        expect(two).toContain('-2');

        const explicitA = { ...first, identity: 'credentials-a' };
        const explicitB = { ...first, identity: 'credentials-b' };
        expect(uniquifyName('same', '{IP}{PORT}{PROTO}{KIND}', explicitA))
            .toContain(stableNameSuffix(explicitA));
        expect(uniquifyName('same', '{IP}{PORT}{PROTO}{KIND}', explicitB))
            .toContain(stableNameSuffix(explicitB));
    });

    test('keeps fallback names deterministic when visible values are unavailable', () => {
        const firstRegistry = createNameRegistry();
        const first = registerFallbackName('Best Ping', {
            index: 1,
            identity: 'main-domain',
            registry: firstRegistry
        }, {});
        const second = registerFallbackName('Best Ping', {
            index: 1,
            identity: 'custom-domain',
            registry: firstRegistry
        }, {});
        expect(first).not.toBe(second);
        expect(first).toContain(stableNameSuffix({ index: 1, identity: 'main-domain' }));
        expect(second).toContain(stableNameSuffix({ index: 1, identity: 'custom-domain' }));
    });

    test('keeps uniqueness bounded by the requested maximum length', () => {
        const registry = createNameRegistry();
        const first = uniquifyName('same', '{COUNTRY}', {
            index: 1,
            address: '1.1.1.1',
            port: 443,
            proto: 'VLESS',
            kind: 'Normal',
            registry
        }, { maxLength: 8 });
        const second = uniquifyName('same', '{COUNTRY}', {
            index: 1,
            address: '1.1.1.1',
            port: 443,
            proto: 'VLESS',
            kind: 'Normal',
            registry
        }, { maxLength: 8 });

        expect([...first].length).toBeLessThanOrEqual(8);
        expect([...second].length).toBeLessThanOrEqual(8);
        expect(first).not.toBe(second);
    });

    test('parses named address groups with IPv4 and IPv6 keys', () => {
        const groups = parseAddressGroups([
            'Cloudflare Fast:',
            '1.1.1.1:443',
            '[2606:4700::1111]:443',
            'Backup: 1.0.0.1, example.com'
        ]);
        expect(groups.get('1.1.1.1')).toBe('Cloudflare Fast');
        expect(groups.get(normalizeAddress('[2606:4700::1111]'))).toBe('Cloudflare Fast');
        expect(groups.get('example.com')).toBe('Backup');
        expect(renderName('{GROUP} - {IP}', {
            index: 1,
            address: '1.1.1.1',
            group: groups.get('1.1.1.1')
        })).toBe('Cloudflare Fast - 1.1.1.1');
    });

    test('backend preview exposes raw collisions and final unique names', () => {
        const result = buildNamePreview('{FLAG}{COUNTRY}');
        expect(result.diagnostics).toHaveLength(0);
        expect(result.rows.length).toBeGreaterThan(1);
        expect(result.collisions.length).toBeGreaterThan(0);
        expect(result.rows.some(row => row.rawName !== row.finalName)).toBe(true);

        const reserved = buildNamePreview('✅ Selector');
        expect(reserved.rows.every(row => row.rawName !== row.finalName)).toBe(true);

        const brand = buildNamePreview('{B}');
        expect(brand.rows.every(row => Boolean(row.rawName))).toBe(true);
        expect(brand.rows[0]?.rawName).toBe('BPB');
    });
});

describe('geo privacy', () => {
    test('cache-only lookups never call the provider', async () => {
        const originalFetch = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            return new Response('{}');
        }) as typeof fetch;

        const env = {
            kv: {
                get: async () => null,
                put: async () => undefined
            }
        } as unknown as Env;

        try {
            await resolveGeo(env, '198.51.100.7', { cacheOnly: true });
            expect(calls).toBe(0);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
