// Env is a global ambient type (declared in src/types/global.d.ts) — no import.
// This module deliberately imports only the socket primitive and pure helpers;
// it stays independent from './utils', which imports latency records here.
import { connect } from 'cloudflare:sockets';
import { normalizeAddress } from './naming';

export { splitIpAndName, cleanIpHost } from './naming';

const LATENCY_PREFIX = 'latency:';
export const LATENCY_TTL = 60 * 60 * 24; // 24h
export interface LatencyEntry { ms: number; measuredAt: number; port?: number; }

// Keep the old address-only key for the default HTTPS probe so existing cached
// measurements remain useful. Non-default ports get an endpoint-specific key;
// otherwise a healthy port 443 sample could be incorrectly shown for port 80.
const latencyKey = (address: string, port = 443) => {
    const host = normalizeAddress(address);
    return port === 443 ? `${LATENCY_PREFIX}${host}` : `${LATENCY_PREFIX}${host}:${port}`;
};

export async function getLatencyRecord(env: Env, address: string, port = 443): Promise<LatencyEntry | null> {
    try {
        const rec = await env.kv.get(latencyKey(address, port), 'json') as LatencyEntry | null;
        if (!rec
            || typeof rec.ms !== 'number'
            || !Number.isFinite(rec.ms)
            || rec.ms < 0
            || typeof rec.measuredAt !== 'number'
            || !Number.isFinite(rec.measuredAt)
            || rec.measuredAt <= 0
            || (rec.port != null && (!Number.isInteger(rec.port) || rec.port < 1 || rec.port > 65535))
            || (rec.port != null && rec.port !== port)) return null;
        return { ...rec, port: rec.port ?? 443 };
    } catch (e) {
        console.error(e);
        return null;
    }
}

export async function getLatency(env: Env, address: string, port = 443): Promise<number | null> {
    const rec = await getLatencyRecord(env, address, port);
    return rec?.ms ?? null;
}

/**
 * Read-only listing of every cached latency record for the endpoint health
 * viewer. Best-effort: returns an empty list on any KV failure.
 */
export async function getLatencyRecords(env: Env): Promise<Array<{ address: string; port: number; ms: number; measuredAt: number }>> {
    try {
        const listed = await env.kv.list({ prefix: LATENCY_PREFIX });
        const out: Array<{ address: string; port: number; ms: number; measuredAt: number }> = [];
        for (const key of listed.keys) {
            const rec = await env.kv.get(key.name, { type: 'json' }) as LatencyEntry | null;
            if (!rec || typeof rec.ms !== 'number' || typeof rec.measuredAt !== 'number') continue;
            const rest = key.name.slice(LATENCY_PREFIX.length);
            // Keys are either "host" (port 443) or "host:port" (non-default).
            const colon = rest.lastIndexOf(':');
            const looksLikePort = colon !== -1 && /^\d+$/.test(rest.slice(colon + 1));
            const address = looksLikePort ? rest.slice(0, colon) : rest;
            const port = looksLikePort ? Number(rest.slice(colon + 1)) : 443;
            out.push({ address, port, ms: rec.ms, measuredAt: rec.measuredAt });
        }
        return out.sort((a, b) => a.ms - b.ms).slice(0, 500);
    } catch {
        return [];
    }
}

export async function setLatency(env: Env, address: string, ms: number, port = 443): Promise<void> {
    try {
        await env.kv
            .put(latencyKey(address, port), JSON.stringify({ ms, measuredAt: Date.now(), port } satisfies LatencyEntry), {
                expirationTtl: LATENCY_TTL
            })
            .catch((e) => console.error(e));
    } catch (e) {
        // A missing binding throws synchronously; a latency write is optional.
        console.error(e);
    }
}

const TIMEOUT_MS = 5000;
const MAX_SWEEP_CONCURRENCY = 4;
const DEFAULT_SNI = 'speed.cloudflare.com';

export interface Probe {
    /** The request completed and the peer returned an HTTP status line. */
    reachable: boolean;
    /** The answer came from a Cloudflare edge and was not a server error. */
    healthy: boolean;
    elapsedMs: number;
}

/**
 * Probe an address on Cloudflare's proxy port.
 *
 * A normal fetch to `http://address/...` uses port 80 and therefore does not
 * test the port-443 proxy IPs used by BPB. Use the Workers socket API instead,
 * matching the original proxy-IP checker: send plaintext HTTP to port 443 with
 * Cloudflare's speed-test host header and inspect the edge response.
 */
