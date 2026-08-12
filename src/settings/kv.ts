import { DnsHost, KvSettings, PanelSettings, TelegramBot, WarpAccount } from '#types/settings';
import { extractProxyParams, extractUpstreamParams, getDomain, resolveDNS } from '@utils';
import { fetchWarpAccounts } from '@api/warp';
import { safeError } from '@common';
import { getKvSettings } from '@settings';
import { setCustomDomain } from '@main';
import { isValidNameTemplate, MIN_NAME_MAX_LENGTH, NAME_TEMPLATE_VERSION, migrateNameTemplate } from '@cores/naming';

export async function getDataset(env: Env): Promise<{
    settings: KvSettings,
    telegramBot: TelegramBot,
    warpAccounts: WarpAccount[]
}> {
    let settings: KvSettings | null, warpAccounts: WarpAccount[] | null;
    const kvSettings = getKvSettings();

    try {
        const rawSettings = await env.kv.get('proxySettings', { type: 'json' });
        warpAccounts = await env.kv.get('warpAccounts', { type: 'json' });
        const storedSettings = rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)
            ? rawSettings as Partial<KvSettings>
            : null;
        settings = normalizeSettings(storedSettings, kvSettings);

        // Add newly introduced naming fields and migrate older token casing once.
        // The merge keeps existing user settings intact while making old KV data
        // safe for the current panel and subscription builders.
        if (!storedSettings
            || storedSettings.nameTemplateVersion !== NAME_TEMPLATE_VERSION
            || !('nameFormat' in storedSettings)
            || !('nameMaxLength' in storedSettings)
            || !('nameGeoMode' in storedSettings)
            || !('nameFreezeGeo' in storedSettings)
            || !('nameAddressGroups' in storedSettings)
            || !('latencyAutoTest' in storedSettings)
            || !('latencyIntervalMin' in storedSettings)) {
            await env.kv.put('proxySettings', JSON.stringify(settings));
        }

        // A previous failed registration or a mock/partial import can leave an
        // empty or malformed `warpAccounts` value in KV. Treat that the same as
        // a cache miss; every Warp/WireGuard/Amnezia builder needs both accounts
        // and otherwise the subscription request fails while destructuring the
        // first account.
        if (!hasUsableWarpAccounts(warpAccounts)) {
            warpAccounts = await fetchWarpAccounts(env);
        }

        if (!hasUsableWarpAccounts(warpAccounts)) {
            throw new Error('No usable Warp accounts are available.');
        }

        if (VERSION !== settings.panelVersion) {
            settings = await updateDataset(env);
        }

        let telegramBot: TelegramBot | null = await env.kv.get('telegramBot', { type: 'json' });
        if (!telegramBot) {
            telegramBot = { telegramBotToken: '', telegramUserId: '' };
            await env.kv.put('telegramBot', JSON.stringify(telegramBot));
        }

        return {
            settings,
            telegramBot,
            warpAccounts
        };
    } catch (error) {
        console.error('[kv]', error);
        throw new Error(`An error occurred while getting KV: ${safeError(error)}`);
    }
}

