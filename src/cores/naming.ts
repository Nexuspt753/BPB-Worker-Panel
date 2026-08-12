import type { GeoInfo } from './geo';

export const NAME_TEMPLATE_VERSION = 3;
// A shorter limit cannot retain the uniqueness fingerprint for realistic
// subscriptions (for example, one character can represent only 16 hex values).
// Keep the setting beginner-safe while still allowing genuinely compact names.
export const MIN_NAME_MAX_LENGTH = 8;
export const NAME_TEMPLATE_TOKENS = [
    'FLAG', 'COUNTRY', 'COUNTRY_CODE', 'CITY', 'REGION', 'ISP', 'ASN', 'TYPE', 'GEO_AGE',
    'LATENCY', 'LATENCY_AGE', 'IP', 'IPNAME', 'GROUP', 'INDEX', 'PORT', 'MARKER', 'PROTO', 'CHAIN', 'EGRESS_IP',
    'B', 'F', 'D', 'C', 'SECURITY', 'TRANSPORT', 'SNI', 'HOST', 'FAMILY', 'DOMAIN',
    'CORE', 'KIND'
] as const;

export type NameFormat = 'readable' | 'compact' | 'ascii';

export interface NameRegistry {
    names: Set<string>;
}

// Names reserved by the generated client-core scaffolding. The concrete output
// builders reserve the subset they emit; the preview reserves the union so it
// never tells a beginner that a name is safe when it could shadow an internal
// selector, DNS, inbound, or URL-test identifier.
export const RESERVED_NAME_IDENTIFIERS = [
    '✅ Selector', 'direct', 'dns-remote', 'dns-direct', 'dns-anti-sanction', 'dns-fake', 'hosts', 'tun-in', 'mixed-in',
    '💦 Best Ping 🚀', '💦 🔗 Best Ping 🚀', '💦 Best Ping D 🚀', '💦 🔗 Best Ping D 🚀',
    '💦 Warp - Best Ping 🚀', '💦 WoW - Best Ping 🚀',
    '💦 Warp Pro - Best Ping 🚀', '💦 WoW Pro - Best Ping 🚀'
] as const;

export interface NameFormatOptions {
    mode?: NameFormat;
    maxLength?: number;
}

export interface NameTemplateDiagnostic {
    code: 'unmatched-open' | 'unmatched-close' | 'nested-token' | 'empty-token' | 'invalid-token' | 'nested-optional' | 'unmatched-optional' | 'unknown-token' | 'invalid-template';
    message: string;
    start: number;
    end: number;
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
 * Parse the address-group textarea. A group can be written as a header followed
 * by addresses on subsequent lines (`Fast:` then `1.1.1.1`), or inline as
 * `Fast: 1.1.1.1, 1.0.0.1`. The returned keys use the same normalized address
 * form as Clean IP and geo caches.
 */
function normalizeGroupAddress(address: string): string {
    const value = String(address ?? '').trim();
    const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/u);
    if (bracketed) return normalizeAddress(`[${bracketed[1]}]`);

    // Address groups are keyed by host, while a user may naturally paste an
    // endpoint with a port. Ignore that port so `{GROUP}` still matches the
    // host stored in a generated config.
    const hostPort = value.match(/^([^:]+):\d+$/u);
    return normalizeAddress(hostPort ? hostPort[1] : value);
}

export function parseAddressGroups(entries: readonly string[] = []): Map<string, string> {
    const groups = new Map<string, string>();
    let activeGroup = '';

    for (const entry of entries) {
        for (const rawLine of String(entry ?? '').split(/\r?\n/u)) {
            const line = rawLine.trim();
            if (!line) continue;

            const header = line.match(/^(.+?):\s*$/u);
            if (header && !header[1].includes(':')) {
                activeGroup = header[1].trim();
                continue;
            }

            let group = activeGroup;
            let addresses = line;
            const isEndpointLine = /^\[[^\]]+\]:\d+$/u.test(line) || /^[^:]+:\d+$/u.test(line);
            const inline = isEndpointLine ? null : line.match(/^([^:=|]+?)\s*[:=|]\s*(.+)$/u);
            if (inline && (inline[2].includes('.') || inline[2].includes('[') || /^[a-z0-9.-]+(?::\\d+)?$/iu.test(inline[2]))) {
                group = inline[1].trim();
                addresses = inline[2].trim();
                activeGroup = group;
            }

            if (!group) continue;
            addresses.split(/\s*,\s*/u).map(address => normalizeGroupAddress(address)).filter(Boolean).forEach(address => {
                groups.set(address, group);
            });
        }
    }

    return groups;
}

