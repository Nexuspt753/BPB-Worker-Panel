import { PanelSettings } from '#types/settings';
import { isBase64, isDomain, isHex, isIPv4, isIPv4CIDR, isIPv6, isIPv6CIDR, isValidUrl } from '@utils';
import { isValidUUID } from '@common';
import { getGlobals } from '@settings';
import { getNameTemplateDiagnostics, isValidNameTemplate, MIN_NAME_MAX_LENGTH, NAME_TEMPLATE_TOKENS, parseAddressGroups, splitIpAndName, templateTokens } from '@cores/naming';

export interface ValidationError {
    field: string;
    message: string[];
}

const validators = [
    validatePorts,
    validateRemoteDNS,
    validateSanctionDns,
    validateLocalDNS,
    validateWarpDNS,
    validateCleanIPs,
    validateProxyIPs,
    validateNAT64Prefixes,
    validateWarpEndpoints,
    validateMinMax,
    validateUpstreamProxy,
    validateChainProxy,
    validateCustomCdn,
    validateKnockerNoise,
    validateXrayNoises,
    validateCustomRules,
    validateEchConfig,
    validateUUID,
    validateTrPass,
    validateFallback,
    validateDoH,
    validatePath,
    validateCustomDomain,
    validateExtSubs,
    validateRemoteSettings,
    validateNameTemplate,
    validateNameOptions,
    validateNameAddressGroups,
    validateLatencyInterval
];

export function validateSettings(form: PanelSettings | null): ValidationError[] | null {
    if (!form) return null;
    const errors: ValidationError[] = [];
    validators.forEach(validate => validate(form, errors));
    return errors.length ? errors : null;
}

function isValidHost(value: string, requirePort = false): boolean {
    const match = value.match(/^(?<host>\[.*?\]|[^:]+)(?::(?<port>\d+))?$/);
    if (!match?.groups?.host) return false;

    const { host, port: portStr } = match.groups;
    if (!!portStr !== !!requirePort) return false;
    if (portStr) {
        const port = Number(portStr);
        if (port < 1 || port > 65535) return false;
    }

    return isIPv6(host) || isIPv4(host) || isDomain(host);
}

function validateRemoteDNS(form: PanelSettings, errors: ValidationError[]) {
    let url;

    try {
        url = new URL(form.remoteDNS);
    } catch {
        errors.push({
            field: 'Remote DNS',
            message: ['Invalid DoH, Please enter a valid URL.']
        });

        return;
    }

    const cloudflareDNS = [
        '1.1.1.1', '1.0.0.1',
        '1.1.1.2', '1.0.0.2',
        '1.1.1.3', '1.0.0.3',
        '2606:4700:4700::1111',
        '2606:4700:4700::1001',
        '2606:4700:4700::1112',
        '2606:4700:4700::1002',
        '2606:4700:4700::1113',
        '2606:4700:4700::1003',
        'one.one.one.one',
        '1dot1dot1dot1',
        'cloudflare-dns.com',
        'family.cloudflare-dns.com',
        'security.cloudflare-dns.com'
    ];

    if (!['tcp:', 'https:', 'tls:'].includes(url.protocol)) {
        errors.push({
            field: 'Remote DNS',
            message: ['It can be only TCP, DoH or DoT servers.']
        });
    }

    if (cloudflareDNS.includes(url.hostname)) {
        errors.push({
            field: 'Remote DNS',
            message: [
                'Cloudflare DNS is not allowed for workers.',
                'Please use other public DNS servers like Google, Adguard...'
            ]
        });
    }
}

function validateSanctionDns(form: PanelSettings, errors: ValidationError[]) {
    const dns = form.antiSanctionDNS;
    let host;

    try {
        const url = new URL(dns);
        host = url.hostname;
    } catch {
        host = dns;
    }

    if (!isValidHost(host, false)) {
        errors.push({
            field: 'Anti Sanction DNS',
            message: ['Invalid IPs or Domains.']
        });
    }
}

