// Env is a global ambient type (declared in src/types/global.d.ts) — no import.
import { getConfigAddresses } from './utils';
import { getSettings } from '@settings';
import { connect } from 'cloudflare:sockets';

const LATENCY_PREFIX = 'latency:';
export const LATENCY_TTL = 60 * 60 * 24; // 24h
interface LatencyEntry { ms: number; measuredAt: number; }

export function splitIpAndName(entry: string): { host: string; name: string } {
    const idx = entry.indexOf('#');
    if (idx === -1) return { host: entry.trim(), name: '' };
    return {
        host: entry.slice(0, idx).trim(),
        name: entry.slice(idx + 1).trim(),
    };
}
export function cleanIpHost(entry: string): string { return splitIpAndName(entry).host; }

export async function getLatency(env: Env, address: string): Promise<number | null> {
    const rec = await env.kv.get(`${LATENCY_PREFIX}${address}`, 'json') as LatencyEntry | null;
    return rec && typeof rec.ms === 'number' ? rec.ms : null;
}

export async function setLatency(env: Env, address: string, ms: number): Promise<void> {
    const rec: LatencyEntry = { ms, measuredAt: Date.now() };
    await env.kv.put(`${LATENCY_PREFIX}${address}`, JSON.stringify(rec), { expirationTtl: LATENCY_TTL });
}

const DEFAULT_SNI = 'speed.cloudflare.com';
const TIMEOUT_MS = 5000;
export async function checkLatency(address: string): Promise<{ ok: boolean; elapsedMs: number }> {
    const start = Date.now();
    const TEST_PATH = '/__down?bytes=5000';
    const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
    );
    try {
        const socket = connect({ hostname: address, port: 443 });
        const writer = socket.writable.getWriter();
        const req = `GET ${TEST_PATH} HTTP/1.1\r\nHost: ${DEFAULT_SNI}\r\nConnection: close\r\n\r\n`;
        await writer.write(new TextEncoder().encode(req));
        writer.releaseLock();
        const reader = socket.readable.getReader();
        const { value, done } = await Promise.race([reader.read(), timeout]);
        reader.releaseLock();
        await socket.close().catch(() => { });
        if (done || !value) return { ok: false, elapsedMs: Date.now() - start };
        const response = new TextDecoder().decode(value);
        const isOk = /^HTTP\/1\.[01] 400/.test(response) && /cf-ray:/i.test(response);
        return { ok: isOk, elapsedMs: Date.now() - start };
    } catch {
        return { ok: false, elapsedMs: Date.now() - start };
    }
}

export async function sweepLatency(env: Env): Promise<void> {
    const { mainDomain, customDomain } = getSettings();
    const domains = [mainDomain].concat(customDomain ? [customDomain] : []);
    const targets: string[] = [];
    for (const domain of domains) {
        const addrs = await getConfigAddresses(domain, false);
        addrs.forEach(a => { if (!targets.includes(a)) targets.push(a); });
    }
    await Promise.allSettled(targets.map(async (addr) => {
        const res = await checkLatency(addr);
        if (res.ok) await setLatency(env, addr, res.elapsedMs);
    }));
}