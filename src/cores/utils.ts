import { getSettings } from '@settings';
import { base64DecodeUtf8, safeError } from '@common';
import { UpstreamProxy } from '#types/settings';
import { resolveGeo, type GeoInfo } from './geo';
import { renderName, uniquifyName, registerFallbackName, templateTokens, normalizeAddress as normalize, cleanIpHost, splitIpAndName, findAddressGroup, formatCacheAge, nameSnapshotKey, MIN_NAME_MAX_LENGTH, type NameContext, type NameRegistry } from './naming';
import { getLatencyRecord } from './latency';

// In-isolate cache for geo/latency lookups: the same address repeats across
// ports, protocols and chain variants of a single render. Entries are keyed by
// value (never by request) and expire quickly, so a reused isolate can share
// them safely — unlike a per-request map that concurrent requests would race on
// while clearing. The in-flight promise is what gets stored, so the parallel
// first lookups of one render collapse into a single call.
const MEMO_TTL_MS = 60_000;
const MEMO_MAX_ENTRIES = 500;
interface Memo<T> { value: Promise<T>; at: number; }
const memos = new Map<string, Memo<unknown>>();
const GEO_METADATA_TOKENS = new Set([
    'FLAG', 'COUNTRY', 'COUNTRY_CODE', 'CITY', 'REGION', 'ISP', 'ASN', 'TYPE', 'GEO_AGE', 'F', 'C'
]);

function memoize<T>(key: string, resolver: () => Promise<T>): Promise<T> {
    const hit = memos.get(key);
    if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value as Promise<T>;

    const value = resolver();
    if (memos.size >= MEMO_MAX_ENTRIES) memos.clear();
    memos.set(key, { value, at: Date.now() });
    // A rejection must not be cached — drop it so the next render retries.
    value.catch(() => { if (memos.get(key)?.value === value) memos.delete(key); });
    return value;
}

interface DnsResult {
    ipv4: string[];
    ipv6: string[];
}

export interface GeoAsset {
    rule: boolean;
    type: string;
    geosite: string;
    geoip?: string;
    geositeURL?: string;
    geoipURL?: string;
    dns?: string;
    format?: string;
}