export async function probeAddress(address: string, port = 443): Promise<Probe> {
    const host = normalizeAddress(address);
    if (!host) return { reachable: false, healthy: false, elapsedMs: 0 };

    const start = Date.now();
    let socket: ReturnType<typeof connect> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    // A timeout can win the race before connect() assigns the socket. Cleanup
    // is intentionally repeatable so the response task closes resources that
    // become available just after the timeout callback runs.
    const cleanup = async () => {
        const currentReader = reader;
        reader = undefined;
        try {
            await currentReader?.cancel();
        } catch { /* probe cleanup is best-effort */ }
        try {
            currentReader?.releaseLock();
        } catch { /* already released */ }

        const currentSocket = socket;
        socket = undefined;
        try {
            await currentSocket?.close();
        } catch { /* probe cleanup is best-effort */ }
    };

    try {
        // Cover connect, write, and the first response bytes with one deadline.
        // A TCP connect/write can otherwise remain pending forever even though
        // the read-side timeout has fired, exhausting a Worker isolate during a
        // sweep of dead addresses.
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                void cleanup();
                reject(new Error('latency probe timeout'));
            }, TIMEOUT_MS);
        });
        const responsePromise = (async () => {
            try {
                socket = connect({ hostname: host, port });
                if (timedOut) throw new Error('latency probe timeout');

                const writer = socket.writable.getWriter();
                try {
                    await writer.write(new TextEncoder().encode(
                        `GET /__down?bytes=5000 HTTP/1.1\r\nHost: ${DEFAULT_SNI}\r\nConnection: close\r\n\r\n`
                    ));
                } finally {
                    writer.releaseLock();
                }

                if (timedOut) throw new Error('latency probe timeout');
                reader = socket.readable.getReader();
                let response = '';
                const decoder = new TextDecoder();
                while (response.length < 8192 && !response.includes('\r\n\r\n')) {
                    const { value, done } = await reader.read();
                    if (done || !value) break;
                    response += decoder.decode(value, { stream: true });
                }
                return response;
            } finally {
                if (timedOut) await cleanup();
            }
        })();

        const response = await Promise.race([responsePromise, timeoutPromise]);
        const status = Number(response.match(/^HTTP\/1\.[01]\s+(\d{3})/u)?.[1] ?? 0);
        const isCloudflare = /(?:^|\r\n)cf-ray:/iu.test(response)
            || /(?:^|\r\n)server:\s*cloudflare/iu.test(response);

        return {
            reachable: status > 0,
            healthy: status > 0 && isCloudflare && status < 500,
            elapsedMs: Date.now() - start
        };
    } catch {
        return {
            reachable: false,
            healthy: false,
            elapsedMs: Date.now() - start
        };
    } finally {
        if (timer) clearTimeout(timer);
        timedOut = true;
        await cleanup();
    }
}

/**
 * Health check used by the Proxy IP page: a proxy IP is only useful if it
 * actually relays to Cloudflare, so `ok` means healthy, not merely reachable.
 */
export async function checkLatency(address: string, port = 443): Promise<{ ok: boolean; elapsedMs: number }> {
    const { healthy, elapsedMs } = await probeAddress(address, port);
    return { ok: healthy, elapsedMs };
}

/**
 * Measure and store the round-trip for each address a subscription may dial.
 *
 * Targets are passed in rather than derived here: the sweep runs in
 * `ctx.waitUntil`, i.e. after the response, when this isolate's module-level
 * settings may already have been replaced by a concurrent request.
 */
export interface LatencyTarget {
    address: string;
    port?: number;
}

export async function sweepLatency(env: Env, targets: Array<string | LatencyTarget>): Promise<void> {
    const unique = [...new Map(targets
        .map(target => typeof target === 'string' ? { address: target, port: 443 } : target)
        .map(target => ({ ...target, address: normalizeAddress(target.address), port: target.port || 443 }))
        .filter(target => target.address && Number.isInteger(target.port) && target.port >= 1 && target.port <= 65535)
        .map(target => [`${target.address}|${target.port}`, target] as const)).values()];
    let cursor = 0;
    const worker = async () => {
        while (cursor < unique.length) {
            const target = unique[cursor++];
            const { healthy, elapsedMs } = await probeAddress(target.address, target.port);
            // A reachable non-Cloudflare host is not a useful proxy latency
            // sample; keep the last good measurement instead of poisoning it.
            if (healthy) await setLatency(env, target.address, elapsedMs, target.port);
        }
    };

    await Promise.allSettled(
        Array.from({ length: Math.min(MAX_SWEEP_CONCURRENCY, unique.length) }, worker)
    );
}
