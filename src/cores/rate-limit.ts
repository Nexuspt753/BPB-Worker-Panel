// Per-subscription rate limiting in KV.
//
// Protects the Worker's 100K requests/day quota from a leaked or shared
// subscription link. Counts requests in hourly and daily KV windows keyed by a
// hash of the subscription path; when a window exceeds its cap the caller
// returns a clear "rate limited" response instead of a config payload.
//
// Fail-open by design: any KV read/write error lets the request through. A
// quota guard must never take the panel down — availability beats strictness.

const RL_PREFIX = 'rl:';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RateLimitSettings {
    enabled: boolean;
    perHour: number;
    perDay: number;
}

function windowKey(hash: string, windowStart: number): string {
    return `${RL_PREFIX}${hash}:${windowStart}`;
}

function hashPath(path: string): Promise<string> {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(path))
        .then(digest => Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''));
}

/**
 * Returns true when the request should be blocked. Never throws: on any KV
 * error it returns false (allow). The window counters are incremented here.
 */
export async function isRateLimited(
    env: Env,
    path: string,
    settings: RateLimitSettings
): Promise<boolean> {
    if (!settings || settings.enabled !== true) return false;
    const perHour = Number(settings.perHour) || 0;
    const perDay = Number(settings.perDay) || 0;
    if (perHour <= 0 && perDay <= 0) return false;

    try {
        const hash = await hashPath(path);
        const now = Date.now();
        const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
        const dayStart = Math.floor(now / DAY_MS) * DAY_MS;

        // Read both windows; treat missing/parse failures as zero.
        const [hourRaw, dayRaw] = await Promise.all([
            env.kv.get(windowKey(hash, hourStart)),
            env.kv.get(windowKey(hash, dayStart))
        ]);
        const hour = Number(hourRaw ?? 0) || 0;
        const day = Number(dayRaw ?? 0) || 0;

        const hourBlocked = perHour > 0 && hour >= perHour;
        const dayBlocked = perDay > 0 && day >= perDay;
        if (hourBlocked || dayBlocked) return true;

        // Increment both windows (best-effort). On a partial failure the next
        // request simply re-reads the old counts and the cap may under-count
        // slightly — acceptable for a quota guard.
        await Promise.all([
            env.kv.put(windowKey(hash, hourStart), String(hour + 1)),
            env.kv.put(windowKey(hash, dayStart), String(day + 1))
        ]);
        return false;
    } catch {
        return false;
    }
}
