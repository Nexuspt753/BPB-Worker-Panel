import { getDataset } from '@kv';
import {
    KvSettings,
    ReqSettings,
    EmbededSettings,
    MainSettings,
    WarpAccount,
    SharedSettings,
    Client,
    Subscription
} from '#types/settings';

Object.assign(globalThis, {
    _VL_: atob('dmxlc3M='),
    _VL_CAP_: atob('VkxFU1M='),
    _VM_: atob('dm1lc3M='),
    _VM_CAP_: atob('Vk1lc3M='),
    _TR_: atob('dHJvamFu'),
    _TR_CAP_: atob('VHJvamFu'),
    _SS_: atob('c2hhZG93c29ja3M='),
    _V2_: atob('djJyYXk='),
    _project_: atob('QlBC'),
    _project_SM_: atob('YnBi'),
    _repo_: atob('aHR0cHM6Ly9naXRodWIuY29tL2JpYS1wYWluLWJhY2hlL0JQQi1Xb3JrZXItUGFuZWw='),
    _wizard_repo_: atob('aHR0cHM6Ly9naXRodWIuY29tL2JpYS1wYWluLWJhY2hlL0JQQi1XaXphcmQ='),
    _website_: atob('aHR0cHM6Ly9iaWEtcGFpbi1iYWNoZS5naXRodWIuaW8vQlBCLVdvcmtlci1QYW5lbC8='),
    _public_proxy_ip_: atob('YnBiLnlvdXNlZi5pc2VnYXJvLmNvbQ=='),
});

export function init(request: Request, env: Env) {
    if(env.UUID || env.TR_PASS || typeof EMBEDED_SETTINGS === 'undefined') {
        throw new Error(`BPB Panel v5 can only be installed using <a href="${_wizard_repo_}/secrets" target="_blank">BPB Wizard v3</a> or later.`);
    }
    
    const { pathname, origin, searchParams, hostname } = new URL(request.url);
    globalSettings = {
        accID: EMBEDED_SETTINGS.accID,
        accEmail: EMBEDED_SETTINGS.accEmail.toLowerCase(),
        apiToken: EMBEDED_SETTINGS.apiToken,
        vlUUID: EMBEDED_SETTINGS.vlUUID,
        trPass: EMBEDED_SETTINGS.trPass,
        securePath: EMBEDED_SETTINGS.securePath,
        proxyIpMode: EMBEDED_SETTINGS.proxyIpMode,
        proxyIPs: EMBEDED_SETTINGS.proxyIPs.length ? EMBEDED_SETTINGS.proxyIPs : [_public_proxy_ip_],
        prefixes: EMBEDED_SETTINGS.prefixes.length ? EMBEDED_SETTINGS.prefixes : [
            '[2a02:898:146:64::]',
            '[2602:fc59:b0:64::]',
            '[2602:fc59:11:64::]'
        ],
        mainDomain: EMBEDED_SETTINGS.mainDomain,
        fallback: EMBEDED_SETTINGS.fallback,
        dohUrl: EMBEDED_SETTINGS.dohUrl || 'https://cloudflare-dns.com/dns-query',
        deployType: env.CF_PAGES === '1' ? 'pages' : 'workers',
        httpPorts: [80, 8080, 2052, 2082, 2086, 2095, 8880],
        httpsPorts: [443, 8443, 2053, 2083, 2087, 2096],
        client: decodeURIComponent(searchParams.get('app') ?? ''),
        origin: origin,
        searchParams,
        pathname: decodeURIComponent(pathname),
        hostname: hostname
    };
}

export async function setSettings(env: Env) {
    const dataset = await getDataset(env);
    kvSettings = dataset.settings;
    warpAccounts = dataset.warpAccounts;
}

export const getGlobals = (): EmbededSettings & ReqSettings => globalSettings;
export const getWarpAccounts = (): WarpAccount[] => warpAccounts;
export const getKvSettings = (): KvSettings => kvSettings;
export function getMainSettings(): MainSettings {
    const { accID, accEmail, apiToken, mainDomain, ...mainSettings } = EMBEDED_SETTINGS;
    return mainSettings;
}

export function getSharedSettings(): SharedSettings {
    const {
        remoteSettings,
        customDomain,
        panelVersion,
        ...proxySettings
    } = kvSettings;

    const {
        proxyIpMode,
        proxyIPs,
        prefixes,
        fallback,
        dohUrl
    } = EMBEDED_SETTINGS;

    return {
        ...proxySettings,
        proxyIpMode,
        proxyIPs,
        prefixes,
        fallback,
        dohUrl
    };
}

