// Per-config usage statistics in KV.
//
// Counts subscription downloads per config name and per client, aggregated per
// UTC day, so the panel owner can see which configs are actually used. This is
// a diagnostic, opt-in feature: it is gated by the `usageTracking` setting and
// every KV write is best-effort (a KV outage degrades stats, never the
// subscription response).
//
// Self-contained: takes `env`, no `@settings` import, so it is unit-testable
// with a stub KV.

const USAGE_PREFIX = 'usage:';
const USAGE_MAX_KEYS = 5000;

function dayKey(now: Date): string {
    return now.toISOString().slice(0, 10);
}

function keyFor(day: string, configKey: string): string {
    return `${USAGE_PREFIX}${day}:${configKey}`;
}

// Derive a stable, KV-safe key from a config name. The name itself may contain
// characters KV handles fine, but whitespace and Unicode make keys harder to
// reason about; hash it for a fixed-size key. A 16-byte hex digest keeps keys
// short and collision-free in practice for a panel's config count.
export async function usageKey(name: string): Promise<string> {
    const bytes = new TextEncoder().encode(name);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}

export interface UsageEntry { n: number; lastAt: number; client?: string; name?: string }

export interface UsageRow {
    name: string;
    today: number;
    week: number;
    lastAt: number;
}

/**
 * Increment the per-config counter for the given config name and client.
 * Fire-and-forget from the caller: this resolves without throwing.
 */
export async function bumpUsage(env: Env, name: string, client: string): Promise<void> {
    try {
        const trimmed = (name ?? '').trim();
        if (!trimmed) return;
        const now = new Date();
        const key = keyFor(dayKey(now), await usageKey(trimmed));
        const existing = await env.kv.get(key, { type: 'json' }) as UsageEntry | null;
        const entry: UsageEntry = {
            n: (existing && typeof existing.n === 'number' ? existing.n : 0) + 1,
            lastAt: now.getTime(),
            client: client || undefined,
            name: trimmed
        };
        await env.kv.put(key, JSON.stringify(entry));
    } catch {
        // Best-effort stats. Never let a KV write break a subscription fetch.
    }
}

/**
 * Aggregate today and the last 7 days into per-name rows. Returns an empty list
 * on any KV failure (the panel then shows an empty table rather than a 500).
 */
export async function getUsageSummary(env: Env): Promise<UsageRow[]> {
    try {
        const now = new Date();
        const days: string[] = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
            days.push(dayKey(d));
        }
        const today = days[0];

        const rows = new Map<string, UsageRow>();
        let cursor: string | undefined;
        let scanned = 0;
        do {
            const listed = await env.kv.list({ prefix: USAGE_PREFIX, ...(cursor ? { cursor } : {}) });
            for (const key of listed.keys) {
                const entry = await env.kv.get(key.name, { type: 'json' }) as UsageEntry | null;
                if (!entry || typeof entry.n !== 'number') continue;
                const displayName = typeof entry.name === 'string' && entry.name ? entry.name : key.name;
                const row = rows.get(displayName) ?? { name: displayName, today: 0, week: 0, lastAt: 0 };
                const isToday = key.name.startsWith(`${USAGE_PREFIX}${today}:`);
                row.week += entry.n;
                if (isToday) row.today += entry.n;
                if (entry.lastAt > row.lastAt) row.lastAt = entry.lastAt;
                rows.set(displayName, row);
            }
            scanned += listed.keys.length;
            cursor = listed.list_complete ? undefined : listed.cursor || undefined;
        } while (cursor && scanned < USAGE_MAX_KEYS);

        return Array.from(rows.values()).sort((a, b) => b.week - a.week);
    } catch {
        return [];
    }
}