function validateWarpDNS(form: PanelSettings, errors: ValidationError[]) {
    const dns = form.warpRemoteDNS;
    if (!isIPv4(dns)) {
        errors.push({
            field: 'Warp Remote DNS',
            message: ['Only IPv4 address (UDP DNS) is valid for this field.']
        });
    }
}

function validateLocalDNS(form: PanelSettings, errors: ValidationError[]) {
    const dns = form.localDNS;
    if (!isIPv4(dns) && dns !== 'localhost') {
        errors.push({
            field: 'Local DNS',
            message: ['Only IPv4 addresses or "localhost" are valid.']
        });
    }
}

function validateCustomRules(form: PanelSettings, errors: ValidationError[]) {
    const fields = [
        'customBypassRules',
        'customBlockRules'
    ] as const;

    fields.forEach(field => {
        const invalids = form[field].filter(value => !isIPv4CIDR(value) && !isIPv6CIDR(value) && !isDomain(value));
        if (invalids.length) {
            errors.push({
                field: 'Routing Custom Rules',
                message: [
                    'Invalid IPs, Domains or IP CIDR.',
                    'Please enter each value in a new line.',
                    'Invalid values are:\n',
                    ...invalids.map(val => `+ ${val}`)
                ]
            });

        }
    });

    const invalids = form.customBypassSanctionRules.filter(value => !isDomain(value));
    if (invalids.length) {
        errors.push({
            field: 'Routing Sanction Rules',
            message: [
                'Invalid Domains.',
                'Please enter each value in a new line.',
                'Invalid values are:\n',
                ...invalids.map(val => `+ ${val}`)
            ]
        });
    }
}

function validateCleanIPs(form: PanelSettings, errors: ValidationError[]) {
    const invalids = form.cleanIPs
        .map(splitIpAndName)
        .filter(x => !isValidHost(x.host))
        // A line that is only a `# Name` has no host at all — show the raw line
        // instead of an empty bullet.
        .map(x => x.host || '(empty host)');

    if (invalids.length) {
        errors.push({
            field: 'Clean IPs - Domains',
            message: [
                'Invalid IPs or Domains.',
                'Please enter each value in a new line.',
                'Invalid values are:\n',
                ...invalids.map(ip => `+ ${ip}`)
            ]
        });
    }
}

const NAME_TEMPLATE_MAX = 200;
const KNOWN_TOKENS = new Set<string>(NAME_TEMPLATE_TOKENS);

function validateNameTemplate(form: PanelSettings, errors: ValidationError[]) {
    const template = form.nameTemplate;
    if (typeof template !== 'string' || !template.trim()) return;

    if (template.length > NAME_TEMPLATE_MAX) {
        errors.push({
            field: 'Config Name Template',
            message: [`It cannot be longer than ${NAME_TEMPLATE_MAX} characters.`]
        });
    }

    // Config names end up as clash proxy names, sing-box tags and URL fragments.
    // Newlines would break the URI list and YAML, so reject control characters.
    if ([...template].some(ch => { const c = ch.codePointAt(0) ?? 0; return c < 0x20 || c === 0x7f; })) {
        errors.push({
            field: 'Config Name Template',
            message: ['It cannot contain line breaks or control characters.']
        });
    }

    const diagnostics = getNameTemplateDiagnostics(template);
    if (diagnostics.length || !isValidNameTemplate(template)) {
        errors.push({
            field: 'Config Name Template',
            message: diagnostics.length
                ? diagnostics.map(diagnostic => `${diagnostic.message} (characters ${diagnostic.start + 1}-${Math.max(diagnostic.start + 1, diagnostic.end)})`)
                : ['Use complete tokens like {IP}; nested, empty, or unmatched braces are not allowed.']
        });
        return;
    }

    const unknown = [...templateTokens(template)].filter(token => !KNOWN_TOKENS.has(token));
    if (unknown.length) {
        errors.push({
            field: 'Config Name Template',
            message: [
                'Unknown tokens (they would render as "--").',
                'Invalid values are:\n',
                ...unknown.map(token => `+ {${token}}`)
            ]
        });
    }
}

