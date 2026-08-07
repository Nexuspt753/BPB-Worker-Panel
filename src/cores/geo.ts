import { isIPv6 } from './utils';

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

export function normalize(address: string): string {
    // ip-api expects a bare address; strip the brackets wrapping IPv6 literals.
    return isIPv6(address) ? address.replace(/^\[|\]$/g, '') : address.trim();
}

export async function resolveGeo(env: Env, address: string): Promise<GeoInfo | null> {
    const ip = normalize(address);
    try {
        const cached = await env.kv.get(`${KV_PREFIX}${ip}`, 'json');
        if (cached) return cached as GeoInfo;
        const res = await fetch(`${GEO_URL}${ip}?fields=status,message,countryCode,country,region,city,isp,as,proxy,hosting,mobile`);
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
        if (data.status === 'fail') return null;
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
        await env.kv.put(`${KV_PREFIX}${ip}`, JSON.stringify(geo), { expirationTtl: CACHE_TTL });
        return geo;
    } catch (e) {
        console.error(e);
        return null;
    }
}