export const getSettings = () => ({
    ...kvSettings,
    ...globalSettings
});

let globalSettings: EmbededSettings & ReqSettings;
let warpAccounts: WarpAccount[] = [
    {
        privateKey: '4NyxMUme2zGv5r3QWI0hJBlNglm1J/thoCE55PK29G8=',
        publicKey: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
        warpIPv6: '2606:4700:110:8fd2:11f3:8e67:11d4:3704/128',
        reserved: 'N16D'
    },
    {
        privateKey: 'aPQwXZBOndL0km0Swo0ArDOoy3bjeZzTu+/d4YHxW04=',
        publicKey: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
        warpIPv6: '2606:4700:110:859d:1029:4dfa:bf63:ff08/128',
        reserved: 'SmWi'
    }
];

export const subscriptions: Subscription = {
    'normal': {
        label: 'Normal',
        categories: [
            { core: 'xray', clients: [`${_V2_}N(G)`, 'MahsaNG', 'Streisand'] },
            { core: 'sing-box', clients: ['sing-box', 'husi'] },
            { core: 'clash', clients: ['Clash Meta', 'Clash Verge', 'FlClash', 'Stash'] },
        ]
    },
    'fragment': {
        label: 'Fragment',
        categories: [
            { core: 'xray', clients: [`${_V2_}N(G)`, 'MahsaNG', 'Streisand'] },
            { core: 'sing-box', clients: ['sing-box', 'husi'] },
        ]
    },
    'raw': {
        label: 'Raw',
        categories: [
            { core: 'xray', clients: [`${_V2_}N(G)`, 'MahsaNG', 'Shadowrocket', 'Streisand', 'PassWall'] },
            { core: 'sing-box', clients: ['husi', 'NekoBox', 'Hiddify', 'Karing'] },
        ]
    },
    'warp': {
        label: 'Warp',
        categories: [
            { core: 'xray', clients: [`${_V2_}N(G)`, 'Streisand'] },
            { core: 'sing-box', clients: ['sing-box', 'husi'] },
            { core: 'clash', clients: ['Clash Meta', 'Clash Verge', 'FlClash', 'Stash'] },
            { core: 'wireguard', clients: ['Wireguard'] },
        ]
    },
    'warp-pro': {
        label: 'Warp Pro',
        categories: [
            { core: 'xray', clients: [`${_V2_}N(G)`, 'Streisand'] },
            { core: 'xray-knocker', clients: ['MahsaNG', 'v2rayN-PRO'] },
            { core: 'clash', clients: ['Clash Meta', 'Clash Verge', 'FlClash', 'Stash'] },
            { core: 'amnezia', clients: ['Amnezia', 'WG Tunnel'] },
        ]
    }
};

/**
 * One-click import strategy per client app, per device OS.
 *
 * Central source of truth shared by the panel and (in future) the Telegram bot.
 * Two independent facts are recorded per client:
 *
 * 1. `platforms` — the OSes the app actually ships on. If the visitor's device
 *    is not in this list the app cannot be installed here at all, so the panel
 *    only copies the link (and says why) instead of firing a dead scheme.
 * 2. How to import on the OSes it does run on:
 *    - `schemes[os]` — a URL scheme that OS build registers with the system.
 *      `{url}` is replaced with the plain subscription URL, `{enc}` with the
 *      percent-encoded form, and `{b64}` with its base64. Firing it hands the
 *      subscription to the app in one tap.
 *    - `scheme` — shorthand for "same scheme on every listed platform".
 *    - `fileImport` — the app has no scheme; instead download the config file
 *      and let the user open it with the app (one tap on every platform).
 *
 * A client with a platform but no scheme and no fileImport falls back to copy,
 * which is correct for apps that only accept a pasted URL (v2rayN, Streisand).
 *
 * `uriList` marks importers that sniff the subscription body and accept a
 * plain base64 URI list — the format the `raw` rows serve. Schemes that
 * demand a structured profile (Clash YAML, sing-box JSON) must not be fired
 * for `raw`, because the app would fetch it and fail to parse.
 *
 * Every entry below was verified against the app's own source (Android
 * manifests, Info.plist / tauri.conf.json / runtime protocol registration) or
 * its store listing — see the matrix in the one-click design doc.
 */
type ClientOSType = 'android' | 'ios' | 'windows' | 'linux' | 'macos';