function validateNameOptions(form: PanelSettings, errors: ValidationError[]) {
    const nameFormat = form.nameFormat ?? 'readable';
    const nameMaxLength = form.nameMaxLength ?? 0;
    const nameGeoMode = form.nameGeoMode ?? 'auto';

    if (!['readable', 'compact', 'ascii'].includes(nameFormat)) {
        errors.push({
            field: 'Config Name Format',
            message: ['Choose readable, compact, or ASCII-safe formatting.']
        });
    }

    const maxLength = Number(nameMaxLength);
    if (!Number.isInteger(maxLength)
        || (maxLength !== 0 && (maxLength < MIN_NAME_MAX_LENGTH || maxLength > 200))) {
        errors.push({
            field: 'Config Name Length',
            message: [`Use 0 for unlimited or a whole number between ${MIN_NAME_MAX_LENGTH} and 200.`]
        });
    }

    if (!['auto', 'local', 'disabled'].includes(nameGeoMode)) {
        errors.push({
            field: 'Config Name Geo Lookups',
            message: ['Choose automatic, cached-only, or disabled geo lookups.']
        });
    }
}

function validateNameAddressGroups(form: PanelSettings, errors: ValidationError[]) {
    const entries = Array.isArray(form.nameAddressGroups) ? form.nameAddressGroups : [];
    const groups = parseAddressGroups(entries);
    const invalids: string[] = [];

    entries.forEach(entry => {
        String(entry ?? '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean).forEach(line => {
            if (/^.+?:\s*$/u.test(line)) return;
            const isEndpointLine = /^\[[^\]]+\]:\d+$/u.test(line) || /^[^:]+:\d+$/u.test(line);
            const separator = isEndpointLine ? null : line.match(/^([^:=|]+?)\s*[:=|]\s*(.+)$/u);
            const addresses = separator ? separator[2] : line;
            addresses.split(/\s*,\s*/u).map(value => value.trim()).filter(Boolean).forEach(address => {
                if (!isValidHost(address) && !isValidHost(address, true)) invalids.push(address);
            });
        });
    });

    if (invalids.length || (entries.length > 0 && groups.size === 0)) {
        errors.push({
            field: 'Config Name Address Groups',
            message: [
                'Use a group header such as "Fast:", followed by IPs/domains, or "Fast: 1.1.1.1, 1.0.0.1".',
                'Invalid values are:\n',
                ...invalids.map(value => `+ ${value}`)
            ]
        });
    }
}

function validateLatencyInterval(form: PanelSettings, errors: ValidationError[]) {
    if (form.latencyAutoTest !== true) return;
    const interval = Number(form.latencyIntervalMin);

    if (!Number.isInteger(interval) || interval < 10 || interval > 1440) {
        errors.push({
            field: 'Latency Auto Test Interval',
            message: ['It should be a whole number of minutes between 10 and 1440.']
        });
    }
}

function validateProxyIPs(form: PanelSettings, errors: ValidationError[]) {
    const invalids = form.proxyIPs.filter(value => !isValidHost(value, false) && !isValidHost(value, true));
    if (invalids.length) {
        errors.push({
            field: 'Proxy IPs - Domains',
            message: [
                'Invalid IPs or Domains.',
                'Please enter each value in a new line.',
                'Invalid values are:\n',
                ...invalids.map(val => `+ ${val}`)
            ]
        });
    }
}

function validateNAT64Prefixes(form: PanelSettings, errors: ValidationError[]) {
    const invalids = form.prefixes.filter((value: string) => !isIPv6(value));
    if (invalids.length) {
        errors.push({
            field: 'NAT64 Prefixes',
            message: [
                'Invalid NAT64 prefix.',
                'Please enter each prefix in a new line like [IPv6].',
                'Invalid values are:\n',
                ...invalids.map(ip => `+ ${ip}`)
            ]
        });
    }
}

