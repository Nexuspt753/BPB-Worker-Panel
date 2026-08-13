// Bounded error-log ring buffer in KV.
//
// Workers console logs are invisible to the panel owner, so this captures the
// recent exceptions (from renderError and the optional sweeps) into a bounded
// KV array and exposes them to the panel. It is intentionally self-contained:
// it takes `env` and never imports `@settings`, so it is unit-testable with a
// stub KV.
//
// Safety rules (same policy as the latency sweep):
//   - Every KV read/write is wrapped in try/catch. A KV outage degrades the
//     log, never the request that triggered it.
//   - Values are plain strings; no structured objects, so a future format
//     change cannot crash the reader.
//   - Secrets are redacted before anything is stored.

import { safeError } from '@common';

const ERROR_LOG_KEY = 'errorlog:list';
const ERROR_LOG_MAX = 100;

export interface ErrorLogEntry {
    ts: number;
    source: string;
    message: string;
}

// Redact anything that looks like a secret: long opaque tokens, bearer/API
// token keys, and known sensitive field names.
const SECRET_PATTERNS: RegExp[] = [
    /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu,
    /(apiToken["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{16,}/giu,
    /(password["']?\s*[:=]\s*["']?)[^"',}\s]{1,}/giu,
    /(privateKey["']?\s*[:=]\s*["']?)[A-Za-z0-9+/=]{16,}/giu,
];

export function redactSecrets(text: string): string {
    let out = text;
    for (const pattern of SECRET_PATTERNS) {
        out = out.replace(pattern, (_match, prefix: string) => `${prefix}***redacted***`);
    }
    return out;
}

export async function logError(env: Env, source: string, error: unknown): Promise<void> {
    try {
        const message = redactSecrets(safeError(error)).slice(0, 2000);
        const entry: ErrorLogEntry = { ts: Date.now(), source: source.slice(0, 64), message };
        const existing = await readErrors(env);
        existing.push(entry);
        if (existing.length > ERROR_LOG_MAX) {
            existing.splice(0, existing.length - ERROR_LOG_MAX);
        }
        await env.kv.put(ERROR_LOG_KEY, JSON.stringify(existing));
    } catch {
        // Never let logging a failure cause a failure. Intentionally silent.
    }
}

export async function readErrors(env: Env): Promise<ErrorLogEntry[]> {
    try {
        const raw = await env.kv.get(ERROR_LOG_KEY, { type: 'json' }) as ErrorLogEntry[] | null;
        if (!Array.isArray(raw)) return [];
        return raw
            .filter((entry): entry is ErrorLogEntry => entry && typeof entry === 'object'
                && typeof entry.ts === 'number' && typeof entry.source === 'string' && typeof entry.message === 'string')
            .slice(-ERROR_LOG_MAX);
    } catch {
        return [];
    }
}

export async function clearErrors(env: Env): Promise<void> {
    try {
        await env.kv.put(ERROR_LOG_KEY, JSON.stringify([]));
    } catch {
        // Ignore: the clear endpoint reports success only when the write lands.
        throw new Error('Could not clear the error log.');
    }
}