interface ClientLinkStrategy {
    platforms: ClientOSType[];
    schemes?: Partial<Record<ClientOSType, string>>;
    scheme?: string;
    fileImport?: boolean;
    uriList?: boolean;
}

const ANDROID_ONLY: ClientOSType[] = ['android'];
const DESKTOP: ClientOSType[] = ['windows', 'linux', 'macos'];
const APPLE: ClientOSType[] = ['ios', 'macos'];
const EVERY_OS: ClientOSType[] = ['android', 'ios', 'windows', 'linux', 'macos'];

export const clientLinks: Record<string, ClientLinkStrategy> = {
    // Xray-core Android client. AndroidManifest registers scheme `v2rayng`
    // with host `install-sub`, so the subscription imports in one tap.
    // Its importer base64-decodes the body and parses it line by line, so it
    // handles the raw URI-list rows as well as the Xray profile rows.
    'v2rayNG': {
        platforms: ANDROID_ONLY,
        scheme: 'v2rayng://install-sub?url={enc}',
        uriList: true
    },
    // A v2rayNG fork — same package-level intent filter, same scheme.
    'MahsaNG': {
        platforms: ANDROID_ONLY,
        scheme: 'v2rayng://install-sub?url={enc}',
        uriList: true
    },
    // Desktop Xray GUI (Windows/Linux/macOS). Its `v2rayn://` constant is an
    // internal export format only — the app never registers an OS protocol
    // handler, so there is nothing to fire. Copy the URL for pasting.
    'v2rayN': { platforms: DESKTOP },
    // Desktop Xray-knocker (Warp Pro) build of the same app.
    'v2rayN-PRO': { platforms: DESKTOP },

    // iOS/iPadOS only (no Mac build on its App Store listing). Imports a
    // remote subscription via `streisand://import/<url>`.
    'Streisand': {
        platforms: ['ios'],
        scheme: 'streisand://import/{url}'
    },
    // iOS/iPadOS + Apple silicon Macs. `sub://` takes the base64 of the
    // subscription URL itself, and its importer reads a base64 URI list.
    'Shadowrocket': {
        platforms: APPLE,
        scheme: 'sub://{b64}',
        uriList: true
    },
    // OpenWrt router package — configured from the router's web UI, not from
    // a phone or desktop app, so there is never a scheme to fire.
    'PassWall': { platforms: [] },

    // Multi-platform sing-box GUI. Registers hiddify/v2ray/clash/sing-box
    // schemes on Android and macOS, and writes the same handlers into the
    // Windows registry at first run.
    // Its LinkParser accepts any subscription body, URI list included.
    'Hiddify': {
        platforms: EVERY_OS,
        scheme: 'hiddify://install-config?url={enc}',
        uriList: true
    },

    // sing-box official clients: SFA (Android), SFI (iOS), SFM (macOS) all
    // register `sing-box://import-remote-profile`.
    'sing-box': {
        platforms: ['android', 'ios', 'macos'],
        scheme: 'sing-box://import-remote-profile?url={url}'
    },
    // Android sing-box client. Prefer its exclusive `husi://subscription`
    // over the shared sing-box scheme (SFA claims that one too); its
    // isSubscriptionUri() accepts both, and parseProxies() splits the fetched
    // body into per-line proxy URIs.
    'husi': {
        platforms: ANDROID_ONLY,
        scheme: 'husi://subscription?url={enc}',
        uriList: true
    },
    // Android sing-box client. It also registers `clash://install-config`,
    // but that scheme is contested — Clash Meta, Hiddify and FlClash claim it
    // too, so firing it opens whichever app owns it rather than NekoBox. Its
    // own `sn://subscription` is exclusive, and importSubscription() reads
    // `url` and `name` from it to create a real subscription group.
    // Pass `name` explicitly: unlike the others it never reads the URL
    // fragment for a title, and without the param it names the group
    // "Subscription #<timestamp>".
    'NekoBox': {
        platforms: ANDROID_ONLY,
        scheme: 'sn://subscription?url={enc}&name={name}',
        uriList: true
    },
    // Flutter sing-box GUI. Registers only its own `karing` scheme, and its
    // handler accepts both `install-config` and `import-remote-profile`.
    // Advertises Clash/V2ray/sing-box/Sub subscription support.
    'Karing': {
        platforms: ['android', 'ios', 'windows', 'linux', 'macos'],
        scheme: 'karing://install-config?url={enc}',
        uriList: true
    },

    // Clash Meta for Android — manifest registers clash/clashmeta with host
    // `install-config`. `clashmeta` is the narrower of the two.
    'Clash Meta': {
        platforms: ANDROID_ONLY,
        scheme: 'clashmeta://install-config?url={enc}'
    },
    // Tauri desktop app; tauri.conf.json declares desktop schemes
    // ["clash", "clash-verge"] and its scheme.rs accepts a `url=` param.
    // `clash-verge` is exclusive to it, so it wins over a co-installed
    // Clash client that also registered the generic `clash` scheme.
    'Clash Verge': {
        platforms: DESKTOP,
        scheme: 'clash-verge://install-config?url={enc}'
    },
    'Clash verge rev': {
        platforms: DESKTOP,
        scheme: 'clash-verge://install-config?url={enc}'
    },
    // Flutter ClashMeta GUI on Android + desktop (no iOS build). Registers
    // clash/clashmeta/flclash in its manifest and macOS Info.plist; use the
    // exclusive `flclash` alias so a co-installed Clash app cannot intercept
    // it. Its LinkManager still requires the `install-config` host.
    'FlClash': {
        platforms: ['android', 'windows', 'linux', 'macos'],
        scheme: 'flclash://install-config?url={enc}'
    },
    // iOS/iPadOS/tvOS/macOS Clash client. Its docs list both
    // `stash://install-config?url=` and the shared `clash://` form; use the
    // exclusive one so a co-installed Clash client cannot intercept it.
    'Stash': {
        platforms: APPLE,
        scheme: 'stash://install-config?url={enc}'
    },

    // WireGuard-family: no remote-subscription scheme on any OS. Downloading
    // the .conf and opening it with the app is the one-tap path here.
    'Wireguard': { platforms: EVERY_OS, fileImport: true },
    'WG Tunnel': { platforms: ANDROID_ONLY, fileImport: true },
    'Amnezia': { platforms: EVERY_OS, fileImport: true },
};