function validateWarpEndpoints(form: PanelSettings, errors: ValidationError[]) {
    const invalidEndpoints = form.warpEndpoints.filter((value: string) => !isValidHost(value, true));
    if (invalidEndpoints.length) {
        errors.push({
            field: 'Warp Endpoints',
            message: [
                'Endpoints should be like IPv4:Port, Domain:Port or [IPv6]:Port.',
                'Invalid values are:\n',
                ...invalidEndpoints.map(endpoint => `+ ${endpoint}`)
            ]
        });
    }
}

function validateMinMax(form: PanelSettings, errors: ValidationError[]) {
    const fields = [
        ['fragmentLengthMin', 'fragmentLengthMax', 'Fragment Length'],
        ['fragmentDelayMin', 'fragmentDelayMax', 'Fragment Delay'],
        ['fragmentMaxSplitMin', 'fragmentMaxSplitMax', 'Fragment Max Split'],
        ['knockerNoiseCountMin', 'knockerNoiseCountMax', 'MahsaNG Noise Count'],
        ['knockerNoiseSizeMin', 'knockerNoiseSizeMax', 'MahsaNG Noise Size'],
        ['knockerNoiseDelayMin', 'knockerNoiseDelayMax', 'MahsaNGNoise Delay'],
        ['amneziaNoiseSizeMin', 'amneziaNoiseSizeMax', 'Amnezia Noise Size']
    ] as const;

    for (const [minId, maxId, field] of fields) {
        const min = Number(form[minId]);
        const max = Number(form[maxId]);

        if (min > max) {
            errors.push({
                field,
                message: ['Minimum cannot be bigger than Maximum!']
            });
        }
    }
}

function validateChainProxy(form: PanelSettings, errors: ValidationError[]) {
    let chainProxy = form.chainProxy;
    if (!chainProxy) return true;
    const vmRegex = new RegExp(`${_VM_}:\\/\\/.+$`);
    const othersRegex = new RegExp(`(http|socks|socks5|${_VL_}|${_TR_}|ss):\\/\\/[^\\s@]+@[^\\s:]+:[^\\s]+`);
    const isVMess = vmRegex.test(chainProxy);
    const isOthers = othersRegex.test(chainProxy);

    if (!isVMess && !isOthers) {
        errors.push({
            field: 'Chain Proxy',
            message: [
                'Invalid Config!',
                'Standard formats are:',
                ' + (socks or socks5 or http)://user:pass@server:port',
                ' + (socks or socks5 or http)://base64@server:port',
                ` + ${_VL_}://uuid@server:port...`,
                ` + ${_VM_}://base64`,
                ` + ${_TR_}://password@server:port...`,
                ' + ss://base64@server:port...'
            ]
        });
    }

    const config = new URL(chainProxy);
    let { protocol, username } = config;
    let security = config.searchParams.get('security');
    let type = config.searchParams.get('type');

    if (isVMess) {
        const vmConfig = JSON.parse(atob(config.host));
        username = vmConfig.id;
        security = vmConfig.tls;
        type = vmConfig.net;
    }

    if ([`${_VL_}:`, `${_TR_}:`, `${_VM_}:`].includes(protocol)) {
        if (!username) {
            errors.push({
                field: 'Chain Proxy',
                message: [
                    'Invalid Config!',
                    'Config URL should contain UUID or Password.'
                ]
            });
        }

        if (security && !['tls', 'none', 'reality'].includes(security)) {
            errors.push({
                field: 'Chain Proxy',
                message: [
                    'Invalid Config!',
                    `${_VL_CAP_}, ${_VM_CAP_} or ${_TR_CAP_} security can be TLS, Reality or None.`
                ]
            });
        }

        if (!type || !['tcp', 'raw', 'ws', 'grpc', 'httpupgrade', 'xhttp'].includes(type)) {
            errors.push({
                field: 'Chain Proxy',
                message: [
                    'Invalid Config!',
                    `${_VL_CAP_}, ${_VM_CAP_} or ${_TR_CAP_} transmission can be tcp, ws, grpc or httpupgrade.`
                ]
            });
        }
    }
}

