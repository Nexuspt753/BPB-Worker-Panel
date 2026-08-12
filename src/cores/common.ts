import { base64DecodeUtf8, base64EncodeUtf8 } from '@common';
import { getSettings } from '@settings';
import { createNameRegistry, RESERVED_NAME_IDENTIFIERS } from './naming';
import {
    generateRemark,
    generateWsPath,
    getConfigAddresses,
    getConfiguredNameWithMetadata,
    getConfiguredNameSnapshot,
    getProtocols,
    concatIf,
    isBase64,
    isDomain,
    isHttps,
    isIPv4,
    selectSniHost
} from '@utils';

export async function getURLConfigs(env: Env) {
    const {
        fingerprint,
        ports,
        chainProxy,
        remoteDNS,
        customConfigs,
        customSubs,
        customDomain,
        vlUUID,
        trPass,
        httpsPorts,
        client,
        mainDomain,
        upstreamParams: { upstreamServer, upstreamPort }
    } = getSettings();

    const buildConfig = (protocol: string, addr: string, port: number, host: string, sni: string, remark: string) => {
        const isTLS = httpsPorts.includes(port) || addr === upstreamServer;
        const security = isTLS ? 'tls' : 'none';
        const config = new URL(`${protocol}://config`);

        if (protocol === _VL_) {
            config.username = vlUUID;
            config.searchParams.append('encryption', 'none');
        } else {
            config.username = trPass;
        }

        const path = generateWsPath(protocol);
        config.hostname = addr;
        config.port = port.toString();
        config.searchParams.append('host', host);
        config.searchParams.append('type', 'ws');
        config.searchParams.append('security', security);
        config.hash = remark;

        if (client === 'sing-box') {
            config.searchParams.append('eh', 'Sec-WebSocket-Protocol');
            config.searchParams.append('ed', '2560');
            config.searchParams.append('path', path);
        } else {
            config.searchParams.append('path', `${path}?ed=2560`);
        }

        if (isTLS) {
            config.searchParams.append('sni', sni);
            config.searchParams.append('fp', fingerprint);
            config.searchParams.append('alpn', 'http/1.1');
        }

        return config.href;
    }

    let VLConfs = '', TRConfs = '', chainConfig = '';
    let proxyIndex = 1;
    const nameRegistry = createNameRegistry(RESERVED_NAME_IDENTIFIERS);
    const domains = concatIf([mainDomain], !!customDomain, customDomain);
    const protocols = getProtocols();

    for (const domain of domains) {
        const totalPorts = ports.filter(port => domain.endsWith('workers.dev') || isHttps(port));
        const addrs = await getConfigAddresses(domain, false);
        if (upstreamServer && upstreamPort) {
            totalPorts.unshift(upstreamPort);
            addrs.unshift(upstreamServer);
        }

        for (const port of totalPorts) {
            for (const addr of addrs) {
                const { sni, host } = selectSniHost(addr, domain);
                if ((port === upstreamPort) !== (addr === upstreamServer)) continue;

                if (protocols.includes(_VL_)) {
                    const remark = await generateRemark(env, proxyIndex, port, addr, _VL_, domain, false, false, client || 'xray', nameRegistry);
                    const vlConfig = buildConfig(_VL_, addr, port, host, sni, remark);
                    VLConfs += `${vlConfig}\n`;
                }

                if (protocols.includes(_TR_)) {
                    const remark = await generateRemark(env, proxyIndex, port, addr, _TR_, domain, false, false, client || 'xray', nameRegistry);
                    const trConfig = buildConfig(_TR_, addr, port, host, sni, remark);
                    TRConfs += `${trConfig}\n`;
                }

                proxyIndex++;
            }
        }
    }

    if (chainProxy) {
        const chainName = await getConfiguredNameSnapshot(env, '💦 Chain proxy 🔗', {
            index: 1,
            marker: 'C',
            proto: 'Chain',
            chain: true,
            core: client || 'raw',
            kind: 'Chain',
            registry: nameRegistry
        });
        const chainRemark = `#${encodeURIComponent(chainName)}`;
        // A URI may already contain a user-facing fragment. Remove it before
        // appending the generated remark so every chain has exactly one `#`.
        const hashIndex = chainProxy.indexOf('#');
        const chainWithoutHash = hashIndex === -1 ? chainProxy : chainProxy.slice(0, hashIndex);
        if (/^(?:socks5?|http):\/\//u.test(chainWithoutHash)) {
            const userPassMatch = chainWithoutHash.match(/^(?:socks5?|http):\/\/([^@]+)@/u);
            const userPass = userPassMatch?.[1];
            const encodedChain = userPass
                ? chainWithoutHash.replace(userPass, btoa(userPass))
                : chainWithoutHash;
            chainConfig = encodedChain + chainRemark;
        } else {
            chainConfig = chainWithoutHash + chainRemark;
        }
    }

    const customText = customConfigs.join('\n') + await fetchCustomSubs(customSubs);
    const customConfs = await renameImportedConfigs(customText, env, nameRegistry);
    const configs = base64EncodeUtf8(VLConfs + TRConfs + chainConfig + customConfs);

    return new Response(configs, {
        status: 200,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Profile-Title': `base64:${base64EncodeUtf8(`💦 ${_project_} Raw`)}`,
            'DNS': remoteDNS
        }
    });
}