export const clients: Client[] = [
    { name: `${_V2_}NG`, minVer: '2.2.3', source: 'Github', b64Url: 'aHR0cHM6Ly9naXRodWIuY29tLzJkdXN0L3YycmF5TkcvcmVsZWFzZXMvbGF0ZXN0' },
    { name: `${_V2_}N`, minVer: '7.22.5', source: 'Github', b64Url: 'aHR0cHM6Ly9naXRodWIuY29tLzJkdXN0L3YycmF5Ti9yZWxlYXNlcy9sYXRlc3Q=' },
    { name: 'MahsaNG', minVer: '17', source: 'Google Play', b64Url: 'aHR0cHM6Ly9wbGF5Lmdvb2dsZS5jb20vc3RvcmUvYXBwcy9kZXRhaWxzP2lkPWNvbS5NYWhzYU5ldC5NYWhzYU5HJmhsPWVu' },
    { name: 'Streisand', minVer: '1.6.71', source: 'App Store', b64Url: 'aHR0cHM6Ly9hcHBzLmFwcGxlLmNvbS91cy9hcHAvc3RyZWlzYW5kL2lkNjQ1MDUzNDA2NA==' },
    { name: 'sing-box', minVer: '1.12.0', source: 'Github', b64Url: 'aHR0cHM6Ly9naXRodWIuY29tL1NhZ2VyTmV0L3NpbmctYm94L3JlbGVhc2VzL2xhdGVzdA==' },
    { name: 'husi', minVer: '1.3.2', source: 'Codeberg', b64Url: 'aHR0cHM6Ly9jb2RlYmVyZy5vcmcveGNoYWNoYTIwLXBvbHkxMzA1L2h1c2kvcmVsZWFzZXMvbGF0ZXN0' },
    { name: 'NekoBox', minVer: '1.3.2', source: 'Github', b64Url: 'aHR0cHM6Ly9naXRodWIuY29tL01hdHN1cmlkYXlvL05la29Cb3hGb3JBbmRyb2lkL3JlbGVhc2VzL2xhdGVzdA==' },
    { name: 'Clash Meta', minVer: '2.11.31', source: 'Github', b64Url: 'aHR0cHM6Ly9naXRodWIuY29tL01ldGFDdWJlWC9DbGFzaE1ldGFGb3JBbmRyb2lkL3JlbGVhc2VzL2xhdGVzdA==' },
    { name: 'Clash verge rev', minVer: '2.5.1', source: 'Github', b64Url: 'aHR0cHM6Ly9naXRodWIuY29tL2NsYXNoLXZlcmdlLXJldi9jbGFzaC12ZXJnZS1yZXYvcmVsZWFzZXMvbGF0ZXN0' },
    { name: 'FlClash', minVer: '0.8.94', source: 'Github', b64Url: 'aHR0cHM6Ly9naXRodWIuY29tL2NoZW4wODIwOS9GbENsYXNoL3JlbGVhc2VzL2xhdGVzdA==' },
    { name: 'Stash', minVer: '3.4.1', source: 'App Store', b64Url: 'aHR0cHM6Ly9hcHBzLmFwcGxlLmNvbS91cy9hcHAvc3Rhc2gtcnVsZS1iYXNlZC1wcm94eS9pZDE1OTYwNjMzNDk=' },
    { name: 'Amnezia', minVer: '4.8.21.0', source: 'Github', b64Url: 'aHR0cHM6Ly9naXRodWIuY29tL2FtbmV6aWEtdnBuL2FtbmV6aWEtY2xpZW50L3JlbGVhc2VzL2xhdGVzdA==' },
    { name: 'Wireguard', minVer: 'Stable', source: 'Official Website', b64Url: 'aHR0cHM6Ly93d3cud2lyZWd1YXJkLmNvbS9pbnN0YWxsLw==' },
    { name: 'WG Tunnel', minVer: '5.1.0', source: 'Github', b64Url: 'aHR0cHM6Ly9naXRodWIuY29tL3dndHVubmVsL2FuZHJvaWQvcmVsZWFzZXMvbGF0ZXN0' },
];

