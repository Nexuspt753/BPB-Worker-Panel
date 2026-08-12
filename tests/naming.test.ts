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
    });

    test('parses named address groups with IPv4 and IPv6 keys', () => {
        const groups = parseAddressGroups([
            'Cloudflare Fast:',
            '1.1.1.1',
            '[2606:4700::1111]',
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
