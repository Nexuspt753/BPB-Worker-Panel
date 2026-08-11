import { normalizeAddress } from './naming';

export interface GeoInfo {
    ip: string;                // normalized address (brackets stripped for IPv6)
    countryCode?: string;      // e.g. "IR"
    country?: string;          // "Iran"
    region?: string;           // "Tehran Province"
    city?: string;             // "Tehran"
    isp?: string;              // "Hamrah Aval"
    asn?: string;              // "AS197207"
    type?: 'hosting' | 'mobile' | 'residential';  // derived from proxy/hosting/mobile flags
}

const GEO_URL = 'http://ip-api.com/json/';
const KV_PREFIX = 'geo:';
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days
// ip-api throttles anonymous callers (45 req/min per source IP) and answers with
// a non-success body once throttled. Cache misses too — briefly — otherwise a
// render with many addresses keeps re-asking and every name degrades to '--'.
const FAIL_TTL = 60 * 10; // 10 minutes
const TIMEOUT_MS = 5000;

interface FailMarker { failed: true }
type CacheEntry = GeoInfo | FailMarker;

export async function resolveGeo(env: Env, address: string): Promise<GeoInfo | null> {
    const ip = normalizeAddress(address);
    if (!ip) return null;
    const key = `${KV_PREFIX}${ip}`;

    try {
        const cached = await env.kv.get(key, 'json') as CacheEntry | null;
        if (cached) return 'failed' in cached ? null : cached;
    } catch (e) {
        console.error(e);
    }

    try {
        const res = await fetch(
            `${GEO_URL}${encodeURIComponent(ip)}?fields=status,message,countryCode,country,region,city,isp,as,proxy,hosting,mobile`,
            { signal: AbortSignal.timeout(TIMEOUT_MS) }
        );

        // A throttled or erroring ip-api returns HTML/plain text, which would
        // throw inside json() — check the status first.
        if (!res.ok) {
            await cacheFailure(env, key);
            return null;
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
            return null;
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
        };

        try {
            await env.kv.put(key, JSON.stringify(geo), { expirationTtl: CACHE_TTL }).catch(() => { });
        } catch { /* a failed cache write must not discard a good lookup */ }
        return geo;
    } catch (e) {
        console.error(e);
        await cacheFailure(env, key);
        return null;
    }
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