let kvSettings: KvSettings = {
    localDNS: '8.8.8.8',
    antiSanctionDNS: '178.22.122.100',
    fakeDNS: false,
    enableIPv6: false,
    allowLANConnection: false,
    logLevel: 'warning',
    customDomain: '',
    protocols: `${_VL_},${_TR_}`,
    remoteDNS: 'https://8.8.8.8/dns-query',
    remoteDnsHost: {
        isDomain: false,
        host: '8.8.8.8',
        ipv4: [],
        ipv6: []
    },
    upstreamProxy: '',
    upstreamParams: {
        upstreamServer: '',
        upstreamPort: 0
    },
    chainProxy: '',
    chainProxyParams: {},
    cleanIPs: ['www.speedtest.net'],
    ports: [443],
    fingerprint: 'chrome',
    bestPingInterval: 30,
    enableTFO: false,
    enableECH: false,
    echServerName: '',
    customCdnAddrs: [],
    customCdnHost: '',
    customCdnSni: '',
    fragmentMode: 'custom',
    fragmentPackets: 'tlshello',
    fragmentLengthMin: 100,
    fragmentLengthMax: 200,
    fragmentDelayMin: 1,
    fragmentDelayMax: 1,
    fragmentMaxSplitMin: 0,
    fragmentMaxSplitMax: 0,
    customSubs: [],
    customConfigs: [],
    warpRemoteDNS: '1.1.1.1',
    warpEndpoints: ['engage.cloudflareclient.com:2408'],
    warpBestPingInterval: 30,
    warpReservedBytes: true,
    xrayUdpNoises: [{
        type: 'rand',
        packet: '50-100',
        delay: '1-5',
        count: 5
    }],
    knockerNoiseMode: 'quic',
    knockerNoiseCountMin: 10,
    knockerNoiseCountMax: 15,
    knockerNoiseSizeMin: 5,
    knockerNoiseSizeMax: 10,
    knockerNoiseDelayMin: 1,
    knockerNoiseDelayMax: 1,
    amneziaNoiseCount: 5,
    amneziaNoiseSizeMin: 50,
    amneziaNoiseSizeMax: 100,
    bypassIran: false,
    bypassChina: false,
    bypassRussia: false,
    bypassOpenAi: false,
    bypassGoogleAi: false,
    bypassMicrosoft: false,
    bypassOracle: false,
    bypassDocker: false,
    bypassAdobe: false,
    bypassEpicGames: false,
    bypassIntel: false,
    bypassAmd: false,
    bypassNvidia: false,
    bypassAsus: false,
    bypassHp: false,
    bypassLenovo: false,
    blockAds: false,
    blockPorn: false,
    blockUDP443: false,
    blockMalware: false,
    blockPhishing: false,
    blockCryptominers: false,
    customBypassRules: [],
    customBlockRules: [],
    customBypassSanctionRules: [],
    remoteSettings: '',
    panelVersion: VERSION
};