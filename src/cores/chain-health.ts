// Scheduled chain-proxy health monitor.
//
// Reuses the one-shot chain test (parse + TCP probe + optional tunnel) from
// `./chain-test` and turns it into a continuous health check: the caller runs
// `maybeCheckChainHealth` from a subscription request (waitUntil) or a cron
// trigger, and this module persists the status and fires a Telegram alert only
// on status transitions (Working -> Unreachable and back).
//
// Self-contained apart from `./chain-test` (which is itself self-contained):
// it takes `env` and a `notify` callback, so the state machine is unit-testable
// without Telegram or settings.

import { testChainProxy, type ChainProxyTestResult } from './chain-test';
import { safeError } from '@common';

const CHAIN_HEALTH_KEY = 'chainHealth';
const MIN_ALERT_INTERVAL_MS = 30 * 60 * 1000; // don't spam on flap
const MIN_CHECK_INTERVAL_MS = 10 * 60 * 1000; // don't probe on every request

export interface ChainHealthState {
    status: 'ok' | 'warn' | 'fail' | 'unknown';
    summary: string;
    lastCheckAt: number;
    lastAlertAt: number | null;
    lastOkAt: number | null;
    lastFailAt: number | null;
}

export type ChainHealthNotifier = (message: string) => Promise<void>;

const initial = (): ChainHealthState => ({
    status: 'unknown',
    summary: '',
    lastCheckAt: 0,
    lastAlertAt: null,
    lastOkAt: null,
    lastFailAt: null
});

export async function readChainHealth(env: Env): Promise<ChainHealthState> {
    try {
        const raw = await env.kv.get(CHAIN_HEALTH_KEY, { type: 'json' }) as ChainHealthState | null;
        if (!raw || typeof raw !== 'object') return initial();
        return {
            status: raw.status === 'ok' || raw.status === 'warn' || raw.status === 'fail' ? raw.status : 'unknown',
            summary: typeof raw.summary === 'string' ? raw.summary : '',
            lastCheckAt: typeof raw.lastCheckAt === 'number' ? raw.lastCheckAt : 0,
            lastAlertAt: typeof raw.lastAlertAt === 'number' ? raw.lastAlertAt : null,
            lastOkAt: typeof raw.lastOkAt === 'number' ? raw.lastOkAt : null,
            lastFailAt: typeof raw.lastFailAt === 'number' ? raw.lastFailAt : null
        };
    } catch {
        return initial();
    }
}

/**
 * Run one health check for the configured chain proxy. `notify` is only called
 * on a status transition (or a repeated failure after the alert throttle has
 * elapsed). Never throws: failures are recorded as a fail state, not an error.
 */
export async function checkChainHealth(
    env: Env,
    chainProxy: string,
    notify: ChainHealthNotifier,
    force = false
): Promise<ChainHealthState> {
    const trimmed = (chainProxy ?? '').trim();
    if (!trimmed) {
        return readChainHealth(env);
    }

    const previous = await readChainHealth(env);
    const now = Date.now();

    // Throttle checks: the subscription path can fire this on many requests in
    // quick succession; only re-probe after the minimum interval has elapsed.
    // The panel's manual "Check now" passes force=true to always re-probe.
    if (!force && previous.lastCheckAt > 0 && now - previous.lastCheckAt < MIN_CHECK_INTERVAL_MS) {
        return previous;
    }

    let result: ChainProxyTestResult;
    try {
        result = await testChainProxy(trimmed);
    } catch (error) {
        result = {
            status: 'fail',
            protocol: '',
            server: '',
            port: 0,
            tcpReachable: false,
            tcpLatencyMs: null,
            tcpError: safeError(error),
            tunnelTested: false,
            summary: `Unreachable: ${safeError(error)}`
        };
    }

    const status: ChainHealthState['status'] = result.status === 'ok' ? 'ok' : result.status === 'warn' ? 'warn' : 'fail';

    const next: ChainHealthState = {
        status,
        summary: result.summary,
        lastCheckAt: now,
        lastAlertAt: previous.lastAlertAt,
        lastOkAt: status === 'ok' ? now : previous.lastOkAt,
        lastFailAt: status === 'fail' ? now : previous.lastFailAt
    };

    // Alert on transition (unknown -> anything counts as a transition), or on a
    // repeated failure after the throttle window has passed.
    const transitioned = previous.status !== status;
    const throttleElapsed = previous.lastAlertAt == null || now - previous.lastAlertAt >= MIN_ALERT_INTERVAL_MS;
    const shouldAlert = transitioned && (status === 'fail' || status === 'ok') || (status === 'fail' && throttleElapsed);

    if (shouldAlert) {
        next.lastAlertAt = now;
        try {
            await notify(buildAlertText(status, result.summary));
        } catch (error) {
            console.error('[chain-health]', safeError(error));
        }
    }

    try {
        await env.kv.put(CHAIN_HEALTH_KEY, JSON.stringify(next));
    } catch (error) {
        console.error('[chain-health]', safeError(error));
    }

    return next;
}

function buildAlertText(status: ChainHealthState['status'], summary: string): string {
    const icon = status === 'ok' ? '✅' : status === 'fail' ? '🔴' : '🟡';
    const label = status === 'ok' ? 'WORKING' : status === 'fail' ? 'UNREACHABLE' : 'REACHABLE';
    return `${icon} <b>Chain Proxy ${label}</b>\n${summary}`;
}
