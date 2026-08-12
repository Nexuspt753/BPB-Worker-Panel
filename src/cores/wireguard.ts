import { HttpStatus, respond, safeError } from '@common';
import { getSettings, getWarpAccounts } from '@settings';
import { getConfiguredName, getConfiguredNameWithMetadata, isDomain, parseHostPort } from '@utils';
import { createNameRegistry, RESERVED_NAME_IDENTIFIERS, sanitizeConfigName, stableNameSuffix } from './naming';
import JSZip from 'jszip';

export async function getWireguardConfigs(isPro: boolean, env?: Env): Promise<Response> {
    try {
        const { warpIPv6, publicKey, privateKey } = getWarpAccounts()[0];
        const {
            warpEndpoints,
            warpRemoteDNS,
            amneziaNoiseCount,
            amneziaNoiseSizeMin,
            amneziaNoiseSizeMax
        } = getSettings();

        const zip = new JSZip();
        // Keep the naming registry separate from the sanitized filename set.
        // The naming engine registers its candidate before returning it; using
        // that same set for the ZIP check would append `-2` to every file.
        const nameRegistry = createNameRegistry(RESERVED_NAME_IDENTIFIERS);
        const fileNames = new Set<string>();

        for (const [index, endpoint] of (warpEndpoints ?? []).entries()) {
            const conf = [
                '[Interface]',
                `PrivateKey = ${privateKey}`,
                `Address = 172.16.0.2/32, ${warpIPv6}`,
                `DNS = ${warpRemoteDNS}`,
                'MTU = 1280',
                ...(isPro ? [
                    `Jc = ${amneziaNoiseCount}`,
                    `Jmin = ${amneziaNoiseSizeMin}`,
                    `Jmax = ${amneziaNoiseSizeMax}`,
                    'S1 = 0',
                    'S2 = 0',
                    'H1 = 1',
                    'H2 = 2',
                    'H3 = 3',
                    'H4 = 4'
                ] : []),
                '',
                '[Peer]',
                `PublicKey = ${publicKey}`,
                'AllowedIPs = 0.0.0.0/0, ::/0',
                `Endpoint = ${endpoint}`,
                'PersistentKeepalive = 25'
            ].join('\n');

            const { host, port } = parseHostPort(endpoint);
            const nameContext = {
                index: index + 1,
                address: host,
                port,
                marker: isPro ? 'Warp Pro' : 'Warp',
                proto: 'WireGuard',
                kind: isPro ? 'Warp Pro' : 'Warp',
                core: isPro ? 'amnezia' : 'wireguard',
                domain: host,
                security: 'None',
                transport: 'WireGuard',
                family: host.includes(':') ? 'IPv6' : isDomain(host) ? 'Domain' : 'IPv4',
                registry: nameRegistry
            };
            const configuredName = env
                ? await getConfiguredNameWithMetadata(env, `${_project_}-Warp-${index + 1}`, nameContext)
                : getConfiguredName(`${_project_}-Warp-${index + 1}`, nameContext);
            let fileName = sanitizeConfigName(configuredName, 'filename') || `${_project_}-Warp-${index + 1}`;
            const originalFileName = fileName;
            let collision = 1;
            while (fileNames.has(fileName)) {
                collision++;
                // Sanitization can collapse distinct names (`a/b` and `a_b`).
                // Use the config identity before falling back to a local retry
                // so ZIP filenames remain stable when endpoint order changes.
                const identitySuffix = stableNameSuffix(nameContext);
                fileName = sanitizeConfigName(`${originalFileName} ${identitySuffix}${collision > 2 ? `-${collision}` : ''}`, 'filename');
            }
            fileNames.add(fileName);
            zip.file(`${fileName}.conf`, conf);
        }

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const arrayBuffer = await zipBlob.arrayBuffer();

        const fileName = isPro ? 'pro-amnezia' : 'wireguard';
        return new Response(arrayBuffer, {
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename=${_project_SM_}-warp-${fileName}-conf.zip`,
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'Pragma': 'no-cache'
            },
        });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Error generating ZIP file: ${safeError(error)}`);
    }
}