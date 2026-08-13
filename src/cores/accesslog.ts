// Subscription access log in KV.
//
// Records a bounded list of recent subscription fetches (timestamp, client,
// subscription type, and a salted hash of the caller IP — never the raw IP) so
// the owner can see who is fetching what and spot a shared link being hammered.
// Opt-in via the `accessLogging` setting.
//
// Self-contained: takes `env`, no `@settings` import. Privacy by default: only
// a SHA-256(ip + secretKey) digest is stored.

import { safeError } from '@common';

const ACCESS_LOG_KEY = 'accesslog:list';
const ACCESS_LOG_MAX = 200;

export interface AccessLogEntry {
    ts: number;
    client: string;
    type: string;
    ipHash: string;
}

export function hashIp(ip: string, salt: string): Promise<string> {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}:${salt}`))
        .then(digest => Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''));
}

function normalizeIp(value: string | null | undefined): string {
    const raw = (value ?? '').split(',')[0].trim();
    return raw || 'unknown';
}

export async function logAccess(env: Env, ip: string, type: string, client: string): Promise<void> {
    try {
        let secretKey = await env.kv.get('secretKey');
        if (!secretKey) {
            secretKey = 'missing-secret';
        }
        const entry: AccessLogEntry = {
            ts: Date.now(),
            client: (client || '').slice(0, 64),
            type: (type || '').slice(0, 32),
            ipHash: await hashIp(normalizeIp(ip), secretKey)
        };
        const existing = await readAccessLog(env);
        existing.push(entry);
        if (existing.length > ACCESS_LOG_MAX) {
            existing.splice(0, existing.length - ACCESS_LOG_MAX);
        }
        await env.kv.put(ACCESS_LOG_KEY, JSON.stringify(existing));
    } catch (error) {
        console.error('[accesslog]', safeError(error));
    }
}

export async function readAccessLog(env: Env): Promise<AccessLogEntry[]> {
    try {
        const raw = await env.kv.get(ACCESS_LOG_KEY, { type: 'json' }) as AccessLogEntry[] | null;
        if (!Array.isArray(raw)) return [];
        return raw
            .filter((entry): entry is AccessLogEntry => entry && typeof entry === 'object'
                && typeof entry.ts === 'number' && typeof entry.client === 'string'
                && typeof entry.type === 'string' && typeof entry.ipHash === 'string')
            .slice(-ACCESS_LOG_MAX);
    } catch {
        return [];
    }
}