function validateCustomCdn(form: PanelSettings, errors: ValidationError[]) {
    const { customCdnAddrs, customCdnHost, customCdnSni } = form;
    const isCustomCdn = !!customCdnAddrs.length || !!customCdnHost || !!customCdnSni;
    let valid = !isCustomCdn || (!!customCdnAddrs.length && !!customCdnHost && !!customCdnSni);

    if (!valid) {
        errors.push({
            field: 'Custom CDN',
            message: ['All fields should be filled or empty together!']
        });
    }

    if (isCustomCdn && valid) {
        const fields = [
            ['customCdnSni', 'Custom CDN SNI'],
            ['customCdnHost', 'Custom CDN Host']
        ] as const;

        fields.forEach(([field, tag]) => {
            if (!isDomain(form[field])) {
                errors.push({
                    field: tag,
                    message: [`Invalid Domain: ${form[field]}`]
                });
            }
        });

        const invalids = form.customCdnAddrs.filter(addr => !isValidHost(addr));
        if (invalids.length) {
            errors.push({
                field: 'Custom CDN Addresses',
                message: [
                    'Invalid IPs or Domains.',
                    'Please enter each value in a new line.',
                    'Invalid values are:\n',
                    ...invalids.map(val => `+ ${val}`)
                ]
            });
        }
    }
}

function validateKnockerNoise(form: PanelSettings, errors: ValidationError[]) {
    const regex = /^(none|quic|random|[0-9A-Fa-f]+)$/;
    if (!regex.test(form.knockerNoiseMode)) {
        errors.push({
            field: 'MahsaNG Noise',
            message: [
                'Invalid noise mode.',
                'Please use "none", "quic", "random" or a valid hex value.'
            ]
        });
    }
}

function validateXrayNoises(form: PanelSettings, errors: ValidationError[]) {
    form.xrayUdpNoises.forEach(({ type, packet, delay }) => {
        const [delayMin, delayMax] = delay.split('-').map(Number);
        if (delayMin > delayMax) {
            errors.push({
                field: 'Xray Noise Delay',
                message: ['Minimum cannot be bigger than Maximum!']
            });
        }

        switch (type) {
            case 'base64': {
                if (!isBase64(packet)) {
                    errors.push({
                        field: 'Xray Noise Packet',
                        message: ['The packet is not a valid base64 value!']
                    });
                }

                break;
            }
            case 'rand': {
                if (!/^\d+-\d+$/.test(packet)) {
                    errors.push({
                        field: 'Xray Noise Packet',
                        message: ['The packet should be a range like 0-10 or 10-30!']
                    });
                }

                const [min, max] = packet.split('-').map(Number);
                if (min > max) {
                    errors.push({
                        field: 'Xray Noise Packet',
                        message: ['Minimum cannot be bigger than Maximum!']
                    });
                }

                break;
            }
            case 'hex': {
                if (!isHex(packet)) {
                    errors.push({
                        field: 'Xray Noise Packet',
                        message: [
                            'The packet is not a valid hex value!',
                            'It should have even length and consisted of 0-9, a-f and A-F.'
                        ]
                    });
                }

                break;
            }
            case 'array': {
                const valid = packet
                    .split(',')
                    .every((n: string) => /^\d+$/.test(n) && Number(n) >= 0 && Number(n) <= 255);

                if (!valid) {
                    errors.push({
                        field: 'Xray Noise Packet',
                        message: ['It should be comma separated numbers between 0-255 like 1,10,128...']
                    });
                }

                break;
            }
        }
    });
}

