import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
    buildNamePreview,
    createNameRegistry,
    NAME_TEMPLATE_TOKENS,
    NAME_TEMPLATE_TOKEN_CATALOG,
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
    uniquifyName,
    nameSnapshotKey,
    compileNameTemplate,
    renderCompiledName,
    sanitizeConfigName
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
        expect(getNameTemplateDiagnostics('[[literal only]]')[0]?.code).toBe('empty-optional');
        expect(getNameTemplateDiagnostics('x\u202E{IP}')[0]?.code).toBe('unsafe-character');
        expect(getNameTemplateDiagnostics('x\n{IP')[1]?.line).toBe(2);
    });

    test('supports per-token fallbacks without changing optional behavior', () => {
        expect(renderName('{CITY|Unknown} - {COUNTRY}', {
            index: 1,
            address: '1.1.1.1',
            geo: { ip: '1.1.1.1', countryCode: 'DE', country: 'Germany' }
        })).toBe('Unknown - Germany');
        expect(renderName('[[ - {CITY|Unknown}]]', { index: 1, address: '1.1.1.1' })).toBe(' - Unknown');
        expect(isValidNameTemplate('{CITY|Unknown}')).toBe(true);
        expect(isValidNameTemplate('{CITY|}')).toBe(false);
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
        expect(migrateNameTemplate('edge-{flag}', 5)).toBe('edge-{flag}');
    });

    test('keeps output identifiers safe and distinguishes dial from egress data', () => {
        expect(sanitizeConfigName('a/b:c?.conf', 'filename')).toBe('a_b_c_.conf');
        expect(sanitizeConfigName('line\nname\u202E', 'tag')).toBe('line name');
        expect(renderName('{IP}[[ egress={EGRESS_IP}]]', {
            index: 1,
            address: '1.1.1.1',
            geoSource: 'dial'
        })).toBe('1.1.1.1');
        expect(renderName('{GEO_SOURCE} {IP}[[ egress={EGRESS_IP}]]', {
            index: 1,
            address: '1.1.1.1',
            geoSource: 'egress',
            egressIp: '203.0.113.10'
        })).toBe('egress 1.1.1.1 egress=203.0.113.10');
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
            'Backup: 1.0.0.1, example.com',
            'IPv6: 2606:4700::1111'
        ]);
        expect(groups.get('1.1.1.1')).toBe('Cloudflare Fast');
        expect(groups.get(normalizeAddress('[2606:4700::1111]'))).toBe('IPv6');
        expect(groups.get('example.com')).toBe('Backup');
        expect(groups.get('2606:4700::1111')).toBe('IPv6');
        expect(groups.get(normalizeAddress('EXAMPLE.COM.'))).toBe('Backup');
        expect(renderName('{GROUP} - {IP}', {
            index: 1,
            address: '1.1.1.1',
            group: groups.get('1.1.1.1')
        })).toBe('Cloudflare Fast - 1.1.1.1');
        expect(parseAddressGroups(['CIDR: 1.1.1.0/24']).has('1.1.1.1')).toBe(false);
        expect(parseAddressGroups(['CIDR: 2606:4700::/64']).size).toBe(0);
    });

    test('preview reflects privacy, latency, and address-group controls', () => {
        const disabled = buildNamePreview('{COUNTRY} {LATENCY}', {
            geoMode: 'disabled',
            latencyAutoTest: false
        });
        expect(disabled.rows.every(row => row.rawName === '-- --')).toBe(true);
        expect(disabled.tokenAvailability.COUNTRY?.available).toBe(0);
        expect(disabled.tokenAvailability.LATENCY?.available).toBe(0);

        const grouped = buildNamePreview('{GROUP}', {
            addressGroups: ['Cloudflare Fast: 2.2.2.2']
        });
        expect(grouped.rows.find(row => row.label === 'Named clean IP')?.rawName).toBe('Cloudflare Fast');
    });

    test('compiled templates and snapshot keys are reusable and strong', () => {
        const compiled = compileNameTemplate('{FLAG} {IP|unknown}');
        expect(compiled).not.toBeNull();
        expect(renderCompiledName(compiled!, { index: 1, address: '1.1.1.1', geo: { ip: '1.1.1.1', countryCode: 'DE' } })).toBe('🇩🇪 1.1.1.1');
        expect(nameSnapshotKey('{IP}', { index: 1, address: '1.1.1.1' })).toMatch(/^nameSnapshot:v5:[0-9a-f]{16}$/u);
        expect(nameSnapshotKey('{IP}', { index: 1, address: '1.1.1.1' }))
            .toBe(nameSnapshotKey('{IP}', { index: 99, address: '1.1.1.1' }));
    });

    test('backend preview exposes raw collisions and final unique names', () => {
        const result = buildNamePreview('{FLAG}{COUNTRY}');
        expect(result.diagnostics).toHaveLength(0);
        expect(result.rows.length).toBeGreaterThan(1);
        expect(result.collisions.length).toBeGreaterThan(0);
        expect(result.rows.some(row => row.rawName !== row.finalName)).toBe(true);
        expect(result.tokenAvailability.IP?.available).toBe(result.tokenAvailability.IP?.total);
        expect(result.tokenCatalog.some(token => token.token === 'GEO_SOURCE')).toBe(true);

        const geoSource = buildNamePreview('{GEO_SOURCE}');
        expect(geoSource.tokenAvailability.GEO_SOURCE?.available).toBe(geoSource.tokenAvailability.GEO_SOURCE?.total);
        expect(geoSource.rows.every(row => row.rawName === 'egress')).toBe(true);

        const reserved = buildNamePreview('✅ Selector');
        expect(reserved.rows.every(row => row.rawName !== row.finalName)).toBe(true);

        const brand = buildNamePreview('{B}');
        expect(brand.rows.every(row => Boolean(row.rawName))).toBe(true);
        expect(brand.rows[0]?.rawName).toBe('BPB');
    });

    test('keeps the browser autocomplete contract sourced from the backend tuple', () => {
        expect(NAME_TEMPLATE_TOKEN_CATALOG.map(item => item.token)).toEqual([...NAME_TEMPLATE_TOKENS]);
        const panelScript = readFileSync(new URL('../src/assets/panel/script.js', import.meta.url), 'utf8');
        expect(panelScript).toContain("JSON.parse('__NAME_TEMPLATE_TOKENS__')");
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
