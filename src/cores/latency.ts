// Env is a global ambient type (declared in src/types/global.d.ts) — no import.
// This module deliberately imports nothing but pure helpers from './naming' so
// it stays free of a cycle with './utils' (which imports getLatency from here).
import { normalizeAddress } from './naming';

export { splitIpAndName, cleanIpHost } from './naming';

const LATENCY_PREFIX = 'latency:';
export const LATENCY_TTL = 60 * 60 * 24; // 24h
interface LatencyEntry { ms: number; measuredAt: number; }

// Keyed on the bare address so the latency store and the geo cache agree on
// IPv6 (`latency:2606:...`, never `latency:[2606:...]`).
const latencyKey = (address: string) => `${LATENCY_PREFIX}${normalizeAddress(address)}`;

export async function getLatency(env: Env, address: string): Promise<number | null> {
    try {
        const rec = await env.kv.get(latencyKey(address), 'json') as LatencyEntry | null;
        return rec && typeof rec.ms === 'number' ? rec.ms : null;
    } catch (e) {
        console.error(e);
        return null;
    }
}

export async function setLatency(env: Env, address: string, ms: number): Promise<void> {
    try {
        await env.kv
            .put(latencyKey(address), JSON.stringify({ ms, measuredAt: Date.now() } satisfies LatencyEntry), {
                expirationTtl: LATENCY_TTL
            })
            .catch((e) => console.error(e));
    } catch (e) {
        // A missing binding throws synchronously; a latency write is optional.
        console.error(e);
    }
}

const TIMEOUT_MS = 5000;

export interface Probe {
    /** The request completed and the peer answered something. */
    reachable: boolean;
    /** The answer came from a Cloudflare edge and was not a server error. */
    healthy: boolean;
    elapsedMs: number;
}

/**
 * Probe an address and time the round-trip.
 *
 * Raw TCP probing of port 443 is blocked by the Workers runtime ("consider
 * using fetch"), so the round-trip is measured with a plain HTTP request.
 * A resolved fetch alone proves nothing about health — an unrelated host, a
 * captive portal or an error page all resolve — so `healthy` additionally
 * requires Cloudflare's fingerprint (`cf-ray`, or `server: cloudflare`) and a
 * non-5xx status. That is the fetch-side equivalent of the socket check this
 * replaced, which required `HTTP/1.x 400` plus a `cf-ray` header.
 */
export async function probeAddress(address: string): Promise<Probe> {
    const host = normalizeAddress(address);
    if (!host) return { reachable: false, healthy: false, elapsedMs: 0 };
    const target = host.includes(':') ? `[${host}]` : host; // re-bracket IPv6 for the URL

    const start = Date.now();
    try {
        const res = await fetch(`http://${target}/__down?bytes=5000`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        const elapsedMs = Date.now() - start;
        // Nothing is read from the body; release the stream so the connection is
        // not held open. Deliberately not awaited — the timing is already taken
        // and a cancel must never be able to stall the probe.
        void res.body?.cancel().catch(() => { });

        const isCloudflare = res.headers.has('cf-ray')
            || /cloudflare/i.test(res.headers.get('server') ?? '');

        return { reachable: true, healthy: isCloudflare && res.status < 500, elapsedMs };
    } catch {
        return { reachable: false, healthy: false, elapsedMs: Date.now() - start };
    }
}

/**
 * Health check used by the Proxy IP page: a proxy IP is only useful if it
 * actually relays to Cloudflare, so `ok` means healthy, not merely reachable.
 */
export async function checkLatency(address: string): Promise<{ ok: boolean; elapsedMs: number }> {
    const { healthy, elapsedMs } = await probeAddress(address);
    return { ok: healthy, elapsedMs };
}

/**
 * Measure and store the round-trip for each address a subscription may dial.
 *
 * Targets are passed in rather than derived here: the sweep runs in
 * `ctx.waitUntil`, i.e. after the response, when this isolate's module-level
 * settings may already have been replaced by a concurrent request.
 */
export async function sweepLatency(env: Env, targets: string[]): Promise<void> {
    const unique = [...new Set(targets.filter(Boolean))];
    await Promise.allSettled(unique.map(async (addr) => {
        const { reachable, elapsedMs } = await probeAddress(addr);
        if (reachable) await setLatency(env, addr, elapsedMs);
    }));
}