export function findAddressGroup(address: string | undefined, entries: readonly string[] = []): string | undefined {
    if (!address) return undefined;
    return parseAddressGroups(entries).get(normalizeGroupAddress(address));
}

/**
 * Bare form of an address: IPv6 literals lose their `[...]` wrapper. Used as the
 * canonical key for geo, latency, and address-group caches.
 */
export function normalizeAddress(address: string): string {
    const trimmed = (address || '').trim();
    const bare = trimmed.startsWith('[') && trimmed.endsWith(']')
        ? trimmed.slice(1, -1)
        : trimmed;
    // DNS names are case-insensitive, and IPv6 hex digits are equivalent in
    // either case. This keeps geo, latency, group, and identity keys aligned.
    return bare.toLowerCase();
}

export interface NameContext {
    brand?: string;
    index: number;
    port?: number;
    address?: string;
    geo?: GeoInfo;
    customName?: string;
    group?: string;
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
    /** Stable identity for callers that have a more precise config key. */
    identity?: string;
    registry?: NameRegistry;
}

type TemplateNode =
    | { kind: 'text'; value: string }
    | { kind: 'token'; key: string }
    | { kind: 'optional'; children: TemplateNode[] };

// Tokens that legitimately render as an empty string instead of the `--`
// placeholder, because "not set" is a meaningful state for them.
const BLANK_OK = new Set(['MARKER', 'CHAIN', 'GROUP']);
const KNOWN_TOKENS = new Set<string>(NAME_TEMPLATE_TOKENS);

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

