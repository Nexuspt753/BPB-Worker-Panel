import type { Balancer, Config, Observatory, Outbound } from '#types/xray';
import { getSettings, getWarpAccounts } from '@settings';
import { buildDokodemoInbound, buildMixedInbound } from './inbounds';
import { buildRoutingRules } from './routing';
import { buildDNS } from './dns';
import {
    buildChainOutbound,
    buildWebsocketOutbound,
    buildWarpOutbound,
    buildFreedomOutbound
} from './outbounds';

import { createNameRegistry, type NameRegistry } from '../naming';

import {
    getConfigAddresses,
    getConfiguredName,
    getConfiguredNameWithMetadata,
    generateRemark,
    isDomain,
    isHttps,
    parseHostPort,
    getProtocols
} from '@utils';

function buildBalancer(tag: string, selector: string, hasFallback: boolean): Balancer {
    return {
        tag,
        selector: [selector],
        strategy: {
            type: 'leastPing',
        },
        fallbackTag: hasFallback ? 'proxy-2' : undefined
    };
}

async function buildConfig(
    remark: string,
    outbounds: Outbound[],
    isBalancer: boolean,
    isChain: boolean,
    balancerFallback: boolean,
    isWarp: boolean,
    isWorkerLess: boolean,
    outboundAddrs: string[],
    domainToStaticIPs?: string,
    customDns?: string,
    customDnsHosts?: string[]
): Promise<Config> {
    const {
        fakeDNS,
        warpBestPingInterval,
        bestPingInterval,
        logLevel,
        allowLANConnection
    } = getSettings();
    let balancers, observatory;

    if (isBalancer) {
        balancers = [buildBalancer('all-proxies', 'proxy', balancerFallback)]
            .concatIf(isChain, buildBalancer('all-chains', 'chain', false));

        observatory = {
            subjectSelector: isChain ? ['chain', 'proxy'] : ['proxy'],
            probeUrl: 'https://www.gstatic.com/generate_204',
            probeInterval: `${isWarp
                ? warpBestPingInterval
                : bestPingInterval}s`,
            enableConcurrency: true
        } satisfies Observatory;
    }

    const config: Config = {
        remarks: remark,
        version: {
            min: '26.2.6'
        },
        log: {
            loglevel: logLevel,
        },
        dns: await buildDNS(outboundAddrs, isWorkerLess, isWarp, domainToStaticIPs, customDns, customDnsHosts),
        inbounds: [
            buildMixedInbound(allowLANConnection, isWorkerLess, isWorkerLess || fakeDNS),
            buildDokodemoInbound(allowLANConnection),
            // buildTunInbound(isWorkerLess, fakeDNS)
        ],
        outbounds: [
            ...outbounds,
            {
                protocol: 'dns',
                settings: {
                    rules: [
                        {
                            action: 'hijack'
                        }
                    ]
                },
                tag: 'dns-out'
            },
            {
                protocol: 'freedom',
                settings: {
                    domainStrategy: 'UseIP'
                },
                tag: 'direct'
            },
            {
                protocol: 'blackhole',
                settings: {
                    response: {
                        type: 'http'
                    }
                },
                tag: 'block'
            },
        ],
        routing: {
            domainStrategy: 'IPIfNonMatch',
            rules: buildRoutingRules(isChain, isBalancer, isWorkerLess, isWarp),
            balancers
        },
        observatory,
        policy: {
            levels: {
                0: {
                    connIdle: 300,
                    handshake: 4,
                    uplinkOnly: 1,
                    downlinkOnly: 1
                }
            },
            system: {
                statsOutboundUplink: true,
                statsOutboundDownlink: true
            }
        },
        stats: {}
    };

    return config;
}

