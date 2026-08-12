import { getClNormalConfig, getClWarpConfig } from '@cores/clash/configs';
import { getURLConfigs } from '@cores/common';
import { getSbCustomConfig, getSbWarpConfig } from '@cores/sing-box/configs';
import { getXrCustomConfigs, getXrWarpConfigs } from '@cores/xray/configs';
import { setSettings, getSettings, getGlobals, getKvSettings, getSharedSettings } from '@settings';
import { fallback } from './utils';
import { getWireguardConfigs } from '@cores/wireguard';
import { HttpStatus } from '@common';
import { SharedSettings } from '#types/settings';
import { sweepLatency, type LatencyTarget } from '@cores/latency';
import { cleanIpHost } from '@cores/naming';
import { parseHostPort, resolveDNS } from '@cores/utils';

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
                    return getXrWarpConfigs(false, false, env);

                case 'sing-box':
                    return getSbWarpConfig(env);

                case 'clash':
                    return getClWarpConfig(false, env);

                case 'wireguard':
                    return getWireguardConfigs(false, env);

                default:
                    break;
            }

        case 'warp-pro':
            switch (client) {
                case 'xray':
                    return getXrWarpConfigs(true, false, env);

                case 'xray-knocker':
                    return getXrWarpConfigs(true, true, env);

                case 'clash':
                    return getClWarpConfig(true, env);

                case 'amnezia':
                    return getWireguardConfigs(true, env);

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
const SWEEP_PATHS = new Set(['normal', 'fragment', 'raw', 'warp', 'warp-pro']);
const MIN_SWEEP_INTERVAL_MIN = 10;
let sweepClaimUntil = 0;

async function maybeSweepLatency(env: Env, ctx: ExecutionContext, path: string): Promise<void> {
    if (!env?.kv || !SWEEP_PATHS.has(path)) return;

    const {
        latencyAutoTest,
        latencyIntervalMin,
        mainDomain,
        customDomain,
        warpEndpoints,
        enableIPv6,
        cleanIPs,
        customCdnAddrs,
        ports,
        httpsPorts,
        upstreamParams: { upstreamServer, upstreamPort }
    } = getSettings();
    if (latencyAutoTest !== true) return;

    // Clamp: a hand-crafted settings PUT could otherwise set 0 and turn "due"
    // permanently true, sweeping on every single subscription request.
    const interval = Math.max(MIN_SWEEP_INTERVAL_MIN, Number(latencyIntervalMin) || MIN_SWEEP_INTERVAL_MIN);

    const now = Date.now();
    if (sweepClaimUntil > now) return;

    let last: number;
    try {
        last = Number(await env.kv.get('latencySweepAt') ?? 0);
    } catch (error) {
        console.error(error);
        return;
    }
    const due = !Number.isFinite(last) || last <= 0 || now - last >= interval * 60_000;
    if (!due) return;

    // KV has no compare-and-swap operation. This short-lived in-memory claim
    // prevents concurrent requests in the same isolate from starting duplicate
    // sweeps; the KV timestamp still throttles separate isolates.
    sweepClaimUntil = now + interval * 60_000;
    try {
        await env.kv.put('latencySweepAt', String(now));
    } catch (error) {
        // The sweep is optional. Keep the in-memory claim and continue so a KV
        // write outage cannot turn a subscription request into an error.
        console.error(error);
    }

    // Resolve DNS and collect targets inside waitUntil. The old implementation
    // did this before returning the subscription, so a slow DoH provider could
    // make an otherwise unrelated config download feel broken.
    ctx.waitUntil((async () => {
        const targets: LatencyTarget[] = [];
        const seenTargets = new Set<string>();
        const addTarget = (address: string | undefined, port = 443) => {
            const host = address ? parseHostPort(address, true).host || cleanIpHost(address) : '';
            if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return;
            const key = `${host.toLowerCase()}|${port}`;
            if (seenTargets.has(key)) return;
            seenTargets.add(key);
            targets.push({ address: host, port });
        };

        if (path === 'warp' || path === 'warp-pro') {
            for (const endpoint of warpEndpoints ?? []) {
                const { host, port } = parseHostPort(endpoint, true);
                addTarget(host, port || 443);
            }
        } else {
            const domains = [mainDomain].concat(customDomain ? [customDomain] : []);
            addTarget(upstreamServer, upstreamPort || 443);
            const isFragment = path === 'fragment';
            for (const domain of domains) {
                if (!domain) continue;
                const { ipv4, ipv6 } = await resolveDNS(domain, !enableIPv6).catch(() => ({ ipv4: [], ipv6: [] }));
                const addresses = [
                    domain,
                    ...ipv4,
                    ...(enableIPv6 ? ipv6.map(ip => `[${ip}]`) : []),
                    ...cleanIPs.map(cleanIpHost),
                    ...(isFragment ? [] : customCdnAddrs)
                ];
                const configPorts = ports.filter(port => (!isFragment && domain.endsWith('workers.dev')) || httpsPorts.includes(port));
                for (const address of addresses) {
                    for (const port of configPorts) addTarget(address, port);
                }
            }
        }
        await sweepLatency(env, targets);
    })().catch((error) => console.error('[latency-sweep]', error)));
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