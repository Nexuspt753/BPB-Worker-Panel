import type { GeoInfo } from './geo';

/**
 * Render a config-name template string against a context of resolved values.
 *
 * Placeholders (matched by a robust `{[A-Za-z0-9_]+}` regex, user-supplied):
 *   {FLAG} {COUNTRY} {CITY} {REGION} {ISP} {ASN} {TYPE} {LATENCY} {IP} {IPNAME}
  *   {B} (brand) {F} (flag) {D} (address/domain) {C} (country)
  *   {index} {port} {EGRESS_IP}
  * Any unknown placeholder, or a known-but-empty value, renders as `--`.
 *
 * The template is user-supplied; a missing/malformed template renders an
 * empty (or unchanged) string without throwing.
 */
export function renderName(
    template: string,
    ctx: {
        brand?: string;
        index: number;
        label?: string;
        ip?: string;
        port?: number;
        address?: string;
        geo?: GeoInfo;
        customName?: string;
        marker?: string;
        latency?: string;
        egressIp?: string;
    },
): string {
    if (typeof template !== 'string') return '';

    const g = ctx.geo;
    const flag = g && g.countryCode ? flagFromCode(g.countryCode) : '';
    const country = g?.country ?? '';
    const city = g?.city ?? '';
    const region = g?.region ?? '';
    const isp = g?.isp ?? '';
    const asn = g?.asn ?? '';

    // Substitute each {NAME} token; unknown or empty -> '--'.
    // MARKER is intentionally blank when no prefix applies (not '--').
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, name) => {
        const out = resolveToken(name, ctx, g, flag, country, city, region, isp, asn);
        if (out === '' && name.toUpperCase() === 'MARKER') return '';
        return out == null || out === '' ? '--' : out;
    });
}

// Lookup used by the real implementation; kept here so the replace callback
// stays self-contained.
function resolveToken(
    name: string,
    ctx: {
        brand?: string; index: number; label?: string; ip?: string;
        port?: number; address?: string; geo?: GeoInfo;
        customName?: string; marker?: string; latency?: string;
        egressIp?: string;
    },
    g: GeoInfo | undefined,
    flag: string,
    country: string,
    city: string,
    region: string,
    isp: string,
    asn: string,
): string | null {
    switch (name.toUpperCase()) {
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