export async function updateDataset(env: Env, newSettings?: PanelSettings): Promise<KvSettings> {
    if (!newSettings) {
        const kvSettings = getKvSettings();
        await env.kv.put('proxySettings', JSON.stringify(kvSettings));
        return kvSettings;
    }

    let currentSettings: KvSettings | null;
    const kvSettings = getKvSettings();

    try {
        currentSettings = await env.kv.get('proxySettings', { type: 'json' });
    } catch (error) {
        console.error('[kv]', error);
        throw new Error(`An error occurred while getting current KV settings: ${safeError(error)}`);
    }

    const getParam = async <T extends keyof KvSettings>(
        key: T,
        cbKey?: T,
        callback?: (value: KvSettings[T]) => any | Promise<any>
    ) => {
        const resolve = (k: T) => newSettings?.[k] ?? currentSettings?.[k] ?? kvSettings[k];

        if (callback && cbKey) {
            const cbValue = resolve(cbKey);
            if (cbValue !== currentSettings?.[cbKey]) {
                return callback(cbValue);
            }
        }

        const value = newSettings?.[key] ?? currentSettings?.[key] ?? kvSettings[key];
        return value;
    };

    const fields: Array<
        [keyof KvSettings] |
        [keyof KvSettings, keyof KvSettings, (key: any) => any | Promise<any>]
    > = [
            ['remoteDNS'],
            ['remoteDnsHost', 'remoteDNS', getDnsParams],
            ['localDNS'],
            ['antiSanctionDNS'],
            ['enableIPv6'],
            ['fakeDNS'],
            ['logLevel'],
            ['allowLANConnection'],
            ['customDomain', 'customDomain', setCustomDomain],
            ['upstreamProxy'],
            ['upstreamParams', 'upstreamProxy', extractUpstreamParams],
            ['chainProxy'],
            ['chainProxyParams', 'chainProxy', extractProxyParams],
            ['cleanIPs'],
            ['customCdnAddrs'],
            ['customCdnHost'],
            ['customCdnSni'],
            ['bestPingInterval'],
            ['protocols'],
            ['ports'],
            ['fingerprint'],
            ['enableTFO'],
            ['fragmentMode'],
            ['fragmentLengthMin'],
            ['fragmentLengthMax'],
            ['fragmentDelayMin'],
            ['fragmentDelayMax'],
            ['fragmentMaxSplitMin'],
            ['fragmentMaxSplitMax'],
            ['fragmentPackets'],
            ['enableECH'],
            ['echServerName'],
            ['bypassIran'],
            ['bypassChina'],
            ['bypassRussia'],
            ['bypassOpenAi'],
            ['bypassGoogleAi'],
            ['bypassMicrosoft'],
            ['bypassOracle'],
            ['bypassDocker'],
            ['bypassAdobe'],
            ['bypassEpicGames'],
            ['bypassIntel'],
            ['bypassAmd'],
            ['bypassNvidia'],
            ['bypassAsus'],
            ['bypassHp'],
            ['bypassLenovo'],
            ['blockAds'],
            ['blockPorn'],
            ['blockUDP443'],
            ['blockMalware'],
            ['blockPhishing'],
            ['blockCryptominers'],
            ['customBypassRules'],
            ['customBlockRules'],
            ['customBypassSanctionRules'],
            ['warpRemoteDNS'],
            ['warpEndpoints'],
            ['warpBestPingInterval'],
            ['warpReservedBytes'],
            ['xrayUdpNoises'],
            ['knockerNoiseMode'],
            ['knockerNoiseCountMin'],
            ['knockerNoiseCountMax'],
            ['knockerNoiseSizeMin'],
            ['knockerNoiseSizeMax'],
            ['knockerNoiseDelayMin'],
            ['knockerNoiseDelayMax'],
            ['amneziaNoiseCount'],
            ['amneziaNoiseSizeMin'],
            ['amneziaNoiseSizeMax'],
            ['customSubs'],
            ['remoteSettings'],
            ['customConfigs'],
            ['nameTemplate'],
            ['nameTemplateVersion'],
            ['nameFormat'],
            ['nameMaxLength'],
            ['nameGeoMode'],
            ['nameFreezeGeo'],
            ['nameAddressGroups'],
            ['latencyAutoTest'],
            ['latencyIntervalMin']
        ];

    try {
        const entries = await Promise.all(
            fields.map(async ([key, callbackKey, callbackFunc]) => {
                return [key, await getParam(key, callbackKey, callbackFunc)];
            })
        );

        const incomingTemplate = newSettings.nameTemplate;
        const rawTemplateVersion = incomingTemplate !== undefined
            // Imported settings from before the version field existed must be
            // treated as version 1 even when the current KV is already newer.
            ? Number(newSettings.nameTemplateVersion ?? 1)
            : Number(currentSettings?.nameTemplateVersion ?? kvSettings.nameTemplateVersion ?? 1);
        const templateVersion = Number.isInteger(rawTemplateVersion) && rawTemplateVersion >= 1
            ? rawTemplateVersion
            : 1;
        const templateSource = incomingTemplate ?? currentSettings?.nameTemplate ?? kvSettings.nameTemplate;
        const migratedTemplate = templateVersion > NAME_TEMPLATE_VERSION
            ? ''
            : migrateNameTemplate(templateSource, templateVersion);
        const updatedSettings: KvSettings = {
            ...Object.fromEntries(entries),
            nameTemplate: isValidNameTemplate(migratedTemplate) ? migratedTemplate : '',
            nameTemplateVersion: NAME_TEMPLATE_VERSION,
            panelVersion: VERSION
        };

        await env.kv.put('proxySettings', JSON.stringify(updatedSettings));
        return updatedSettings;
    } catch (error) {
        console.error('[kv]', error);
        throw new Error(`An error occurred while updating KV: ${safeError(error)}`);
    }
}

