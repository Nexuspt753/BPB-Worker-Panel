import type { GeoInfo } from './geo';

export const NAME_TEMPLATE_VERSION = 2;
export const NAME_TEMPLATE_TOKENS = [
    'FLAG', 'COUNTRY', 'COUNTRY_CODE', 'CITY', 'REGION', 'ISP', 'ASN', 'TYPE', 'GEO_AGE',
    'LATENCY', 'LATENCY_AGE', 'IP', 'IPNAME', 'INDEX', 'PORT', 'MARKER', 'PROTO', 'CHAIN', 'EGRESS_IP',
    'B', 'F', 'D', 'C', 'SECURITY', 'TRANSPORT', 'SNI', 'HOST', 'FAMILY', 'DOMAIN',
    'CORE', 'KIND'
] as const;

export type NameFormat = 'readable' | 'compact' | 'ascii';

export interface NameFormatOptions {
    mode?: NameFormat;
    maxLength?: number;
}

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
    latencyAge?: string;
    geoAge?: string;
    egressIp?: string;
    proto?: string;
    chain?: boolean;
    countryCode?: string;
    security?: string;
    transport?: string;
    sni?: string;
    host?: string;
    family?: string;
    domain?: string;
    core?: string;
    kind?: string;
}

type TemplateNode =
    | { kind: 'text'; value: string }
    | { kind: 'token'; key: string }
    | { kind: 'optional'; children: TemplateNode[] };

// Tokens that legitimately render as an empty string instead of the `--`
// placeholder, because "not set" is a meaningful state for them.
const BLANK_OK = new Set(['MARKER', 'CHAIN']);

/**
 * Parse a template into text, token, and non-nested optional-section nodes.
 * Optional sections use `[[...]]` and are omitted when none of their tokens has
 * a value. Literal braces are unsupported so malformed input is all-or-nothing.
 */
function parseTemplateSource(source: string, allowOptional: boolean): TemplateNode[] | null {
    const nodes: TemplateNode[] = [];
    let text = '';
    let cursor = 0;

    const flushText = () => {
        if (text) nodes.push({ kind: 'text', value: text });
        text = '';
    };

    while (cursor < source.length) {
        if (source.startsWith('[[', cursor)) {
            if (!allowOptional) return null;
            flushText();
            const end = source.indexOf(']]', cursor + 2);
            if (end === -1) return null;
            const body = source.slice(cursor + 2, end);
            if (!body.trim() || body.includes('[[') || body.includes(']]')) return null;
            const children = parseTemplateSource(body, false);
            if (!children) return null;
            nodes.push({ kind: 'optional', children });
            cursor = end + 2;
            continue;
        }

        if (source.startsWith(']]', cursor)) return null;

        if (source[cursor] === '{') {
            flushText();
            const end = source.indexOf('}', cursor + 1);
            if (end === -1) return null;
            const body = source.slice(cursor + 1, end);
            if (!/^[A-Za-z0-9_]+$/.test(body)) return null;
            nodes.push({ kind: 'token', key: body.toUpperCase() });
            cursor = end + 1;
            continue;
        }

        if (source[cursor] === '}') return null;
        text += source[cursor];
        cursor++;
    }

    flushText();
    return nodes;
}

function parseTemplate(template: string): TemplateNode[] | null {
    return parseTemplateSource(template, true);
}

export function isValidNameTemplate(template: unknown): template is string {
    return typeof template === 'string' && parseTemplate(template) !== null;
}

/**
 * Upgrade a template saved by an older panel without changing its meaning.
 * Token matching has always been case-insensitive, so the migration only
 * canonicalizes token spelling and leaves user text untouched.
 */
export function migrateNameTemplate(template: unknown, version = 1): string {
    if (typeof template !== 'string') return '';
    if (Number(version) >= NAME_TEMPLATE_VERSION) return template;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, token: string) => `{${token.toUpperCase()}}`);
}

function collectTokens(nodes: TemplateNode[], output: Set<string>): void {
    nodes.forEach(node => {
        if (node.kind === 'token') output.add(node.key);
        if (node.kind === 'optional') collectTokens(node.children, output);
    });
}

/**
 * Which distinguishing facts a template already carries. Used by `uniquifyName`
 * to keep rendered names unique per config (clash proxy `name` and sing-box
 * outbound `tag` must be unique — duplicates silently break the proxy-groups /
 * chain wiring).
 */
export function templateTokens(template: string): Set<string> {
    const parsed = parseTemplate(template);
    const tokens = new Set<string>();
    if (parsed) collectTokens(parsed, tokens);
    return tokens;
}

