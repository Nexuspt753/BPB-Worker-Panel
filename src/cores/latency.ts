// Env is a global ambient type (declared in src/types/global.d.ts) — no import.
import { getConfigAddresses } from './utils';
import { getSettings } from '@settings';

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

const TIMEOUT_MS = 5000;
export async function checkLatency(address: string): Promise<{ ok: boolean; elapsedMs: number }> {
    // Raw TCP probing to port 443 is blocked by the Workers runtime ("consider using fetch"),
    // so measure reachability/round-trip via a plain HTTP fetch on port 80.
    const start = Date.now();
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const res = await fetch(`http://${address}/__down?bytes=5000`, {
            redirect: 'manual',
            signal: controller.signal,
        });
        clearTimeout(timer);
        return { ok: true, elapsedMs: Date.now() - start };
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