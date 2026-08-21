import { getSettings } from '@settings';
import { base64DecodeUtf8, safeError } from '@common';
import { UpstreamProxy } from '#types/settings';
import { resolveGeo, type GeoInfo } from './geo';
import { compileNameTemplate, renderCompiledName, uniquifyName, registerFallbackName, normalizeAddress as normalize, cleanIpHost, splitIpAndName, findAddressGroup, formatCacheAge, nameSnapshotKey, MIN_NAME_MAX_LENGTH, type NameContext, type NameRegistry } from './naming';
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
    'FLAG', 'COUNTRY', 'COUNTRY_CODE', 'CITY', 'REGION', 'ISP', 'ASN', 'TYPE', 'GEO_AGE', 'GEO_SOURCE', 'F', 'C'
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
    const seen = new Set<string>();
    return concatIf(addrs, !isFragment, customCdnAddrs).filter(Boolean).filter(address => {
        const key = normalize(address);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Render a configured name for config types that do not have a dial address. */
export function getConfiguredName(
    fallback: string,
    context: NameContext,
    namingSettings: ReturnType<typeof getSettings> = getSettings()
): string {
    const { nameTemplate, nameFormat, nameMaxLength, nameAddressGroups } = namingSettings;
    if (!nameTemplate || !nameTemplate.trim()) return fallback;

    const nameContext: NameContext = {
        ...context,
        brand: context.brand ?? _project_,
        group: context.group ?? findAddressGroup(context.address, nameAddressGroups),
        geoSource: context.geoSource ?? (context.geo ? 'cached' : undefined)
    };
    const mode: 'readable' | 'compact' | 'ascii' = nameFormat === 'compact' || nameFormat === 'ascii'
        ? nameFormat
        : 'readable';
    const maxLength = Number.isInteger(nameMaxLength)
        && (nameMaxLength === 0 || (nameMaxLength >= MIN_NAME_MAX_LENGTH && nameMaxLength <= 200))
        ? nameMaxLength || undefined
        : undefined;
    const options = { mode, maxLength };
    const compiled = compileNameTemplate(nameTemplate);
    if (!compiled) return registerFallbackName(fallback, nameContext, options);
    const rendered = renderCompiledName(compiled, nameContext);
    if (!rendered.trim() || rendered.trim() === '--') return registerFallbackName(fallback, nameContext, options);

    const configured = uniquifyName(rendered, compiled, nameContext, options);
    return configured || registerFallbackName(fallback, nameContext, options);
}

interface FrozenNameSnapshot {
    version: 1;
    geo: Pick<GeoInfo, 'ip' | 'countryCode' | 'country' | 'region' | 'city' | 'isp' | 'asn' | 'type' | 'cachedAt'>;
    egressIp?: string;
    geoSource?: NameContext['geoSource'];
}

function snapshotGeo(geo: GeoInfo): FrozenNameSnapshot['geo'] {
    return {
        ip: geo.ip,
        countryCode: geo.countryCode,
        country: geo.country,
        region: geo.region,
        city: geo.city,
        isp: geo.isp,
        asn: geo.asn,
        type: geo.type,
        cachedAt: geo.cachedAt
    };
}

function parseFrozenNameSnapshot(value: string): FrozenNameSnapshot | null {
    try {
        const parsed = JSON.parse(value) as Partial<FrozenNameSnapshot>;
        if (parsed?.version !== 1 || !parsed.geo || typeof parsed.geo.ip !== 'string') return null;
        return parsed as FrozenNameSnapshot;
    } catch {
        return null;
    }
}

export async function getConfiguredNameSnapshot(
    env: Env,
    fallback: string,
    context: NameContext,
    namingSettings: ReturnType<typeof getSettings> = getSettings()
): Promise<string> {
    const settings = namingSettings;
    if (!settings.nameFreezeGeo || !settings.nameTemplate?.trim()) return getConfiguredName(fallback, context, settings);

    const compiled = compileNameTemplate(settings.nameTemplate);
    // Freezing matters for both geo fields and the explicit egress-address
    // token. This keeps logical non-geo names out of KV and avoids making
    // latency or other dynamic tokens stale just because the option is enabled.
    if (!compiled || (!compiled.geoTokens.size && !compiled.requiresEgress)) {
        return getConfiguredName(fallback, context, settings);
    }

    const nameContext: NameContext = {
        ...context,
        brand: context.brand ?? _project_,
        group: context.group ?? findAddressGroup(context.address, settings.nameAddressGroups),
        geoSource: context.geoSource ?? (context.geo ? 'cached' : undefined)
    };
    if (!nameContext.geo) return getConfiguredName(fallback, nameContext, settings);

    // The snapshot key contains the stable config identity and canonical
    // template, but never latency or cache age. On later requests we restore
    // only the geo record, so {LATENCY}, {LATENCY_AGE}, and other dynamic tokens
    // can update without silently unfreezing country/city/ISP values.
    const key = nameSnapshotKey(settings.nameTemplate, nameContext);
    try {
        const saved = await env.kv.get(key);
        if (saved) {
            const snapshot = parseFrozenNameSnapshot(saved);
            if (snapshot) {
                return getConfiguredName(fallback, {
                    ...nameContext,
                    geo: snapshot.geo,
                    egressIp: snapshot.egressIp ?? nameContext.egressIp,
                    geoSource: snapshot.geoSource ?? 'cached'
                }, settings);
            }

            // Values written by version 4 were plain rendered names. Read them
            // once for compatibility; new writes use the structured record so
            // dynamic tokens are no longer frozen with geo.
            if (!nameContext.registry || !nameContext.registry.names.has(saved)) {
                nameContext.registry?.names.add(saved);
                return saved;
            }
            return getConfiguredName(fallback, nameContext, settings);
        }
    } catch (error) {
        console.error(error);
    }

    const generated = getConfiguredName(fallback, nameContext, settings);
    const snapshot: FrozenNameSnapshot = {
        version: 1,
        geo: snapshotGeo(nameContext.geo),
        egressIp: nameContext.egressIp,
        geoSource: nameContext.geoSource
    };
    try {
        await env.kv.put(key, JSON.stringify(snapshot), { expirationTtl: 60 * 60 * 24 * 365 }).catch(() => { });
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

    const compiled = compileNameTemplate(settings.nameTemplate);
    if (!compiled) return getConfiguredName(fallback, context, settings);
    const tokens = compiled.tokens;
    const wantsLatency = tokens.has('LATENCY') || tokens.has('LATENCY_AGE');
    const latencyRecord = wantsLatency && settings.latencyAutoTest === true && context.address
        ? await memoize(`lat:${normalize(context.address)}:${context.port ?? 443}`, () => getLatencyRecord(env, context.address!, context.port ?? 443))
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
        geo = await memoize(egressMemoKey(geoMode, settings.proxyIpMode, settings.proxyIPs), () => resolveEgressGeo(env, geoMode === 'local', settings)) ?? undefined;
        if (!geo && context.address) {
            dialGeo = await memoize(`geo:${geoMode}:${normalize(context.address)}`, async () =>
                (await resolveGeo(env, context.address!, { cacheOnly: geoMode === 'local' })) ?? null
            ) ?? undefined;
            geo = dialGeo;
        }
    }

    const geoSource = context.geoSource
        ?? (geo && (settings.nameGeoMode === 'local' || settings.nameFreezeGeo) ? 'cached' : undefined)
        ?? (geo === dialGeo && dialGeo ? 'dial' : geo ? 'egress' : 'unavailable');
    const nameContext = {
        ...context,
        geo,
        geoSource,
        latency: context.latency ?? (latencyRecord?.ms != null ? String(latencyRecord.ms) : undefined),
        latencyAge: context.latencyAge ?? formatCacheAge(latencyRecord?.measuredAt),
        // Never present the dial address as an authoritative egress value.
        // `{IP}` remains the explicit dial-address token.
        egressIp: context.egressIp ?? (geoSource === 'egress' || geoSource === 'cached' ? geo?.ip : undefined)
    };

    // Do not permanently snapshot a fallback or an omitted optional geo section
    // just because cached-only mode had no data on the first request. A later
    // explicit regenerate should not be required merely because the provider or
    // cache was cold when the user enabled the feature.
    if (settings.nameFreezeGeo && needsGeoMetadata && !geo) {
        return getConfiguredName(fallback, nameContext, settings);
    }

    return getConfiguredNameSnapshot(env, fallback, nameContext, settings);
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
    const namingSettings = getSettings();
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
        httpsPorts,
        proxyIpMode,
        proxyIPs
    } = namingSettings;

    const chainSign = isChain ? '🔗 ' : '';
    const protoSign = protocol === _VL_ ? _VL_CAP_ : _TR_CAP_;

    const fragmentSign = isFragment ? 'F ' : '';
    const customDomainSign = normalize(domain) === normalize(customDomain) ? 'D ' : '';
    const customCdnSign = customCdnAddrs.some(candidate => normalize(candidate) === normalize(address)) ? 'C ' : '';
    const configType = `${fragmentSign}${customDomainSign}${customCdnSign}`;

    let addressType;
    cleanIPs.some(c => normalize(cleanIpHost(c)) === normalize(address))
        ? addressType = 'Clean IP'
        : addressType = isDomain(address) ? 'Domain' : isIPv4(address) ? 'IPv4' : isIPv6(address) ? 'IPv6' : '';

    // Precompute a host->name map from the `#`-suffixed entries in cleanIPs.
    // A named entry (`104.16.1.1#Cloudflare-DE`) shows its label in place of
    // the generic type in the classic remark and feeds the {IPNAME} token.
    const ipNameMap = new Map<string, string>();
    cleanIPs.forEach(entry => {
        const { host, name } = splitIpAndName(entry);
        if (name) ipNameMap.set(normalize(host), name);
    });
    const customCleanIpName = ipNameMap.get(normalize(address));

    // Keep the classic upstream label as the fallback, while still allowing a
    // configured template to name it consistently with the other addresses.
    const fallback = normalize(address) === normalize(upstreamServer ?? '')
        ? `💦 ${index}. ${chainSign}${protoSign} ${configType}- Upstream Proxy`
        : `💦 ${index}. ${chainSign}${protoSign} ${configType}- ${customCleanIpName || addressType} : ${port}`;

    // Route through the naming engine only when the user set a template;
    // otherwise fall back to the classic remark with zero extra lookups.
    if (nameTemplate && nameTemplate.trim()) {
        const compiled = compileNameTemplate(nameTemplate);
        if (!compiled) return fallback;
        const tokens = compiled.tokens;
        const wantsLatency = tokens.has('LATENCY') || tokens.has('LATENCY_AGE');
        // Do not reuse measurements after the opt-in auto-test is disabled.
        // Otherwise a stale KV value can keep rendering {LATENCY} for up to 24h.
        const latencyRecord = wantsLatency && latencyAutoTest === true
            ? await memoize(`lat:${normalize(address)}:${port}`, () => getLatencyRecord(env, address, port))
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
            ? await memoize(egressMemoKey(geoMode, proxyIpMode, proxyIPs), () => resolveEgressGeo(env, geoMode === 'local', { proxyIpMode, proxyIPs }))
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
        const geoSource: NameContext['geoSource'] = egress
            ? (geoMode === 'local' ? 'cached' : 'egress')
            : dialGeo ? 'dial' : 'unavailable';
        const egressIp = egress?.ip;
        const { sni, host } = selectSniHost(address, domain);
        const family = isIPv6(address) ? 'IPv6' : isIPv4(address) ? 'IPv4' : isDomain(address) ? 'Domain' : '';
        const isTLS = httpsPorts.includes(port) || normalize(address) === normalize(upstreamServer ?? '');

        const nameCtx: NameContext = {
            brand: _project_,
            index,
            address,
            port,
            geo: egressGeo,
            geoSource,
            latency: latencyRecord?.ms != null ? String(latencyRecord.ms) : undefined,
            latencyAge: formatCacheAge(latencyRecord?.measuredAt),
            customName: customCleanIpName || undefined,
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
        const rendered = renderCompiledName(compiled, nameCtx);
        if (rendered.trim() && rendered.trim() !== '--') {
            if (nameFreezeGeo && needsGeoMetadata && !egressGeo) {
                return getConfiguredName(fallback, nameCtx, namingSettings);
            }
            return getConfiguredNameSnapshot(env, fallback, nameCtx, namingSettings);
        }

        // A valid template may contain only unavailable optional values. Route
        // that case through the normal fallback path so it is formatted,
        // bounded, and registered just like every other generated name.
        return getConfiguredName(fallback, nameCtx, namingSettings);
    }

    return fallback;
}

// The egress depends on the proxy-IP settings, so it is memoized per resolved
// mode+target rather than under a bare 'egress' key.
function egressMemoKey(geoMode: string, proxyIpMode: string, proxyIPs: string[]): string {
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

async function resolveEgressGeo(
    env: Env,
    cacheOnly = false,
    namingSettings: Pick<ReturnType<typeof getSettings>, 'proxyIpMode' | 'proxyIPs'> = getSettings()
): Promise<GeoInfo | null> {
    const { proxyIpMode, proxyIPs } = namingSettings;

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
    const normalized = address.trim().replace(/\.+$/u, '');
    if (!normalized || /[\s/:@#[\]]/u.test(normalized)) return false;

    const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    const domainRegex = new RegExp(`^(?:${label}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$`, 'iu');
    if (domainRegex.test(normalized)) return true;

    // Convert Unicode hostnames to ASCII/Punycode explicitly so IDN validation
    // does not depend on URL.hostname punycode behavior. Prefer the standard
    // URL.domainToASCII; fall back to URL parsing on runtimes that lack it.
    try {
        const ascii = ((URL as unknown as { domainToASCII?: (domain: string) => string }).domainToASCII?.(normalized) ?? new URL(`http://${normalized}`).hostname).replace(/\\.+$/u, '').toLowerCase();
        return domainRegex.test(ascii);
    } catch {
        return false;
    }
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
    const isCustomAddr = customCdnAddrs.some(candidate => normalize(candidate) === normalize(address));
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

/**
 * Appends `values` to a new array when `condition` is true. When `condition` is
 * false, returns `arr` by identity (not a copy) — callers must not mutate the
 * result assuming it is a fresh array.
 */
export function concatIf<T>(arr: T[], condition: boolean, values: T | T[]): T[] {
    if (!condition) return arr;
    return Array.isArray(values) ? [...arr, ...values] : [...arr, values];
}

export function omitEmpty<T extends object>(obj: T | null | undefined): T | undefined {
    if (!obj || Object.keys(obj).length === 0) return undefined;
    return obj;
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