export function formatCacheAge(cachedAt?: number): string {
    if (!cachedAt || !Number.isFinite(cachedAt)) return '';
    const minutes = Math.max(0, Math.floor((Date.now() - cachedAt) / 60_000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

function geoAge(geo?: GeoInfo): string {
    return formatCacheAge(geo?.cachedAt);
}

function rawTokenValue(key: string, ctx: NameContext, geo?: GeoInfo): string | null {
    const country = geo?.country ?? '';
    const countryCode = ctx.countryCode ?? geo?.countryCode ?? '';
    switch (key) {
        case 'FLAG': return geo?.countryCode ? flagFromCode(geo.countryCode) : '';
        case 'COUNTRY': return country;
        case 'COUNTRY_CODE': return countryCode;
        case 'CITY': return geo?.city ?? '';
        case 'REGION': return geo?.region ?? '';
        case 'ISP': return geo?.isp ?? '';
        case 'ASN': return geo?.asn ?? '';
        case 'TYPE': return typeMap(geo);
        case 'GEO_AGE': return ctx.geoAge ?? geoAge(geo);
        case 'LATENCY': return ctx.latency || '';
        case 'LATENCY_AGE': return ctx.latencyAge || '';
        case 'IP': return ctx.address || '';
        case 'IPNAME': return ctx.customName || '';
        case 'B': return ctx.brand || '';
        case 'F': return geo?.countryCode ? flagFromCode(geo.countryCode) : '';
        case 'D': return ctx.address || '';
        case 'C': return country;
        case 'MARKER': return ctx.marker || '';
        case 'CHAIN': return ctx.chain ? '🔗' : '';
        case 'PROTO': return ctx.proto || '';
        case 'INDEX': return ctx.index != null ? String(ctx.index) : '';
        case 'EGRESS_IP': return ctx.egressIp || '';
        case 'PORT': return ctx.port != null ? String(ctx.port) : '';
        case 'SECURITY': return ctx.security || '';
        case 'TRANSPORT': return ctx.transport || '';
        case 'SNI': return ctx.sni || '';
        case 'HOST': return ctx.host || '';
        case 'FAMILY': return ctx.family || '';
        case 'DOMAIN': return ctx.domain || '';
        case 'CORE': return ctx.core || '';
        case 'KIND': return ctx.kind || '';
        default: return null;
    }
}

function hasOptionalValue(nodes: TemplateNode[], ctx: NameContext): boolean {
    return nodes.some(node => {
        if (node.kind === 'token') {
            const value = rawTokenValue(node.key, ctx, ctx.geo);
            return value != null && value !== '';
        }
        if (node.kind === 'optional') return hasOptionalValue(node.children, ctx);
        return false;
    });
}

function renderNodes(nodes: TemplateNode[], ctx: NameContext): string {
    return nodes.map(node => {
        if (node.kind === 'text') return node.value;
        if (node.kind === 'optional') {
            return hasOptionalValue(node.children, ctx) ? renderNodes(node.children, ctx) : '';
        }

        const out = rawTokenValue(node.key, ctx, ctx.geo);
        if (out === '' && BLANK_OK.has(node.key)) return '';
        return out == null || out === '' ? '--' : out;
    }).join('');
}

/**
 * Render a config-name template against a context of resolved values.
 *
 * Tokens are case-insensitive. Optional blocks use `[[...]]` and disappear
 * when their tokens have no value. Unknown tokens still render as `--`, while
 * malformed brace/optional syntax returns an empty string without throwing.
 */
export function renderName(template: string, ctx: NameContext): string {
    const parsed = parseTemplate(template);
    if (!parsed) return '';
    return renderNodes(parsed, ctx);
}

export function formatName(value: string, options: NameFormatOptions = {}): string {
    const mode = options.mode ?? 'readable';
    let result = value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/\s+/gu, ' ')
        .trim();

    if (mode === 'compact') {
        result = result
            .replace(/\s*([|·])\s*/gu, '$1')
            .replace(/([|·])(?:\1)+/gu, '$1')
            .replace(/\s+-\s+/gu, '-');
    } else if (mode === 'ascii') {
        result = result
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/gu, '')
            .replace(/[^\x20-\x7e]/gu, '')
            .replace(/\s+/gu, ' ')
            .trim();
    }

    const maxLength = Number.isInteger(options.maxLength) && (options.maxLength ?? 0) > 0
        ? options.maxLength!
        : undefined;
    return maxLength && result.length > maxLength
        ? result.slice(0, maxLength).trimEnd()
        : result;
}

/**
 * Config names MUST be unique: clash keys proxies by `name`, sing-box keys
 * outbounds by `tag`, and both wire `proxy-groups` / chain detours by that
 * string. A geo-only template like `{FLAG}{COUNTRY}` renders identically for
 * every port, protocol, chain variant, and address, so omitted distinguishing
 * facts are appended automatically.
 */
export function uniquifyName(
    rendered: string,
    template: string,
    ctx: NameContext,
    options: NameFormatOptions = {}
): string {
    const tokens = templateTokens(template);
    const suffix: string[] = [];
    const mode = options.mode ?? 'readable';

    if (!tokens.has('CHAIN') && ctx.chain) suffix.push(mode === 'ascii' ? 'CHAIN' : '🔗');
    const marker = (ctx.marker ?? '').trim();
    if (!tokens.has('MARKER') && marker) suffix.push(marker);
    if (!tokens.has('PROTO') && ctx.proto) suffix.push(ctx.proto);
    if (!tokens.has('PORT') && ctx.port != null) suffix.push(String(ctx.port));

    const identifiesAddress = tokens.has('IP') || tokens.has('D');
    if (!tokens.has('INDEX') && !identifiesAddress) suffix.push(`#${ctx.index}`);

    const suffixText = formatName(suffix.join(' '), { mode });
    let base = formatName(rendered, { mode });
    if (!suffixText) return formatName(base, options);

    const maxLength = Number.isInteger(options.maxLength) && (options.maxLength ?? 0) > 0
        ? options.maxLength!
        : undefined;
    const separator = base ? ' ' : '';
    if (maxLength) {
        const available = Math.max(1, maxLength - separator.length - suffixText.length);
        base = base.slice(0, available).trimEnd();
    }

    return formatName(`${base}${separator}${suffixText}`, options);
}

// Map a geo connection type to the readable tag shown in config names.
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