/** Return actionable, source-positioned errors for the panel and API. */
export function getNameTemplateDiagnostics(template: unknown): NameTemplateDiagnostic[] {
    if (typeof template !== 'string') {
        return [{
            code: 'invalid-template',
            message: 'Template must be text.',
            start: 0,
            end: 0
        }];
    }

    const diagnostics: NameTemplateDiagnostic[] = [];
    const add = (diagnostic: NameTemplateDiagnostic) => {
        if (!diagnostics.some(item => item.code === diagnostic.code && item.start === diagnostic.start && item.end === diagnostic.end)) {
            diagnostics.push(diagnostic);
        }
    };

    let optionalDepth = 0;
    for (let cursor = 0; cursor < template.length;) {
        if (template.startsWith('[[', cursor)) {
            if (optionalDepth > 0) {
                add({ code: 'nested-optional', message: 'Optional sections cannot be nested.', start: cursor, end: cursor + 2 });
            }
            optionalDepth++;
            cursor += 2;
            continue;
        }
        if (template.startsWith(']]', cursor)) {
            if (optionalDepth === 0) {
                add({ code: 'unmatched-optional', message: 'Closing ]] has no matching [[.', start: cursor, end: cursor + 2 });
            } else {
                optionalDepth--;
            }
            cursor += 2;
            continue;
        }
        if (template[cursor] === '{') {
            const end = template.indexOf('}', cursor + 1);
            if (template[cursor + 1] === '{') {
                add({ code: 'nested-token', message: 'Tokens cannot be nested.', start: cursor, end: Math.min(template.length, (end === -1 ? cursor + 2 : end + 1)) });
                cursor += 1;
                continue;
            }
            if (end === -1) {
                add({ code: 'unmatched-open', message: 'Opening { has no matching }.', start: cursor, end: cursor + 1 });
                break;
            }
            const body = template.slice(cursor + 1, end);
            if (!body) {
                add({ code: 'empty-token', message: 'Token name cannot be empty.', start: cursor, end: end + 1 });
            } else if (body.includes('{')) {
                add({ code: 'nested-token', message: 'Tokens cannot be nested.', start: cursor, end: end + 1 });
            } else if (!/^[A-Za-z0-9_]+$/.test(body)) {
                add({ code: 'invalid-token', message: 'Token names may contain only letters, numbers, and underscores.', start: cursor, end: end + 1 });
            } else if (!KNOWN_TOKENS.has(body.toUpperCase())) {
                add({ code: 'unknown-token', message: `Unknown token {${body}}.`, start: cursor, end: end + 1 });
            }
            cursor = end + 1;
            continue;
        }
        if (template[cursor] === '}') {
            add({ code: 'unmatched-close', message: 'Closing } has no matching {.', start: cursor, end: cursor + 1 });
        }
        cursor++;
    }

    if (optionalDepth > 0) {
        const start = template.lastIndexOf('[[');
        add({ code: 'unmatched-optional', message: 'Opening [[ has no matching ]].', start: Math.max(0, start), end: Math.min(template.length, Math.max(0, start) + 2) });
    }

    if (parseTemplate(template) === null && !diagnostics.length) {
        add({ code: 'invalid-template', message: 'Template syntax is invalid.', start: 0, end: template.length });
    }

    return diagnostics.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function isValidNameTemplate(template: unknown): template is string {
    return typeof template === 'string'
        && parseTemplate(template) !== null
        && getNameTemplateDiagnostics(template).length === 0;
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
        case 'FLAG': return flagFromCode(countryCode);
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
        case 'GROUP': return ctx.group || '';
        case 'B': return ctx.brand || '';
        case 'F': return flagFromCode(countryCode);
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

export function renderName(template: string, ctx: NameContext): string {
    const parsed = parseTemplate(template);
    if (!parsed) return '';
    return renderNodes(parsed, ctx);
}

function splitGraphemes(value: string): string[] {
    const segmenter = (Intl as typeof Intl & {
        Segmenter?: new (locales?: string | string[], options?: { granularity: 'grapheme' }) => { segment(input: string): Iterable<{ segment: string }> };
    }).Segmenter;
    if (segmenter) {
        return [...new segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(item => item.segment);
    }

    const result: string[] = [];
    for (const char of Array.from(value)) {
        const previous = result[result.length - 1];
        const isJoiner = char === '\u200d';
        const isExtend = /[\u0300-\u036f\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}]/u.test(char);
        if (previous && (previous.endsWith('\u200d') || isJoiner || isExtend)) {
            result[result.length - 1] += char;
        } else if (previous && /^[\u{1F1E6}-\u{1F1FF}]$/u.test(previous) && /^[\u{1F1E6}-\u{1F1FF}]$/u.test(char)) {
            result[result.length - 1] += char;
        } else {
            result.push(char);
        }
    }
    return result;
}

export function truncateName(value: string, maxLength?: number): string {
    if (!maxLength || !Number.isInteger(maxLength) || maxLength < 1) return value;
    return splitGraphemes(value).slice(0, maxLength).join('').trimEnd();
}

export function formatName(value: string, options: NameFormatOptions = {}): string {
    const mode = options.mode ?? 'readable';
    let result = value
        .replace(/[\u0000-\u001f\u007f]/gu, '')
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
    return truncateName(result, maxLength);
}

/** Remove characters that have structural meaning in a specific output. */
export function sanitizeConfigName(value: string, target: 'tag' | 'uri' | 'filename' | 'remark' = 'tag'): string {
    let result = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (target === 'filename') {
        result = result
            .replace(/[\\/:*?"<>|]/gu, '_')
            // A trailing dot/space is not a usable filename on Windows and can
            // become a surprising path after ZIP extraction.
            .replace(/[. ]+$/gu, '');
        if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(result)) result = `_${result}`;
    }
    if (target === 'uri') result = result.replace(/[\r\n]/gu, ' ');
    if (target === 'tag') result = result.replace(/[\\\t]/gu, ' ');
    return result.trim();
}

function fnv1a(value: string): string {
    let hash = 0x811c9dc5;
    for (const char of value) {
        hash ^= char.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function stableNameKey(ctx: NameContext): string {
    return ctx.identity ?? [
        ctx.kind,
        ctx.core,
        ctx.proto,
        normalizeAddress(ctx.address ?? ''),
        ctx.port ?? '',
        ctx.domain,
        ctx.marker,
        ctx.chain ? 'chain' : 'direct',
        ctx.transport,
        ctx.security,
        ctx.customName,
        ctx.group
    ].map(value => String(value ?? '')).join('|');
}

export function stableNameFingerprint(ctx: NameContext): string {
    return fnv1a(stableNameKey(ctx));
}

export function stableNameSuffix(ctx: NameContext): string {
    return `~${stableNameFingerprint(ctx).slice(0, 8)}`;
}

export function nameSnapshotKey(template: string, ctx: NameContext): string {
    return `nameSnapshot:${fnv1a(`${template}|${stableNameKey(ctx)}`)}`;
}

function missingIdentityDimensions(tokens: Set<string>, ctx: NameContext): string[] {
    const missing: string[] = [];
    const hasAddress = tokens.has('IP') || tokens.has('D');
    if (ctx.address && !hasAddress) missing.push('address');
    if (ctx.domain && ctx.domain !== ctx.address && !tokens.has('DOMAIN')) missing.push('domain');
    if (ctx.port != null && !tokens.has('PORT')) missing.push('port');
    if (ctx.proto && !tokens.has('PROTO')) missing.push('protocol');
    if (ctx.chain && !tokens.has('CHAIN')) missing.push('chain');
    if (ctx.marker && !tokens.has('MARKER')) missing.push('marker');
    if (ctx.kind && !tokens.has('KIND')) missing.push('kind');
    if (ctx.core && !tokens.has('CORE')) missing.push('core');
    if (ctx.transport && !tokens.has('TRANSPORT')) missing.push('transport');
    if (ctx.security && !tokens.has('SECURITY')) missing.push('security');
    if (ctx.customName && !tokens.has('IPNAME')) missing.push('custom-name');
    if (ctx.group && !tokens.has('GROUP')) missing.push('group');
    // Explicit identities include details that no public token necessarily
    // exposes (for example imported credentials or the full Best Ping set).
    // Always retain that identity in the generated name so collisions remain
    // stable even when every visible context field is already in the template.
    if (ctx.identity) missing.push('identity');
    return missing;
}

/**
 * Config names MUST be unique. Any identity dimension omitted from a template
 * gets a human-readable hint and a stable hash. The hash is derived from the
 * config identity rather than list order, so reordering addresses does not
 * rename existing configs.
 */
function shortIdentityName(ctx: NameContext, maxLength: number, collision = 0): string {
    const seed = collision > 0
        ? `${stableNameKey(ctx)}|collision:${collision}`
        : stableNameKey(ctx);
    const fingerprint = fnv1a(seed);
    // `~` is useful as a marker at normal lengths, but with a one-character
    // limit it would make every shortened name identical.
    const value = maxLength === 1 ? fingerprint : `~${fingerprint}`;
    return truncateName(value, maxLength);
}

function composeName(base: string, suffix: string, mode: NameFormat, maxLength?: number, ctx?: NameContext, collision = 0): string {
    const formattedBase = formatName(base, { mode });
    const formattedSuffix = formatName(suffix, { mode });

    if (maxLength && formattedSuffix) {
        const suffixLength = splitGraphemes(formattedSuffix).length;
        if (suffixLength >= maxLength) {
            return sanitizeConfigName(shortIdentityName(ctx!, maxLength, collision), 'tag');
        }

        const separator = formattedBase ? ' ' : '';
        const available = maxLength - suffixLength - (separator ? 1 : 0);
        const prefix = available > 0 ? truncateName(formattedBase, available) : '';
        return sanitizeConfigName(`${prefix}${separator}${formattedSuffix}`, 'tag');
    }

    const composed = formattedSuffix
        ? `${formattedBase}${formattedBase ? ' ' : ''}${formattedSuffix}`
        : formattedBase;
    return sanitizeConfigName(maxLength ? truncateName(composed, maxLength) : composed, 'tag');
}

/**
 * Register a classic fallback when a configured template has no usable value.
 * Most fallbacks already contain an index or address, but Best Ping and other
 * logical configs can legitimately share one. Registering only the configured
 * result is not enough because an empty optional template bypasses the normal
 * uniqueness path.
 */
export function registerFallbackName(fallback: string, ctx: NameContext, options: NameFormatOptions): string {
    const registry = ctx.registry;
    if (!registry) return fallback;

    const mode = options.mode ?? 'readable';
    const maxLength = Number.isInteger(options.maxLength) && (options.maxLength ?? 0) > 0
        ? options.maxLength!
        : undefined;
    const base = formatName(fallback, { mode });
    const identitySuffix = stableNameSuffix(ctx);
    let candidate = composeName(base, identitySuffix, mode, maxLength, ctx);
    let collision = 1;

    while (registry.names.has(candidate) && collision < 4096) {
        collision++;
        candidate = composeName(base, `${identitySuffix}-${collision}`, mode, maxLength, ctx, collision);
    }

    registry.names.add(candidate);
    return candidate;
}

export function uniquifyName(
    rendered: string,
    template: string,
    ctx: NameContext,
    options: NameFormatOptions = {}
): string {
    const tokens = templateTokens(template);
    const mode = options.mode ?? 'readable';
    const missing = missingIdentityDimensions(tokens, ctx);
    const suffix: string[] = [];

    if (missing.includes('chain')) suffix.push(mode === 'ascii' ? 'CHAIN' : '🔗');
    if (missing.includes('marker') && ctx.marker) suffix.push(ctx.marker.trim());
    if (missing.includes('protocol') && ctx.proto) suffix.push(ctx.proto);
    if (missing.includes('port') && ctx.port != null) suffix.push(String(ctx.port));
    if (missing.length) suffix.push(stableNameSuffix(ctx));

    const maxLength = Number.isInteger(options.maxLength) && (options.maxLength ?? 0) > 0
        ? options.maxLength!
        : undefined;
    const base = formatName(rendered, { mode });
    const suffixText = formatName(suffix.join(' '), { mode });
    let candidate = composeName(base, suffixText, mode, maxLength, ctx);
    if (!candidate) candidate = sanitizeConfigName(maxLength ? truncateName(base, maxLength) : base, 'tag');

    const registry = ctx.registry;
    if (registry) {
        const identitySuffix = stableNameSuffix(ctx);
        let collision = 1;
        // A maximum length can make a stable suffix longer than the entire
        // name. Use a hashed short form in that case and cap the retry loop so
        // a one-character limit can never hang generation forever.
        while (registry.names.has(candidate) && collision < 4096) {
            collision++;
            const suffixWithCollision = `${identitySuffix}-${collision}`;
            candidate = composeName(base, suffixWithCollision, mode, maxLength, ctx, collision);
        }
        registry.names.add(candidate);
    }

    return candidate;
}

export function createNameRegistry(reserved: readonly string[] = []): NameRegistry {
    return { names: new Set(reserved) };
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

export interface NamePreviewRow {
    label: string;
    rawName: string;
    finalName: string;
}

export interface NamePreviewResult {
    diagnostics: NameTemplateDiagnostic[];
    rows: NamePreviewRow[];
    collisions: Array<{ name: string; labels: string[] }>;
}

const PREVIEW_CONTEXTS: Array<NameContext & { label: string }> = [
    {
        label: 'Frankfurt / VLESS', index: 1, address: '1.1.1.1', port: 443, countryCode: 'DE',
        geo: { ip: '203.0.113.10', countryCode: 'DE', country: 'Germany', city: 'Frankfurt', region: 'Hesse', isp: 'Cloudflare', asn: 'AS13335', type: 'hosting', cachedAt: Date.now() - 2 * 60 * 60_000 },
        latency: '42', latencyAge: '4m', marker: '', proto: 'VLESS', egressIp: '203.0.113.10', security: 'TLS', transport: 'WS', sni: 'example.com', host: 'example.com', family: 'IPv4', domain: 'example.com', core: 'xray', kind: 'Normal', identity: 'normal|xray|vless|1.1.1.1|443|example.com'
    },
    {
        label: 'Frankfurt / Trojan', index: 1, address: '1.1.1.1', port: 443, countryCode: 'DE',
        geo: { ip: '203.0.113.10', countryCode: 'DE', country: 'Germany', city: 'Frankfurt', region: 'Hesse', isp: 'Cloudflare', asn: 'AS13335', type: 'hosting', cachedAt: Date.now() - 2 * 60 * 60_000 },
        latency: '38', latencyAge: '4m', marker: '', proto: 'Trojan', egressIp: '203.0.113.10', security: 'TLS', transport: 'WS', sni: 'example.com', host: 'example.com', family: 'IPv4', domain: 'example.com', core: 'sing-box', kind: 'Normal', identity: 'normal|sing-box|trojan|1.1.1.1|443|example.com'
    },
    {
        label: 'Named clean IP', index: 2, address: '2.2.2.2', port: 8443, customName: 'Fast edge', group: 'Cloudflare Fast', countryCode: 'DE',
        geo: { ip: '203.0.113.10', countryCode: 'DE', country: 'Germany', city: 'Frankfurt', region: 'Hesse', isp: 'Example CDN', asn: 'AS64500', type: 'hosting', cachedAt: Date.now() - 24 * 60 * 60_000 },
        latency: '61', latencyAge: '18m', marker: 'C', proto: 'VLESS', egressIp: '203.0.113.10', security: 'TLS', transport: 'WS', sni: 'example.com', host: 'cdn.example.com', family: 'IPv4', domain: 'example.com', core: 'clash', kind: 'Normal', identity: 'normal|clash|vless|2.2.2.2|8443|example.com'
    },
    {
        label: 'Fragment chain', index: 3, address: 'example.com', port: 443, countryCode: 'US',
        geo: { ip: '203.0.113.10', countryCode: 'US', country: 'United States', city: 'Ashburn', region: 'Virginia', isp: 'Cloudflare', asn: 'AS13335', type: 'hosting', cachedAt: Date.now() - 3 * 60 * 60_000 },
        marker: 'F', proto: 'VLESS', chain: true, egressIp: '203.0.113.10', security: 'TLS', transport: 'WS', sni: 'example.com', host: 'example.com', family: 'Domain', domain: 'example.com', core: 'xray', kind: 'Chain', identity: 'chain|xray|vless|example.com|443|example.com'
    },
    {
        label: 'Warp endpoint', index: 4, address: '162.159.192.1', port: 2408, countryCode: 'US',
        geo: { ip: '162.159.192.1', countryCode: 'US', country: 'United States', city: 'Seattle', region: 'Washington', isp: 'Cloudflare', asn: 'AS13335', type: 'hosting', cachedAt: Date.now() - 5 * 60 * 60_000 },
        latency: '77', latencyAge: '1h', marker: 'Warp', proto: 'Warp', egressIp: '162.159.192.1', security: 'None', transport: 'WireGuard', family: 'IPv4', domain: '162.159.192.1', core: 'wireguard', kind: 'Warp', identity: 'warp|wireguard|162.159.192.1|2408'
    }
];

export function buildNamePreview(template: string, options: NameFormatOptions = {}): NamePreviewResult {
    const diagnostics = getNameTemplateDiagnostics(template);
    if (diagnostics.length || !isValidNameTemplate(template)) {
        return { diagnostics, rows: [], collisions: [] };
    }

    const registry = createNameRegistry(RESERVED_NAME_IDENTIFIERS);
    const rows = PREVIEW_CONTEXTS.map(({ label, ...context }) => {
        // Keep the representative matrix aligned with generated configs for
        // brand-only templates such as `{B}`.
        const previewContext = { brand: 'BPB', ...context };
        const rawName = formatName(renderName(template, previewContext), options);
        const finalName = uniquifyName(rawName, template, { ...previewContext, registry }, options) || '(empty → classic name)';
        return { label, rawName, finalName };
    });

    const grouped = new Map<string, string[]>();
    rows.forEach(row => {
        const labels = grouped.get(row.rawName || '(empty)') ?? [];
        labels.push(row.label);
        grouped.set(row.rawName || '(empty)', labels);
    });

    return {
        diagnostics: [],
        rows,
        collisions: [...grouped.entries()]
            .filter(([, labels]) => labels.length > 1)
            .map(([name, labels]) => ({ name, labels }))
    };
}

function flagFromCode(code?: string): string {
    const c = (code || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) return '';
    return String.fromCodePoint(...c.split('').map(ch => 0x1f1e6 + ch.charCodeAt(0) - 0x41));
}