async function renameImportedConfigs(text: string, env: Env, nameRegistry: ReturnType<typeof createNameRegistry>): Promise<string> {
    const { nameTemplate } = getSettings();
    if (!nameTemplate?.trim()) return text;

    const supportedProtocols = new Set(['vless:', 'trojan:', 'vmess:', 'ss:', 'socks:', 'socks5:', 'http:']);
    const lines = text.split(/\r?\n/);
    let index = 1;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const value = line.trim();
        if (!value) continue;

        try {
            // Do not serialize the URI back through URL.href. VMess and
            // Shadowsocks commonly store case-sensitive base64 in the authority;
            // URL normalization lowercases that data and silently corrupts it.
            // Keep the original URI bytes and replace only its display fragment.
            const hashIndex = value.indexOf('#');
            const uriWithoutHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
            const rawFragment = hashIndex === -1 ? '' : value.slice(hashIndex + 1);
            const url = new URL(uriWithoutHash);
            if (!supportedProtocols.has(url.protocol)) continue;

            const host = url.hostname;
            const protocol = url.protocol.slice(0, -1).toUpperCase();
            const transport = url.searchParams.get('type')?.toUpperCase() || undefined;
            const security = url.searchParams.get('security')?.toUpperCase() || 'NONE';
            const family = host.includes(':') ? 'IPv6' : isIPv4(host) ? 'IPv4' : isDomain(host) ? 'Domain' : '';
            let importedName = '';
            try {
                importedName = decodeURIComponent(rawFragment);
            } catch {
                importedName = rawFragment;
            }

            const generated = await getConfiguredNameWithMetadata(env, importedName || `Imported ${index}`, {
                index,
                address: host,
                port: Number(url.port) || undefined,
                customName: importedName || undefined,
                marker: 'I',
                proto: protocol,
                kind: 'Imported',
                core: 'raw',
                transport,
                security,
                family,
                domain: host,
                // Imported URIs can share an endpoint while using different
                // credentials. Keep the original URI (without its display
                // hash) in the stable identity so reordering them does not
                // rename either and case-sensitive payloads stay intact.
                identity: uriWithoutHash,
                registry: nameRegistry
            });
            index++;
            lines[lineIndex] = `${uriWithoutHash}#${encodeURIComponent(generated)}`;
        } catch {
            // Keep unsupported or malformed imported lines byte-for-byte intact.
        }
    }

    return lines.join('\n');
}

async function fetchCustomSubs(subs: string[]): Promise<string> {
    const results = await Promise.all(
        subs.map(async (url) => {
            try {
                const res = await fetch(url);
                if (!res.ok) return '';

                const text = (await res.text()).trim();
                if (!text) return '';

                if (isBase64(text)) {
                    try {
                        return base64DecodeUtf8(text);
                    } catch {
                        return text;
                    }
                }

                return text;
            } catch {
                return '';
            }
        })
    );

    return results
        .filter(Boolean)
        .join('\n');
}
