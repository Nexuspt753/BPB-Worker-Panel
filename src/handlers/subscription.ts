import { getClNormalConfig, getClWarpConfig } from '@cores/clash/configs';
import { getURLConfigs } from '@cores/common';
import { getSbCustomConfig, getSbWarpConfig } from '@cores/sing-box/configs';
import { getXrCustomConfigs, getXrWarpConfigs } from '@cores/xray/configs';
import { setSettings, getSettings, getGlobals, getKvSettings, getSharedSettings } from '@settings';
import { fallback } from './utils';
import { getWireguardConfigs } from '@cores/wireguard';
import { HttpStatus } from '@common';
import { SharedSettings } from '#types/settings';
import { sweepLatency } from '@cores/latency';
import { getConfigAddresses } from '@cores/utils';

export async function handleSubscriptions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await setSettings(env);
    const { pathname, client } = getGlobals();
    const path = pathname.split('/')[3];

    // Never let the optional latency sweep break a subscription fetch.
    await maybeSweepLatency(env, ctx, path).catch(e => console.error(e));

    switch (path) {
        case 'normal':
            switch (client) {
                case 'xray':
                    return getXrCustomConfigs(false, env);

                case 'sing-box':
                    return getSbCustomConfig(false, env);

                case 'clash':
                    return getClNormalConfig(env);

                default:
                    break;
            }

        case 'raw':
            switch (client) {
                case 'xray':
                case 'sing-box':
                    return getURLConfigs(env);

                default:
                    break;
            }

        case 'fragment':
            switch (client) {
                case 'xray':
                    return getXrCustomConfigs(true, env);

                case 'sing-box':
                    return getSbCustomConfig(true, env);

                default:
                    break;
            }

        case 'warp':
            switch (client) {
                case 'xray':
                    return getXrWarpConfigs(false, false);

                case 'sing-box':
                    return getSbWarpConfig();

                case 'clash':
                    return getClWarpConfig(false);

                case 'wireguard':
                    return getWireguardConfigs(false);

                default:
                    break;
            }

        case 'warp-pro':
            switch (client) {
                case 'xray':
                    return getXrWarpConfigs(true, false);

                case 'xray-knocker':
                    return getXrWarpConfigs(true, true);

                case 'clash':
                    return getClWarpConfig(true);

                case 'amnezia':
                    return getWireguardConfigs(true);

                default:
                    break;
            }

        case 'share-settings':
            return shareSettings();

        default:
            return fallback(request);
    }
}

/**
 * Lazy latency auto-test. Cheap KV gets only, and only for real subscription
 * paths so a 404 fallback does not pay the cost. The re-arm timestamp is written
 * BEFORE the sweep fires, so concurrent requests cannot stampede it.
 *
 * The sweep runs in `ctx.waitUntil`, i.e. after the response, by which point
 * this isolate's module-level settings may belong to another request — so the
 * target list is resolved here, while the settings are still ours.
 */
const SWEEP_PATHS = new Set(['normal', 'fragment', 'raw']);
const MIN_SWEEP_INTERVAL_MIN = 10;

async function maybeSweepLatency(env: Env, ctx: ExecutionContext, path: string): Promise<void> {
    if (!env?.kv || !SWEEP_PATHS.has(path)) return;

    const { latencyAutoTest, latencyIntervalMin, mainDomain, customDomain } = getSettings();
    if (!latencyAutoTest) return;

    // Clamp: a hand-crafted settings PUT could otherwise set 0 and turn "due"
    // permanently true, sweeping on every single subscription request.
    const interval = Math.max(MIN_SWEEP_INTERVAL_MIN, Number(latencyIntervalMin) || MIN_SWEEP_INTERVAL_MIN);

    const last = Number(await env.kv.get('latencySweepAt') ?? 0);
    const due = !Number.isFinite(last) || last <= 0 || Date.now() - last >= interval * 60_000;
    if (!due) return;

    await env.kv.put('latencySweepAt', String(Date.now()));

    const domains = [mainDomain].concat(customDomain ? [customDomain] : []);
    const targets: string[] = [];
    for (const domain of domains) {
        if (!domain) continue;
        const addrs = await getConfigAddresses(domain, false).catch(() => [] as string[]);
        targets.push(...addrs);
    }

    ctx.waitUntil(sweepLatency(env, targets).catch(() => { }));
}

async function shareSettings() {
    const sharedSettings: SharedSettings = getSharedSettings();
    const body = btoa(JSON.stringify(sharedSettings));

    return new Response(body, {
        status: HttpStatus.OK,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename=${_project_SM_}-settings.dat`,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    });
}