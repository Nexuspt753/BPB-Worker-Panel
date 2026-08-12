import { normalizeAddress } from './naming';

export interface GeoInfo {
    ip: string;                // normalized address (brackets stripped for IPv6)
    countryCode?: string;      // e.g. "IR"
    country?: string;          // "Iran"
    region?: string;           // "Tehran Province"
    city?: string;             // "Tehran"
    isp?: string;              // "Hamrah Aval"
    asn?: string;                // "AS197207"
    type?: 'hosting' | 'mobile' | 'residential';  // derived from proxy/hosting/mobile flags
    cachedAt?: number;           // timestamp of the successful lookup
}

const GEO_URL = 'http://ip-api.com/json/';
const KV_PREFIX = 'geo:';
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days
// ip-api throttles anonymous callers (45 req/min per source IP) and answers with
// a non-success body once throttled. Cache misses too — briefly — otherwise a
// render with many addresses keeps re-asking and every name degrades to '--'.
const FAIL_TTL = 60 * 10; // 10 minutes
const TIMEOUT_MS = 5000;
const MAX_REQUESTS_PER_MINUTE = 40;
const geoMemory = new Map<string, GeoInfo>();
const requestTimes: number[] = [];

interface FailMarker { failed: true }
type CacheEntry = GeoInfo | FailMarker;

export async function resolveGeo(
    env: Env,
    address: string,
    options: { cacheOnly?: boolean } = {}
): Promise<GeoInfo | null> {
    const ip = normalizeAddress(address);
    if (!ip) return null;
    const key = `${KV_PREFIX}${ip}`;

    let stale: GeoInfo | undefined = geoMemory.get(ip);
    try {
        const cached = await env.kv.get(key, 'json') as CacheEntry | null;
        if (cached && typeof cached === 'object') {
            if ('failed' in cached && cached.failed === true) return stale ?? null;
            if ('ip' in cached && typeof cached.ip === 'string') {
                stale = cached;
                geoMemory.set(ip, cached);
                // A KV hit is authoritative and avoids a provider request.
                return cached;
            }
        }
    } catch (e) {
        console.error(e);
    }

    // A reused isolate can still serve the last successful result when KV or
    // the provider is unavailable. Cache-only mode never turns this into a
    // network request.
    if (stale && (options.cacheOnly || Date.now() - (stale.cachedAt ?? 0) < CACHE_TTL * 1000)) return stale;
    if (options.cacheOnly || !takeGeoRequestSlot()) return stale ?? null;

    try {
        const res = await fetch(
            `${GEO_URL}${encodeURIComponent(ip)}?fields=status,message,countryCode,country,region,city,isp,as,proxy,hosting,mobile`,
            { signal: AbortSignal.timeout(TIMEOUT_MS) }
        );

        // A throttled or erroring ip-api returns HTML/plain text, which would
        // throw inside json() — check the status first.
        if (!res.ok) {
            await cacheFailure(env, key);
            return stale ?? null;
        }

        const data = await res.json() as {
            status?: string;
            countryCode?: string;
            country?: string;
            region?: string;
            city?: string;
            isp?: string;
            as?: string;
            proxy?: boolean;
            hosting?: boolean;
            mobile?: boolean;
        };

        if (data.status !== 'success') {
            await cacheFailure(env, key);
            return stale ?? null;
        }

        const geo: GeoInfo = {
            ip,
            countryCode: data.countryCode,
            country: data.country,
            region: data.region,
            city: data.city,
            isp: data.isp,
            asn: data.as,
            type: data.hosting || data.proxy ? 'hosting' : data.mobile ? 'mobile' : 'residential',
            cachedAt: Date.now(),
        };
        geoMemory.set(ip, geo);

        try {
            await env.kv.put(key, JSON.stringify(geo), { expirationTtl: CACHE_TTL }).catch(() => { });
        } catch { /* a failed cache write must not discard a good lookup */ }
        return geo;
    } catch (e) {
        console.error(e);
        await cacheFailure(env, key);
        // Stale data is preferable to turning every config name into `--` when
        // ip-api is rate-limited or temporarily unreachable.
        return stale ?? null;
    }
}

function takeGeoRequestSlot(): boolean {
    const now = Date.now();
    while (requestTimes[0] != null && now - requestTimes[0] >= 60_000) requestTimes.shift();
    if (requestTimes.length >= MAX_REQUESTS_PER_MINUTE) return false;
    requestTimes.push(now);
    return true;
}

async function cacheFailure(env: Env, key: string): Promise<void> {
    const marker: FailMarker = { failed: true };
    // Wrapped: a missing binding would make `env.kv.put` throw synchronously,
    // which would reject resolveGeo and take the whole subscription down over a
    // cache write that is only an optimization.
    try {
        await env.kv.put(key, JSON.stringify(marker), { expirationTtl: FAIL_TTL }).catch(() => { });
    } catch { /* geo caching is best-effort */ }
}
