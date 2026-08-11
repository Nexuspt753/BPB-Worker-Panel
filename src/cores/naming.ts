import type { GeoInfo } from './geo';

/**
 * Split a Clean IP entry of the form `host # Optional Name` into its parts.
 * Pure string helper — kept in this module (which imports nothing but a type)
 * so validators and the latency store can use it without dragging in settings.
 */
export function splitIpAndName(entry: string): { host: string; name: string } {
    const idx = entry.indexOf('#');
    if (idx === -1) return { host: entry.trim(), name: '' };
    return {
        host: entry.slice(0, idx).trim(),
        name: entry.slice(idx + 1).trim(),
    };
}

export function cleanIpHost(entry: string): string {
    return splitIpAndName(entry).host;
}

/**
 * Bare form of an address: IPv6 literals lose their `[...]` wrapper. Used as the
 * canonical key for the geo and latency caches so both stores agree, and as the
 * value ip-api is queried with.
 */
export function normalizeAddress(address: string): string {
    const trimmed = (address || '').trim();
    return trimmed.startsWith('[') && trimmed.endsWith(']')
        ? trimmed.slice(1, -1)
        : trimmed;
}

export interface NameContext {
    brand?: string;
    index: number;
    port?: number;
    address?: string;
    geo?: GeoInfo;
    customName?: string;
    marker?: string;
    latency?: string;
    egressIp?: string;
    proto?: string;
    chain?: boolean;
}

// Tokens that legitimately render as an empty string instead of the `--`
// placeholder, because "not set" is a meaningful state for them.
const BLANK_OK = new Set(['MARKER', 'CHAIN']);

/**
 * Render a config-name template against a context of resolved values.
 *
 * Placeholders are matched by `{[A-Za-z0-9_]+}` and are case-insensitive:
 *   {FLAG} {COUNTRY} {CITY} {REGION} {ISP} {ASN} {TYPE} {LATENCY} {IP} {IPNAME}
 *   {EGRESS_IP} {INDEX} {PORT} {PROTO} {CHAIN} {MARKER}
 *   {B} (brand) {F} (flag) {D} (address/domain) {C} (country)
 *
 * An unknown placeholder, or a known-but-empty value, renders as `--`.
 * {MARKER} and {CHAIN} render empty when they do not apply.
 *
 * The template is user-supplied; a missing/malformed template renders an
 * empty string without throwing.
 */
export function renderName(template: string, ctx: NameContext): string {
    if (typeof template !== 'string') return '';

    const g = ctx.geo;
    const flag = g && g.countryCode ? flagFromCode(g.countryCode) : '';
    const country = g?.country ?? '';
    const city = g?.city ?? '';
    const region = g?.region ?? '';
    const isp = g?.isp ?? '';
    const asn = g?.asn ?? '';

    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => {
        const key = name.toUpperCase();
        const out = resolveToken(key, ctx, g, flag, country, city, region, isp, asn);
        if (out === '' && BLANK_OK.has(key)) return '';
        return out == null || out === '' ? '--' : out;
    });
}

/**
 * Which distinguishing facts a template already carries. Used by `uniquifyName`
 * to keep rendered names unique per config (clash proxy `name` and sing-box
 * outbound `tag` must be unique — duplicates silently break the proxy-groups /
 * chain wiring).
 */
export function templateTokens(template: string): Set<string> {
    const found = template.match(/\{([A-Za-z0-9_]+)\}/g) ?? [];
    return new Set(found.map(token => token.slice(1, -1).toUpperCase()));
}

/**
 * Config names MUST be unique: clash keys proxies by `name`, sing-box keys
 * outbounds by `tag`, and both wire `proxy-groups` / chain detours by that
 * string. A geo-only template like `{FLAG}{COUNTRY}` renders identically for
 * every port, protocol and chain variant of an address — and because the geo
 * tokens resolve from the single deployment egress, identically for every
 * address too. Duplicates make clash drop proxies and can point a chain's
 * `dialer-proxy` at itself, so append whatever facts the template left out.
 */
export function uniquifyName(rendered: string, template: string, ctx: NameContext): string {
    const tokens = templateTokens(template);
    const suffix: string[] = [];

    // {IP}/{D} alone still collides across ports and protocols, so every fact is
    // checked on its own rather than assuming one implies the others.
    if (!tokens.has('CHAIN') && ctx.chain) suffix.push('🔗');
    // The marker carries the F/D/C flags, which separate the same clean IP dialed
    // through the custom domain (or as fragment) from the plain one.
    const marker = (ctx.marker ?? '').trim();
    if (!tokens.has('MARKER') && marker) suffix.push(marker);
    if (!tokens.has('PROTO') && ctx.proto) suffix.push(ctx.proto);
    if (!tokens.has('PORT') && ctx.port != null) suffix.push(String(ctx.port));
    // Only {IP}/{D} truly identify the address. {IPNAME} looks like it does but
    // renders '--' for every address without a `# Name`, so it cannot stand in
    // for the index.
    const identifiesAddress = tokens.has('IP') || tokens.has('D');
    if (!tokens.has('INDEX') && !identifiesAddress) suffix.push(`#${ctx.index}`);

    return suffix.length ? `${rendered} ${suffix.join(' ')}` : rendered;
}

// Lookup used by the real implementation; kept here so the replace callback
// stays self-contained. `key` is already upper-cased.
function resolveToken(
    key: string,
    ctx: NameContext,
    g: GeoInfo | undefined,
    flag: string,
    country: string,
    city: string,
    region: string,
    isp: string,
    asn: string,
): string | null {
    switch (key) {
        case 'FLAG': return flag;
        case 'COUNTRY': return country;
        case 'CITY': return city;
        case 'REGION': return region;
        case 'ISP': return isp;
        case 'ASN': return asn;
        case 'TYPE': return typeMap(g);
        case 'LATENCY': return ctx.latency || '';
        case 'IP': return ctx.address || '';
        case 'IPNAME': return ctx.customName || '';
        case 'B': return ctx.brand || '';
        case 'F': return flag;
        case 'D': return ctx.address || '';
        case 'C': return country;
        case 'MARKER': return ctx.marker || '';
        case 'CHAIN': return ctx.chain ? '🔗' : '';
        case 'PROTO': return ctx.proto || '';
        case 'INDEX': return ctx.index != null ? String(ctx.index) : '';
        case 'EGRESS_IP': return ctx.egressIp || '';
        case 'PORT': return ctx.port != null ? String(ctx.port) : '';
        default: return null; // unknown -> '--'
    }
}

// Map a geo connection type to the readable tag shown in config names.
// Exported so tests and the panel can drive the mapping directly.
export function typeMap(geo?: GeoInfo | null): string {
    switch (geo?.type) {
        case 'hosting': return 'Hosting';
        case 'mobile': return 'Mobile';
        case 'residential': return 'Residential';
        default: return '';
    }
}

// Derive a flag emoji from a 2-letter ISO country code using regional indicator
// symbols (U+1F1E6 + letter offset). Non-2-letter codes render empty.
function flagFromCode(code?: string): string {
    const c = (code || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) return '';
    const letters = c.split('');
    return String.fromCodePoint(
        ...letters.map((ch) => 0x1f1e6 + (ch.charCodeAt(0) - 0x41)),
    );
}
