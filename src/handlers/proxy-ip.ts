import { decompressGzipBase64, respond, HttpStatus } from '@common';
import { authenticate } from '@auth';
import { resolveDNS, isDomain, isIPv4, isIPv6 } from '@cores/utils';
import { checkLatency } from '@cores/latency';
import { getGlobals } from '@settings';
import { fallback } from './utils';

export async function handleProxyIPs(request: Request, env: Env): Promise<Response> {
    const { pathname } = getGlobals();
    const auth = await authenticate(request, env);
    if (!auth) {
        const url = new URL('./login', request.url)
        return Response.redirect(url, 302);
    }

    const parts = pathname.split('/');
    const path = parts.slice(2).join('/');

    switch (path) {
        case 'proxy-ip':
            return renderProxyIPs();

        case 'proxy-ip/get':
            return getProxyIPsInfo();

        case 'proxy-ip/test':
            return testProxyIP();

        default:
            return fallback(request);
    }
}

async function renderProxyIPs() {
    const str = await decompressGzipBase64(PROXY_IP_HTML_CONTENT);
    const html = str.replaceAll('__ICON__', ICON_CONTENT);

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

async function getProxyIPsInfo(): Promise<Response> {
    const ips = await resolveDNS(_public_proxy_ip_, true);
    const geoLocInfo = await geoLookupBatch(ips.ipv4);
    return respond(
        true,
        HttpStatus.OK,
        undefined,
        geoLocInfo
    );
}

interface IpApiBatchResponse {
    query: string;
    city?: string;
    country?: string;
    countryCode?: string;
    isp?: string;
    status: 'success' | 'fail';
    message?: string;
}

interface GeoResult {
    ip: string;
    city?: string;
    country?: string;
    countryCode?: string;
    isp?: string;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }

    return chunks;
}

async function geoLookupBatch(ipList: string[]): Promise<GeoResult[]> {
    const batches = chunkArray(ipList, 100);
    const results: GeoResult[] = [];

    for (const batch of batches) {
        const res = await fetch(
            'http://ip-api.com/batch?fields=query,city,country,countryCode,isp,status',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(batch),
            }
        );

        if (!res.ok) {
            throw new Error(`ip-api request failed: ${res.status}`);
        }

        const data: IpApiBatchResponse[] = await res.json();

        for (const item of data) {
            if (item.status === 'success') {
                results.push({
                    ip: item.query,
                    city: item.city,
                    country: item.country,
                    countryCode: item.countryCode,
                    isp: item.isp,
                });
            }
        }
    }

    return results;
}

const ATTEMPTS = 5;

interface Attempt {
    attempt: number;
    ok: boolean;
    elapsedMs: number;
}

async function testProxyIP() {
    const { searchParams } = getGlobals();

    const target = searchParams.get('target') ?? '';
    // The target is interpolated into a probe URL, so only accept a bare host.
    if (!isIPv4(target) && !isIPv6(target) && !isDomain(target)) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Invalid target.');
    }

    const attemptPromises = Array.from({ length: ATTEMPTS }, (_, i) =>
        checkLatency(target).then(res => ({ attempt: i + 1, ...res }))
    );

    const attempts = await Promise.all(attemptPromises);
    const successes = attempts.filter((a) => a.ok);
    const avgLatencyMs = successes.length
        ? Math.round(successes.reduce((sum, a) => sum + a.elapsedMs, 0) / successes.length)
        : null;

    return respond(true, HttpStatus.OK, '', {
        successRate: `${successes.length}/${ATTEMPTS}`,
        avgLatencyMs,
        attempts,
    });
}