async function addBestPingConfigs(
    configs: Config[],
    totalAddresses: string[],
    proxyOutbounds: Outbound[],
    chainOutbounds: Outbound[],
    isFragment: boolean,
    isCustomDomain: boolean,
    registry: NameRegistry,
    env: Env,
    domain?: string
) {
    totalAddresses = [...new Set(totalAddresses)];
    const isChain = !!chainOutbounds.length;
    const chainSign = isChain ? '🔗 ' : '';
    const fragmentSign = isFragment ? 'F ' : '';
    const customDomainSign = isCustomDomain ? 'D ' : '';
    const configType = `${fragmentSign}${customDomainSign}`;

    const fallbackRemark = `💦 ${chainSign}Best Ping ${configType}🚀`;
    const remark = await getConfiguredNameWithMetadata(env, fallbackRemark, {
        index: 1,
        address: totalAddresses[0],
        marker: configType.trim(),
        proto: 'Best Ping',
        chain: isChain,
        kind: 'Best Ping',
        core: 'xray',
        domain,
        identity: [
            'best-ping',
            isFragment ? 'fragment' : 'normal',
            isCustomDomain ? 'custom-domain' : 'main-domain',
            isChain ? 'chain' : 'direct',
            domain ?? '',
            ...totalAddresses.slice().sort()
        ].join('|'),
        registry
    });
    const outbounds = [
        ...chainOutbounds,
        ...proxyOutbounds
    ];

    const config = await buildConfig(remark, outbounds, true, isChain, true, false, false, totalAddresses);

    if (isChain) {
        await addBestPingConfigs(configs, totalAddresses, proxyOutbounds, [], isFragment, isCustomDomain, registry, env, domain);
    }

    configs.push(config);
}

async function addBestFragmentConfigs(
    configs: Config[],
    registry: NameRegistry,
    env: Env,
    chainProxy?: Outbound
) {
    const { mainDomain, fragmentDelayMin, fragmentDelayMax } = getSettings();
    const isChain = !!chainProxy;
    const outbounds: Outbound[] = [];
    const bestFragValues = [
        '1-5', '1-10', '10-20', '20-30',
        '30-40', '40-50', '50-60', '60-70',
        '70-80', '80-90', '90-100', '10-30',
        '20-40', '30-50', '40-60', '50-70',
        '60-80', '70-90', '80-100', '100-200'
    ];

    bestFragValues.forEach((fragLength, index) => {
        if (isChain) {
            const chain = modifyOutbound(chainProxy, `chain-${index + 1}`, `proxy-${index + 1}`);
            outbounds.push(chain);
        }

        const proxy = buildWebsocketOutbound(
            `proxy-${index + 1}`,
            _VL_,
            mainDomain,
            443,
            mainDomain,
            true,
            fragLength,
            `${fragmentDelayMin}-${fragmentDelayMax}`
        );

        outbounds.push(proxy);
    });

    const chainSign = isChain ? '🔗 ' : '';
    const fallbackRemark = `💦 ${chainSign}Smart Fragment 🧠`;
    const remark = await getConfiguredNameWithMetadata(env, fallbackRemark, {
        index: 1,
        address: mainDomain,
        domain: mainDomain,
        marker: 'F',
        proto: _VL_CAP_,
        chain: isChain,
        kind: 'Smart Fragment',
        core: 'xray',
        registry
    });
    const config = await buildConfig(
        remark,
        outbounds,
        true,
        isChain,
        false,
        false,
        false,
        [],
        mainDomain
    );

    if (chainProxy) {
        await addBestFragmentConfigs(configs, registry, env);
    }

    configs.push(config);
}

async function addWorkerlessConfigs(configs: Config[], registry: NameRegistry, env: Env) {
    const tlsFragment = buildFreedomOutbound(true, false, 'proxy');
    const udpNoise = buildFreedomOutbound(false, true, 'udp-noise');
    const httpFragment = buildFreedomOutbound(true, false, 'http-fragment', undefined, undefined, '1-1');
    const outbounds = [
        tlsFragment,
        httpFragment,
        udpNoise
    ];

    const cfDnsRemark = await getConfiguredNameWithMetadata(env, '💦 1 - Serverless 🌟', {
        index: 1,
        marker: 'Serverless',
        kind: 'Serverless',
        core: 'xray',
        domain: 'cloudflare.com',
        registry
    });
    const googleDnsRemark = await getConfiguredNameWithMetadata(env, '💦 2 - Serverless 🌟', {
        index: 2,
        marker: 'Serverless',
        kind: 'Serverless',
        core: 'xray',
        domain: 'dns.google',
        registry
    });

    const cfDnsConfig = await buildConfig(
        cfDnsRemark,
        outbounds,
        false,
        false,
        false,
        false,
        true,
        [],
        undefined,
        'cloudflare-dns.com',
        ['cloudflare.com']
    );

    const googleDnsConfig = await buildConfig(
        googleDnsRemark,
        outbounds,
        false,
        false,
        false,
        false,
        true,
        [],
        undefined,
        'dns.google',
        ['8.8.8.8', '8.8.4.4']
    );

    configs.push(cfDnsConfig, googleDnsConfig);
}