function hasUsableWarpAccounts(value: unknown): value is WarpAccount[] {
    return Array.isArray(value)
        && value.length >= 2
        && value.every(account => account
            && typeof account === 'object'
            && typeof account.privateKey === 'string'
            && account.privateKey.length > 0
            && typeof account.publicKey === 'string'
            && account.publicKey.length > 0
            && typeof account.warpIPv6 === 'string'
            && account.warpIPv6.length > 0
            && typeof account.reserved === 'string'
            && account.reserved.length > 0);
}

function normalizeSettings(stored: Partial<KvSettings> | null, defaults: KvSettings): KvSettings {
    const source = stored ?? {};
    const rawVersion = Number(source.nameTemplateVersion ?? 1);
    const version = Number.isInteger(rawVersion) && rawVersion >= 1 ? rawVersion : 1;
    const migratedTemplate = version > NAME_TEMPLATE_VERSION
        ? ''
        : migrateNameTemplate(source.nameTemplate ?? defaults.nameTemplate, version);
    return {
        ...defaults,
        ...source,
        // Never let a hand-edited, future-version, or partially imported invalid
        // template rewrite external configs. Empty is the safe, backwards-
        // compatible behavior and the panel can then show a clean field.
        nameTemplate: isValidNameTemplate(migratedTemplate) ? migratedTemplate : '',
        nameTemplateVersion: NAME_TEMPLATE_VERSION,
        nameFormat: source.nameFormat === 'readable' || source.nameFormat === 'compact' || source.nameFormat === 'ascii'
            ? source.nameFormat
            : defaults.nameFormat,
        nameMaxLength: normalizeNameMaxLength(source.nameMaxLength, defaults.nameMaxLength),
        nameGeoMode: source.nameGeoMode === 'auto' || source.nameGeoMode === 'local' || source.nameGeoMode === 'disabled'
            ? source.nameGeoMode
            : defaults.nameGeoMode,
        nameFreezeGeo: source.nameFreezeGeo === true,
        nameAddressGroups: Array.isArray(source.nameAddressGroups)
            ? source.nameAddressGroups.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean).slice(0, 200)
            : defaults.nameAddressGroups,
        latencyAutoTest: source.latencyAutoTest === true,
        latencyIntervalMin: normalizeLatencyInterval(source.latencyIntervalMin, defaults.latencyIntervalMin)
    } as KvSettings;
}

function normalizeNameMaxLength(value: unknown, fallback: number): number {
    const length = Number(value);
    return Number.isInteger(length)
        && (length === 0 || (length >= MIN_NAME_MAX_LENGTH && length <= 200))
        ? length
        : fallback;
}

function normalizeLatencyInterval(value: unknown, fallback: number): number {
    const interval = Number(value);
    return Number.isInteger(interval) && interval >= 10 && interval <= 1440
        ? interval
        : fallback;
}

async function getDnsParams(dns: string): Promise<DnsHost> {
    const { host, isHostDomain } = getDomain(dns);
    const dohHost: DnsHost = { host, isDomain: isHostDomain, ipv4: [], ipv6: [] };

    if (isHostDomain) {
        const { ipv4, ipv6 } = await resolveDNS(host);
        dohHost.ipv4 = ipv4;
        dohHost.ipv6 = ipv6;
    }

    return dohHost;
}