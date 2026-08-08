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

export async function handleSubscriptions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await setSettings(env);
    const { pathname, client } = getGlobals();
    const path = pathname.split('/')[3];

    // Lazy latency auto-test — cheap KV gets only; writes the re-arm timestamp BEFORE firing (stampede guard).
    // Runs only for real sub paths so a 404 fallback does not pay the cost. settings is already in scope
    // (setSettings loaded it above) — do not call setSettings again.
    if (env?.kv) {
        const settings = getSettings();
        if (settings.latencyAutoTest) {
            const last = Number(await env.kv.get('latencySweepAt') ?? 0);
            const due = last <= 0 || Date.now() - last >= settings.latencyIntervalMin * 60_000;
            if (due) {
                await env.kv.put('latencySweepAt', String(Date.now()));
                ctx.waitUntil(sweepLatency(env).catch(() => {}));
            }
        }
    }

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