export async function getXrCustomConfigs(isFragment: boolean, env: Env): Promise<Response> {
    const nameRegistry = createNameRegistry();
    const {
        chainProxy,
        ports,
        mainDomain,
        customDomain,
        upstreamParams: { upstreamServer, upstreamPort }
    } = getSettings();

    const chainOutbound = chainProxy ? buildChainOutbound() : undefined;
    const domains = [mainDomain].concatIf(!!customDomain, customDomain);
    const protocols = getProtocols();

    const configs: Config[] = [];
    let index = 1;
    
    for (const domain of domains) {
        let totalHosts: string[] = [];
        const proxies: Outbound[] = [];
        const chains: Outbound[] = [];
        const totalPorts = ports.filter(port => !isFragment && domain.endsWith('workers.dev') || isHttps(port));
        const hosts = await getConfigAddresses(domain, isFragment);
        
        if (upstreamServer && upstreamPort && !isFragment) {
            totalPorts.unshift(upstreamPort);
            hosts.unshift(upstreamServer);
        }

        totalHosts.push(...hosts);
        for (const protocol of protocols) {
            let protocolIndex = 1;

            for (const port of totalPorts) {
                for (const host of hosts) {
                    if ((port === upstreamPort) !== (host === upstreamServer)) continue;

                    const outbound = buildWebsocketOutbound('proxy', protocol, host, port, domain, isFragment);
                    const proxy = modifyOutbound(outbound, `proxy-${index}`);
                    proxies.push(proxy);

                    const remark = await generateRemark(env, protocolIndex, port, host, protocol, domain, isFragment, false, 'xray', nameRegistry);
                    const config = await buildConfig(remark, [outbound], false, false, false, false, false, [host]);
                    configs.push(config);

                    if (chainOutbound) {
                        const remark = await generateRemark(env, protocolIndex, port, host, protocol, domain, isFragment, true, 'xray', nameRegistry);
                        const chainConfig = await buildConfig(remark, [chainOutbound, outbound], false, true, false, false, false, [host]);
                        configs.push(chainConfig);

                        const chain = modifyOutbound(chainOutbound, `chain-${index}`, `proxy-${index}`);
                        chains.push(chain);
                    }

                    protocolIndex++;
                    index++;
                }
            }
        }

        const isCustomDomain = domain === customDomain;
        await addBestPingConfigs(configs, totalHosts, proxies, chains, isFragment, isCustomDomain, nameRegistry, env, domain);
    }

    if (isFragment) {
        await addBestFragmentConfigs(configs, nameRegistry, env, chainOutbound);
        await addWorkerlessConfigs(configs, nameRegistry, env);
    }

    const fileName = isFragment ? 'fragment' : 'normal';
    return new Response(JSON.stringify(configs, null, 4), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename=${_project_SM_}-${fileName}-xray.json`,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    });
}

export async function getXrWarpConfigs(
    isPro: boolean,
    isKnocker: boolean,
    env?: Env
): Promise<Response> {
    const { warpEndpoints } = getSettings();
    const warpAccounts = getWarpAccounts();

    const proIndicator = isPro ? ' Pro ' : ' ';
    const configs: Config[] = [];
    const proxies: Outbound[] = [];
    const chains: Outbound[] = [];
    const outboundDomains: string[] = [];
    const nameRegistry = createNameRegistry();
    const stableWarpIdentity = [...warpEndpoints].sort().join('|');

    for (const [index, endpoint] of warpEndpoints.entries()) {
        const { host, port } = parseHostPort(endpoint);
        if (isDomain(host)) outboundDomains.push(host);

        const warpOutbound = buildWarpOutbound(warpAccounts[0], endpoint, false, isPro, isKnocker);
        const wowOutbound = buildWarpOutbound(warpAccounts[1], endpoint, true, isPro, isKnocker);

        const warpContext = {
            index: index + 1,
            address: host,
            port,
            marker: 'Warp',
            proto: 'Warp',
            kind: isPro ? 'Warp Pro' : 'Warp',
            core: 'xray',
            domain: host,
            security: 'None',
            transport: 'WireGuard',
            family: host.includes(':') ? 'IPv6' : isDomain(host) ? 'Domain' : 'IPv4',
            registry: nameRegistry
        };
        const wowContext = {
            index: index + 1,
            address: host,
            port,
            marker: 'WoW',
            proto: 'Warp',
            chain: true,
            kind: isPro ? 'WoW Pro' : 'WoW',
            core: 'xray',
            domain: host,
            security: 'None',
            transport: 'WireGuard',
            family: host.includes(':') ? 'IPv6' : isDomain(host) ? 'Domain' : 'IPv4',
            registry: nameRegistry
        };
        const warpRemark = env
            ? await getConfiguredNameWithMetadata(env, `💦 ${index + 1} - Warp${proIndicator}🇮🇷`, warpContext)
            : getConfiguredName(`💦 ${index + 1} - Warp${proIndicator}🇮🇷`, warpContext);
        const wowRemark = env
            ? await getConfiguredNameWithMetadata(env, `💦 ${index + 1} - WoW${proIndicator}🌍`, wowContext)
            : getConfiguredName(`💦 ${index + 1} - WoW${proIndicator}🌍`, wowContext);

        const warpConfig = await buildConfig(
            warpRemark,
            [warpOutbound],
            false,
            false,
            false,
            true,
            false,
            [host]
        );

        const wowConfig = await buildConfig(
            wowRemark,
            [wowOutbound, warpOutbound],
            false,
            true,
            false,
            true,
            false,
            [host]
        );

        configs.push(warpConfig, wowConfig);

        const proxy = modifyOutbound(warpOutbound, `proxy-${index + 1}`);
        proxies.push(proxy);

        const chain = modifyOutbound(wowOutbound, `chain-${index + 1}`, `proxy-${index + 1}`);
        chains.push(chain);
    }

    const warpBestPingContext = {
        index: 1,
        address: outboundDomains[0],
        marker: 'Warp',
        proto: 'Warp',
        kind: 'Warp Best Ping',
        core: 'xray',
        identity: `warp-best:${isPro ? 'pro' : 'standard'}:${isKnocker ? 'knocker' : 'normal'}:${stableWarpIdentity}`,
        registry: nameRegistry
    };
    const wowBestPingContext = {
        index: 1,
        address: outboundDomains[0],
        marker: 'WoW',
        proto: 'Warp',
        chain: true,
        kind: 'WoW Best Ping',
        core: 'xray',
        identity: `wow-best:${isPro ? 'pro' : 'standard'}:${isKnocker ? 'knocker' : 'normal'}:${stableWarpIdentity}`,
        registry: nameRegistry
    };
    const warpBestPingRemark = env
        ? await getConfiguredNameWithMetadata(env, `💦 Warp${proIndicator}- Best Ping 🚀`, warpBestPingContext)
        : getConfiguredName(`💦 Warp${proIndicator}- Best Ping 🚀`, warpBestPingContext);
    const wowBestPingRemark = env
        ? await getConfiguredNameWithMetadata(env, `💦 WoW${proIndicator}- Best Ping 🚀`, wowBestPingContext)
        : getConfiguredName(`💦 WoW${proIndicator}- Best Ping 🚀`, wowBestPingContext);

    const warpBestPing = await buildConfig(
        warpBestPingRemark,
        [...proxies],
        true,
        false,
        false,
        true,
        false,
        outboundDomains
    );

    const wowBestPing = await buildConfig(
        wowBestPingRemark,
        [...chains, ...proxies],
        true,
        true,
        false,
        true,
        false,
        outboundDomains
    );

    configs.push(warpBestPing, wowBestPing);

    const fileName = isPro ? 'warp-Pro' : 'warp';
    return new Response(JSON.stringify(configs, null, 4), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename=${_project_SM_}-${fileName}-xray.json`,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    });
}

function modifyOutbound(outbound: Outbound, tag: string, dialerProxy?: string): Outbound {
    const newOutbound = structuredClone(outbound);
    newOutbound.tag = tag;

    if (dialerProxy && newOutbound.streamSettings?.sockopt) {
        newOutbound.streamSettings.sockopt.dialerProxy = dialerProxy;
    }

    return newOutbound;
}