export async function resolveDNS(domain: string, onlyIPv4 = false): Promise<DnsResult> {
    const dohBaseURL = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}`;
    const dohURLs = {
        ipv4: `${dohBaseURL}&type=A`,
        ipv6: `${dohBaseURL}&type=AAAA`,
    };

    try {
        const ipv4 = await fetchDNSRecords(dohURLs.ipv4, 1);
        const ipv6 = onlyIPv4 ? [] : await fetchDNSRecords(dohURLs.ipv6, 28);
        return { ipv4, ipv6 };
    } catch (error) {
        throw new Error(`Error resolving DNS for ${domain}: ${safeError(error)}`);
    }
}

export async function fetchDNSRecords(url: string, recordType: number): Promise<string[]> {
    try {
        const response = await fetch(url, { headers: { accept: 'application/dns-json' } });
        const data: any = await response.json();

        if (!data.Answer) return [];

        return data.Answer
            .filter((record: any) => record.type === recordType)
            .map((record: any) => record.data);

    } catch (error) {
        throw new Error(`Failed to fetch DNS records from ${url}: ${safeError(error)}`);
    }
}

export function getProtocols() {
    const { protocols } = getSettings();
    return protocols.split(',');
}

export async function getConfigAddresses(domain: string, isFragment: boolean): Promise<string[]> {
    const { enableIPv6, customCdnAddrs, cleanIPs } = getSettings();
    const { ipv4, ipv6 } = await resolveDNS(domain, !enableIPv6);
    const addrs = [
        domain,
        ...ipv4,
        ...ipv6.map((ip: string) => `[${ip}]`),
        ...cleanIPs.map(cleanIpHost)
    ];

    // De-duplicate: a Clean IP that also appears in the DNS answer (or is listed
    // twice) would otherwise produce two byte-identical configs — and with a
    // name template that includes {IP} but not {INDEX}, two identical names,
    // which clash and sing-box cannot both key.
    return [...new Set(addrs.concatIf(!isFragment, customCdnAddrs).filter(Boolean))];
}

/** Render a configured name for config types that do not have a dial address. */
export function getConfiguredName(fallback: string, context: NameContext): string {
    const { nameTemplate, nameFormat, nameMaxLength, nameAddressGroups } = getSettings();
    if (!nameTemplate || !nameTemplate.trim()) return fallback;

    const nameContext: NameContext = {
        ...context,
        brand: context.brand ?? _project_,
        group: context.group ?? findAddressGroup(context.address, nameAddressGroups)
    };
    const mode: 'readable' | 'compact' | 'ascii' = nameFormat === 'compact' || nameFormat === 'ascii'
        ? nameFormat
        : 'readable';
    const maxLength = Number.isInteger(nameMaxLength)
        && (nameMaxLength === 0 || (nameMaxLength >= MIN_NAME_MAX_LENGTH && nameMaxLength <= 200))
        ? nameMaxLength || undefined
        : undefined;
    const options = { mode, maxLength };
    const rendered = renderName(nameTemplate, nameContext);
    if (!rendered.trim() || rendered.trim() === '--') return registerFallbackName(fallback, nameContext, options);

    const configured = uniquifyName(rendered, nameTemplate, nameContext, options);
    return configured || registerFallbackName(fallback, nameContext, options);
}

export async function getConfiguredNameSnapshot(env: Env, fallback: string, context: NameContext): Promise<string> {
    const settings = getSettings();
    if (!settings.nameFreezeGeo || !settings.nameTemplate?.trim()) return getConfiguredName(fallback, context);

    const nameContext: NameContext = {
        ...context,
        brand: context.brand ?? _project_,
        group: context.group ?? findAddressGroup(context.address, settings.nameAddressGroups)
    };
    // Latency is deliberately not part of the geo snapshot itself. Include the
    // current measurement in the key so enabling frozen geo names does not also
    // freeze an opt-in {LATENCY} value forever.
    const key = nameSnapshotKey(
        `${settings.nameTemplate}|${settings.nameFormat}|${settings.nameMaxLength}|latency:${nameContext.latency ?? ''}|latencyAge:${nameContext.latencyAge ?? ''}`,
        nameContext
    );
    try {
        const saved = await env.kv.get(key);
        if (saved) {
            // Register a frozen value in the current output so duplicate
            // endpoints still receive a deterministic collision suffix.
            if (!nameContext.registry || !nameContext.registry.names.has(saved)) {
                nameContext.registry?.names.add(saved);
                return saved;
            }
            return getConfiguredName(fallback, nameContext);
        }
    } catch (error) {
        console.error(error);
    }

    const generated = getConfiguredName(fallback, nameContext);
    try {
        await env.kv.put(key, generated, { expirationTtl: 60 * 60 * 24 * 365 }).catch(() => { });
    } catch { /* snapshots are best-effort; the live name remains usable */ }
    return generated;
}

/**
 * Resolve the optional metadata needed by a generated name that is not tied to
 * the normal VLESS/Trojan address loop (Best Ping, Warp, and Smart Fragment).
 * Keeping this path here makes every output format use the same privacy,
 * latency, egress, and snapshot rules as ordinary remarks.
 */
export async function getConfiguredNameWithMetadata(
    env: Env,
    fallback: string,
    context: NameContext
): Promise<string> {
    const settings = getSettings();
    if (!settings.nameTemplate?.trim()) return fallback;

    const tokens = templateTokens(settings.nameTemplate);
    const wantsLatency = tokens.has('LATENCY') || tokens.has('LATENCY_AGE');
    const latencyRecord = wantsLatency && settings.latencyAutoTest === true && context.address
        ? await memoize(`lat:${normalize(context.address)}`, () => getLatencyRecord(env, context.address!))
        : null;

    const needsGeo = [
        ...GEO_METADATA_TOKENS,
        'EGRESS_IP'
    ].some(token => tokens.has(token));
    const needsGeoMetadata = [...GEO_METADATA_TOKENS].some(token => tokens.has(token));
    const geoMode = settings.nameFreezeGeo || settings.nameGeoMode === 'local'
        ? 'local'
        : settings.nameGeoMode === 'disabled' ? 'disabled' : 'auto';
    const canLookupGeo = geoMode !== 'disabled';
    let geo = context.geo;
    let dialGeo: GeoInfo | undefined;

    if (needsGeo && canLookupGeo && !geo) {
        geo = await memoize(egressMemoKey(geoMode), () => resolveEgressGeo(env, geoMode === 'local')) ?? undefined;
        if (!geo && context.address) {
            dialGeo = await memoize(`geo:${geoMode}:${normalize(context.address)}`, async () =>
                (await resolveGeo(env, context.address!, { cacheOnly: geoMode === 'local' })) ?? null
            ) ?? undefined;
            geo = dialGeo;
        }
    }

    const nameContext = {
        ...context,
        geo,
        latency: context.latency ?? (latencyRecord?.ms != null ? String(latencyRecord.ms) : undefined),
        latencyAge: context.latencyAge ?? formatCacheAge(latencyRecord?.measuredAt),
        egressIp: context.egressIp ?? geo?.ip ?? dialGeo?.ip ?? (context.address ? normalize(context.address) : undefined)
    };

    // Do not permanently snapshot a fallback or an omitted optional geo section
    // just because cached-only mode had no data on the first request. A later
    // explicit regenerate should not be required merely because the provider or
    // cache was cold when the user enabled the feature.
    if (settings.nameFreezeGeo && needsGeoMetadata && !geo) {
        return getConfiguredName(fallback, nameContext);
    }

    return getConfiguredNameSnapshot(env, fallback, nameContext);
}

export async function generateRemark(
    env: Env,
    index: number,
    port: number,
    address: string,
    protocol: string,
    domain: string,
    isFragment: boolean,
    isChain: boolean,
    core = '',
    registry?: NameRegistry
): Promise<string> {
    const {
        cleanIPs,
        customCdnAddrs,
        customDomain,
        upstreamParams: { upstreamServer },
        nameTemplate,
        latencyAutoTest,
        nameGeoMode,
        nameFreezeGeo,
        nameAddressGroups,
        httpsPorts
    } = getSettings();

    const chainSign = isChain ? '🔗 ' : '';
    const protoSign = protocol === _VL_ ? _VL_CAP_ : _TR_CAP_;

    const fragmentSign = isFragment ? 'F ' : '';
    const customDomainSign = domain === customDomain ? 'D ' : '';
    const customCdnSign = customCdnAddrs.includes(address) ? 'C ' : '';
    const configType = `${fragmentSign}${customDomainSign}${customCdnSign}`;

    let addressType;
    cleanIPs.some(c => cleanIpHost(c) === address)
        ? addressType = 'Clean IP'
        : addressType = isDomain(address) ? 'Domain' : isIPv4(address) ? 'IPv4' : isIPv6(address) ? 'IPv6' : '';

    // Keep the classic upstream label as the fallback, while still allowing a
    // configured template to name it consistently with the other addresses.
    const fallback = address === upstreamServer
        ? `💦 ${index}. ${chainSign}${protoSign} ${configType}- Upstream Proxy`
        : `💦 ${index}. ${chainSign}${protoSign} ${configType}- ${addressType} : ${port}`;

    // Route through the naming engine only when the user set a template;
    // otherwise fall back to the classic remark with zero extra lookups.
    if (nameTemplate && nameTemplate.trim()) {
        // Precompute a host->name map from the `#`-suffixed entries in cleanIPs.
        const ipNameMap = new Map<string, string>();
        cleanIPs.forEach(entry => {
            const { host, name } = splitIpAndName(entry);
            if (name) ipNameMap.set(normalize(host), name);
        });

        const tokens = templateTokens(nameTemplate);
        const wantsLatency = tokens.has('LATENCY') || tokens.has('LATENCY_AGE');
        // Do not reuse measurements after the opt-in auto-test is disabled.
        // Otherwise a stale KV value can keep rendering {LATENCY} for up to 24h.
        const latencyRecord = wantsLatency && latencyAutoTest === true
            ? await memoize(`lat:${normalize(address)}`, () => getLatencyRecord(env, address))
            : null;

        const needsGeo = [
            ...GEO_METADATA_TOKENS,
            'EGRESS_IP'
        ].some(token => tokens.has(token));
        const needsGeoMetadata = [...GEO_METADATA_TOKENS].some(token => tokens.has(token));
        // Freeze mode deliberately uses the last cached geo value and never
        // replaces a name because a provider returned newer geography.
        const geoMode = nameFreezeGeo || nameGeoMode === 'local'
            ? 'local'
            : nameGeoMode === 'disabled' ? 'disabled' : 'auto';
        const canLookupGeo = geoMode !== 'disabled';

        // Geo is resolved for the actual egress only when the template needs it.
        // A template containing just {IP}, {PORT}, or {INDEX} must not add
        // third-party requests or make subscription generation wait on them.
        const egress = needsGeo && canLookupGeo
            ? await memoize(egressMemoKey(geoMode), () => resolveEgressGeo(env, geoMode === 'local'))
            : null;
        let dialGeo: GeoInfo | undefined;

        // The dial address (for example a Cloudflare edge IP) is only a
        // fallback when the egress cannot be determined. Looking it up first
        // would needlessly hit ip-api once for every address in the subscription.
        if (needsGeo && canLookupGeo && !egress) {
            dialGeo = await memoize(`geo:${geoMode}:${normalize(address)}`, async () =>
                (await resolveGeo(env, address, { cacheOnly: geoMode === 'local' })) ?? null) ?? undefined;
        }

        const egressGeo = egress ?? dialGeo;
        const egressIp = egress?.ip ?? (dialGeo?.ip ?? normalize(address));
        const { sni, host } = selectSniHost(address, domain);
        const family = isIPv6(address) ? 'IPv6' : isIPv4(address) ? 'IPv4' : isDomain(address) ? 'Domain' : '';
        const isTLS = httpsPorts.includes(port) || address === upstreamServer;

        const nameCtx: NameContext = {
            brand: _project_,
            index,
            address,
            port,
            geo: egressGeo,
            latency: latencyRecord?.ms != null ? String(latencyRecord.ms) : undefined,
            latencyAge: formatCacheAge(latencyRecord?.measuredAt),
            customName: ipNameMap.get(normalize(address)) || undefined,
            group: findAddressGroup(address, nameAddressGroups),
            marker: configType.trim(),
            egressIp,
            proto: protoSign,
            chain: isChain,
            security: isTLS ? 'TLS' : 'None',
            transport: 'WS',
            sni,
            host,
            family,
            domain,
            core: core || 'unknown',
            kind: isChain ? 'Chain' : isFragment ? 'Fragment' : 'Normal',
            registry
        };

        // If rendering yields nothing meaningful, keep today's output.
        const rendered = renderName(nameTemplate, nameCtx);
        if (rendered.trim() && rendered.trim() !== '--') {
            if (nameFreezeGeo && needsGeoMetadata && !egressGeo) {
                return getConfiguredName(fallback, nameCtx);
            }
            return getConfiguredNameSnapshot(env, fallback, nameCtx);
        }

        // A valid template may contain only unavailable optional values. Route
        // that case through the normal fallback path so it is formatted,
        // bounded, and registered just like every other generated name.
        return getConfiguredName(fallback, nameCtx);
    }

    return fallback;
}