function validateEchConfig(form: PanelSettings, errors: ValidationError[]) {
    const echServerName = form.echServerName;
    if (echServerName && !isDomain(echServerName)) {
        errors.push({
            field: 'ECH Server Name',
            message: ['The ECH Server Name should be a domain!']
        });
    }
}

function validateUpstreamProxy(form: PanelSettings, errors: ValidationError[]) {
    const upstreamProxy = form.upstreamProxy;
    if (upstreamProxy && !isValidHost(upstreamProxy, true)) {
        errors.push({
            field: 'Upstream Proxy',
            message: ['It can be either IP:Port or Domain:Port']
        });
    }
}

function validateUUID(form: PanelSettings, errors: ValidationError[]) {
    const uuid = form.vlUUID;
    if (!isValidUUID(uuid)) {
        errors.push({
            field: `${_VL_CAP_} UUID`,
            message: ['Invalid UUID!']
        });
    }
}

function validateTrPass(form: PanelSettings, errors: ValidationError[]) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@$&*_-+;:,.';
    const pass = form.trPass;
    if (![...pass].every(ch => charset.includes(ch))) {
        errors.push({
            field: `${_TR_CAP_} Password`,
            message: ['Invalid characters!']
        });
    }
}

function validateFallback(form: PanelSettings, errors: ValidationError[]) {
    const fallback = form.fallback;
    if (fallback && !isDomain(fallback)) {
        errors.push({
            field: 'Fallback Domain',
            message: ['It should be a domain!']
        });
    }
}

function validateDoH(form: PanelSettings, errors: ValidationError[]) {
    const doh = form.dohUrl;
    let valid = true;
    try {
        const { protocol, pathname } = new URL(doh);
        valid = protocol === 'https:' && pathname.endsWith('/dns-query');
    } catch {
        valid = false;
    }

    if (doh && !valid) {
        errors.push({
            field: 'Underlying DoH URL',
            message: ['It should be like https://Domain-or-IP/dns-query']
        });
    }
}

function validatePath(form: PanelSettings, errors: ValidationError[]) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@$&*_-+;:,.';
    const path = form.securePath;
    if (![...path].every(ch => charset.includes(ch))) {
        errors.push({
            field: 'Panel - Subscriptions Path',
            message: ['Invalid characters!']
        });
    }
}

function validateCustomDomain(form: PanelSettings, errors: ValidationError[]) {
    const customDomain = form.customDomain;
    if (customDomain && !isDomain(customDomain)) {
        errors.push({
            field: 'Custom Domain',
            message: ['It should be a domain!']
        });
    }
}

function validateExtSubs(form: PanelSettings, errors: ValidationError[]) {
    const invalids = form.customSubs.filter(url => !isValidUrl(url));
    if (invalids.length) {
        errors.push({
            field: 'External Raw subscriptions',
            message: [
                'Invalid URLs.',
                'Please enter each value in a new line.',
                'Invalid values are:\n',
                ...invalids.map(val => `+ ${val}`)
            ]
        });
    }
}

function validateRemoteSettings(form: PanelSettings, errors: ValidationError[]) {
    if (!form.remoteSettings) return;
    let url;

    try {
        url = new URL(form.remoteSettings);
    } catch {
        errors.push({
            field: 'Remote Settings URL',
            message: ['Please enter a valid URL.']
        });

        return;
    }

    const path = url.pathname.split('/').slice(2).join('/');

    if (path !== 'sub/share-settings') {
        errors.push({
            field: 'Remote Settings URL',
            message: ['This is not a valid BPB remote settings URL']
        });
    }
}

function validatePorts(form: PanelSettings, errors: ValidationError[]) {
    const { httpsPorts } = getGlobals();
    const tlsPorts = form.ports.filter(port => httpsPorts.includes(port));
    
    if (!tlsPorts.length) {
        errors.push({
            field: 'Ports',
            message: ['At least one TLS port should be selected.']
        });
    }
}