// The egress depends on the proxy-IP settings, so it is memoized per resolved
// mode+target rather than under a bare 'egress' key.
function egressMemoKey(geoMode = 'auto'): string {
    const { proxyIpMode, proxyIPs } = getSettings();
    return `egress:${geoMode}:${proxyIpMode}:${proxyIpMode === 'proxyip' ? (proxyIPs[0] ?? '') : ''}`;
}

// Resolve the geo of the IP traffic ACTUALLY exits from for this deployment,
// not the dialed address. In `proxyip` mode the fallback relays every (blocked)
// direct conn via a proxyIP, so the real egress is that proxyIP's IP. Otherwise
// the exit is Cloudflare's own egress, probed live from the serving PoP.
// Returns null when the egress cannot be determined (caller then falls back to
// the classic dial-address geo).
const EGRESS_IP_KEY = 'egressIp';
const EGRESS_IP_TTL = 60 * 60 * 6; // 6h — a PoP's egress IP is stable enough

async function resolveEgressGeo(env: Env, cacheOnly = false): Promise<GeoInfo | null> {
    const { proxyIpMode, proxyIPs } = getSettings();

    if (proxyIpMode === 'proxyip' && proxyIPs.length) {
        const { host } = parseHostPort(proxyIPs[0], true);
        if (!host) return null;

        let ip = host;
        if (isDomain(host)) {
            if (cacheOnly) return null;
            const { ipv4 } = await resolveDNS(host, true).catch(() => ({ ipv4: [], ipv6: [] }));
            if (ipv4.length) ip = ipv4[0];
        }

        if (isIPv4(ip) || isIPv6(ip)) return resolveGeo(env, ip, { cacheOnly });
        return null;
    }

    // Cache the probed egress IP in KV: a cold isolate would otherwise call a
    // third party on the critical path of every subscription fetch.
    const cached = await env.kv.get(EGRESS_IP_KEY).catch(() => null);
    if (cached && isIPv4(cached)) return resolveGeo(env, cached, { cacheOnly });
    if (cacheOnly) return null;

    try {
        const res = await fetch(`https://ipv4.icanhazip.com/?t=${Date.now()}`, {
            headers: { accept: 'text/plain' },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const ip = (await res.text()).trim();
        if (!isIPv4(ip)) return null;
        await env.kv.put(EGRESS_IP_KEY, ip, { expirationTtl: EGRESS_IP_TTL }).catch(() => { });
        return resolveGeo(env, ip);
    } catch {
        return null;
    }
}


export function randomUpperCase(str: string): string {
    let result = '';

    for (let i = 0; i < str.length; i++) {
        result += Math.random() < 0.5 ? str[i].toUpperCase() : str[i];
    }

    return result;
}

export function getRandomString(lengthMin: number, lengthMax: number): string {
    let result = '';
    const charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const length = Math.floor(Math.random() * (lengthMax - lengthMin + 1)) + lengthMin;

    for (let i = 0; i < length; i++) {
        result += charSet.charAt(Math.floor(Math.random() * charSet.length));
    }

    return result;
}

export function generateWsPath(protocol: string): string {
    const proto = protocol === _VL_ ? 'vl' : 'tr';
    return `/${proto}/${getRandomString(16, 32)}`;
}

export function base64ToDecimal(base64: string): number[] {
    const binaryString = atob(base64);
    const hexString = Array
        .from(binaryString)
        .map(char => char.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('');

    const decimalArray = hexString
        .match(/.{2}/g)!
        .map(hex => parseInt(hex, 16));

    return decimalArray;
}

export function isDomain(address: string): boolean {
    if (!address) return false;
    const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
    return domainRegex.test(address);
}

export function isIPv4(address: string): boolean {
    const ipv4Pattern = /^(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?:\/([0-9]|[1-2][0-9]|3[0-2]))?$/;
    return ipv4Pattern.test(address);
}

export function isIPv6(address: string): boolean {
    const ipv6Pattern = /^\[(?:(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}|(?:[a-fA-F0-9]{1,4}:){1,7}:|::(?:[a-fA-F0-9]{1,4}:){0,7}|(?:[a-fA-F0-9]{1,4}:){1,6}:[a-fA-F0-9]{1,4}|(?:[a-fA-F0-9]{1,4}:){1,5}(?::[a-fA-F0-9]{1,4}){1,2}|(?:[a-fA-F0-9]{1,4}:){1,4}(?::[a-fA-F0-9]{1,4}){1,3}|(?:[a-fA-F0-9]{1,4}:){1,3}(?::[a-fA-F0-9]{1,4}){1,4}|(?:[a-fA-F0-9]{1,4}:){1,2}(?::[a-fA-F0-9]{1,4}){1,5}|[a-fA-F0-9]{1,4}:(?::[a-fA-F0-9]{1,4}){1,6})\](?:\/(1[0-1][0-9]|12[0-8]|[0-9]?[0-9]))?$/;
    return ipv6Pattern.test(address);
}

export function isIPv4CIDR(value: string) {
    const ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:\/(?:[0-9]|[1-2][0-9]|3[0-2]))?$/;
    return ipv4CidrRegex.test(value);
}

export function isIPv6CIDR(value: string) {
    const ipv6CidrRegex = /^(?:(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}|(?:[a-fA-F0-9]{1,4}:){1,7}:|(?:[a-fA-F0-9]{1,4}:){1,6}:[a-fA-F0-9]{1,4}|(?:[a-fA-F0-9]{1,4}:){1,5}(?::[a-fA-F0-9]{1,4}){1,2}|(?:[a-fA-F0-9]{1,4}:){1,4}(?::[a-fA-F0-9]{1,4}){1,3}|(?:[a-fA-F0-9]{1,4}:){1,3}(?::[a-fA-F0-9]{1,4}){1,4}|(?:[a-fA-F0-9]{1,4}:){1,2}(?::[a-fA-F0-9]{1,4}){1,5}|[a-fA-F0-9]{1,4}:(?::[a-fA-F0-9]{1,4}){1,6}|:(?::[a-fA-F0-9]{1,4}){1,7}|::)(?:\/(?:12[0-8]|1[01]?[0-9]|[0-9]?[0-9]))?$/;
    return ipv6CidrRegex.test(value);
}

export function isValidUrl(value: string) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (err) {
        return false;
    }
}

export function isBase64(str: string): boolean {
    if (!str || str.length % 4 !== 0) return false;
    return /^[A-Za-z0-9+/=\r\n]+$/.test(str);
}

export function isHex(str: string): boolean {
    return /^(?=(?:[0-9A-Fa-f]{2})*$)[0-9A-Fa-f]+$/.test(str);
}

export function getDomain(url: string) {
    try {
        const newUrl = new URL(url);
        const host = newUrl.hostname;
        const isHostDomain = isDomain(host);

        return {
            host,
            isHostDomain
        };
    } catch {
        return {
            host: '',
            isHostDomain: false
        };
    }
}

export function selectSniHost(address: string, domain: string) {
    const { customCdnAddrs, customCdnHost, customCdnSni } = getSettings();
    const isCustomAddr = customCdnAddrs.includes(address);
    const sni = isCustomAddr ? customCdnSni : randomUpperCase(domain);
    const host = isCustomAddr ? customCdnHost : domain;

    return { host, sni, allowInsecure: isCustomAddr };
}

export function parseHostPort(input: string, brackets?: boolean): { host: string, port: number } {
    const regex = /^(?:\[(?<ipv6>.+?)\]|(?<host>[^:]+))(:(?<port>\d+))?$/;
    const match = input.match(regex);

    if (!match || !match.groups) return { host: '', port: 0 };
    const { ipv6, host: plainHost, port: portStr } = match.groups;

    let host = ipv6 ?? plainHost ?? '';
    if (brackets && ipv6) host = `[${ipv6}]`;
    const port = portStr ? Number(portStr) : 0;

    return { host, port };
}

export function isHttps(port: number): boolean {
    const { httpsPorts } = getSettings();
    return httpsPorts.includes(port);
}

const isBypass = (type: string) => type === 'direct';
const isBlock = (type: string) => type === 'block';

export function accRoutingRules(geoAssets: GeoAsset[]) {
    const {
        customBypassRules,
        customBypassSanctionRules,
        customBlockRules
    } = getSettings();

    return {
        bypass: {
            geosites: geoAssets
                .filter(rule => isBypass(rule.type))
                .map(rule => rule.geosite),
            geoips: geoAssets
                .filter(rule => isBypass(rule.type) && rule.geoip)
                .map(rule => rule.geoip!),
            domains: [
                ...customBypassRules.filter(isDomain),
                ...customBypassSanctionRules.filter(isDomain)
            ],
            ips: customBypassRules.filter(rule => !isDomain(rule))
        },
        block: {
            geosites: geoAssets
                .filter(rule => isBlock(rule.type))
                .map(rule => rule.geosite),
            geoips: geoAssets
                .filter(rule => isBlock(rule.type) && rule.geoip)
                .map(rule => rule.geoip!),
            domains: customBlockRules.filter(isDomain),
            ips: customBlockRules.filter(rule => !isDomain(rule))
        }
    };
}

export function accDnsRules(geoAssets: GeoAsset[]) {
    const {
        localDNS,
        antiSanctionDNS,
        customBypassRules,
        customBypassSanctionRules,
        customBlockRules
    } = getSettings();

    return {
        bypass: {
            localDNS: {
                geositeGeoips: geoAssets
                    .filter(({ type, geoip, dns }) => isBypass(type) && geoip && dns === localDNS)
                    .map(({ geosite, geoip }) => ({ geosite, geoip })),
                geosites: geoAssets
                    .filter(({ type, geoip, dns }) => isBypass(type) && !geoip && dns === localDNS)
                    .map(rule => rule.geosite),
                domains: customBypassRules.filter(isDomain)
            },
            antiSanctionDNS: {
                geosites: geoAssets
                    .filter(rule => isBypass(rule.type) && rule.dns === antiSanctionDNS)
                    .map(rule => rule.geosite),
                domains: customBypassSanctionRules.filter(isDomain)
            }
        },
        block: {
            geosites: geoAssets
                .filter(rule => isBlock(rule.type))
                .map(rule => rule.geosite),
            domains: customBlockRules.filter(isDomain)
        }
    };
}

export function toRange(min?: number, max?: number) {
    if (!min || !max) return undefined;
    if (min === max) return String(min);
    return `${min}-${max}`;
}

Array.prototype.concatIf = function <T>(condition: boolean, concat: T | T[]): T[] {
    if (!condition) return this;
    if (Array.isArray(concat)) return [...this, ...concat];
    return [...this, concat]
}

Object.prototype.omitEmpty = function <T>(): T | undefined {
    if (Object.keys(this).length === 0) return undefined;
    return this as T;
}

export function extractProxyParams(chainProxy: string) {
    if (!chainProxy) return {};

    let url = new URL(chainProxy);
    const protocol = url.protocol.slice(0, -1);
    const stdProtocol = protocol === 'ss' ? _SS_ : protocol.replace('socks5', 'socks');

    if (stdProtocol === _VM_) {
        const config = JSON.parse(base64DecodeUtf8(url.host));
        return {
            protocol: stdProtocol,
            uuid: config.id,
            server: config.add,
            port: +config.port,
            aid: +config.aid,
            type: config.net,
            headerType: config.type,
            serviceName: config.path,
            authority: config.authority,
            path: config.path || undefined,
            host: config.host || undefined,
            security: config.tls,
            sni: config.sni,
            fp: config.fp,
            alpn: config.alpn || undefined
        };
    }

    const configParams: Record<string, string | number | undefined> = {
        protocol: stdProtocol,
        server: url.hostname,
        port: +url.port
    };

    const parseParams = (queryParams: boolean, customParams: Record<string, string | undefined>) => {
        if (queryParams) {
            for (const [key, value] of url.searchParams) {
                configParams[key] = value || undefined;
            }
        }

        return {
            ...configParams,
            ...customParams
        };
    }

    switch (stdProtocol) {
        case _VL_:
            return parseParams(true, {
                uuid: url.username
            });

        case _TR_:
            return parseParams(true, {
                password: url.username
            });

        case _SS_:
            const auth = base64DecodeUtf8(url.username);
            const [first, ...rest] = auth.split(':');
            return parseParams(true, {
                method: first,
                password: rest.join(':')
            });

        case 'socks':
        case 'http':
            let user, pass;
            try {
                const userInfo = base64DecodeUtf8(url.username);
                if (userInfo.includes(':')) [user, pass] = userInfo.split(':');
            } catch (error) {
                user = url.username;
                pass = url.password;
            }

            return parseParams(false, {
                user: user || undefined,
                pass: pass || undefined
            });

        default:
            return {};
    }
}

export function extractUpstreamParams(upstreamProxy: string): UpstreamProxy {
    let upstreamServer, upstreamPort;
    if (upstreamProxy) ({ host: upstreamServer, port: upstreamPort } = parseHostPort(upstreamProxy, true));
    return { upstreamServer, upstreamPort };
}