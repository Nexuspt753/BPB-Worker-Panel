import { PanelSettings, TelegramBot } from '#types/settings';
import { deployPages, deletePagesProject } from '@api/pages';
import { getUsage } from '@api/usage';
import { fetchWarpAccounts } from '@api/warp';
import { deployWorkers, deleteWorker } from '@api/workers';
import { resetPassword, logout, authenticate } from '@auth';
import { decompressGzipBase64, respond, HttpStatus, safeError } from '@common';
import { getDataset, updateDataset } from '@kv';
import { buildScript, updateMainSettings } from '@main';
import { getGlobals, getMainSettings, subscriptions, clients, clientLinks } from '@settings';
import { validateSettings } from '@validators';
import { fallback } from './utils';
import { setTelegramBot } from '@api/telegram';
import { buildNamePreview, MAX_NAME_TEMPLATE_LENGTH, MIN_NAME_MAX_LENGTH, NAME_TEMPLATE_TOKENS } from '@cores/naming';
import { testChainProxy } from '@cores/chain-test';
import { getUsageSummary } from '@cores/usage';
import { readChainHealth, checkChainHealth } from '@cores/chain-health';
import { sendTelegramMessage } from '@api/telegram';
import { listBackups, getBackup, snapshotSettings } from '@cores/backup';
import { readErrors, clearErrors } from '@cores/errorlog';
import { readAccessLog } from '@cores/accesslog';
import { getLatencyRecords } from '@cores/latency';
import { probeAddress, setLatency } from '@cores/latency';
import { parseHostPort } from '@cores/utils';

export async function handlePanel(request: Request, env: Env): Promise<Response> {
    const { pathname } = getGlobals();
    const parts = pathname.split('/');
    const path = parts.slice(2).join('/');

    switch (path) {
        case 'panel':
            return renderPanel(request, env);

        case 'panel/settings':
            return getPanelSettings(request, env);

        case 'panel/name-preview':
            return previewNames(request, env);

        case 'panel/test-chain-proxy':
            return testChainProxyEndpoint(request, env);

        case 'panel/regenerate-name-snapshots':
            return regenerateNameSnapshots(request, env);

        case 'panel/update-settings':
            return updatePanelSettings(request, env);

        case 'panel/reset-settings':
            return resetPanelSettings(request, env);

        case 'panel/reset-password':
            return resetPassword(request, env);

        case 'panel/my-ip':
            return getMyIP(request);

        case 'panel/update-warp':
            return updateWarpConfigs(request, env);

        case 'panel/update-panel':
            return updatePanel(request, env);

        case 'panel/delete-panel':
            return deletePanel(request, env);

        case 'panel/usage':
            return getUsage(request, env);

        case 'panel/usage-stats':
            return getUsageStats(request, env);

        case 'panel/chain-health':
            return getChainHealth(request, env);

        case 'panel/run-chain-health':
            return runChainHealth(request, env);

        case 'panel/backups':
            return getBackups(request, env);

        case 'panel/restore-backup':
            return restoreBackup(request, env);

        case 'panel/error-log':
            return getErrorLog(request, env);

        case 'panel/clear-error-log':
            return clearErrorLog(request, env);

        case 'panel/access-log':
            return getAccessLog(request, env);

        case 'panel/endpoints':
            return getEndpoints(request, env);

        case 'panel/probe-endpoint':
            return probeEndpoint(request, env);

        case 'panel/import-configs':
            return importConfigs(request, env);

        case 'panel/logout':
            return logout();

        default:
            return fallback(request);
    }
}

async function renderPanel(request: Request, env: Env): Promise<Response> {
    const pwd = await env.kv.get('pwd');
    if (pwd) {
        const auth = await authenticate(request, env);
        if (!auth) {
            const url = new URL('./login', request.url);
            return Response.redirect(url, 302);
        }
    }

    const str = await decompressGzipBase64(PANEL_HTML_CONTENT);
    const html = str
        .replaceAll('__ICON__', ICON_CONTENT)
        .replace(/JSON\.parse\(["']__NAME_TEMPLATE_TOKENS__["']\)/, JSON.stringify(NAME_TEMPLATE_TOKENS));

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

async function updatePanel(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const { deployType } = getGlobals();
        const script = await buildScript(true);
        if (deployType === 'pages') {
            await deployPages(script);
        } else {
            await deployWorkers(script);
        }

        return respond(true, HttpStatus.OK);
    } catch (error) {
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error occurred while upgrading panel: ${safeError(error)}`
        );
    }
}

async function deletePanel(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const { deployType } = getGlobals();
        if (deployType === 'pages') {
            await deletePagesProject();
        } else {
            await deleteWorker();
        }

        return respond(true, HttpStatus.OK);
    } catch (error) {
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error occurred while deleting panel: ${safeError(error)}`
        );
    }
}

async function previewNames(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    const auth = await authenticate(request, env);
    if (!auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
    }

    try {
        const rawBody = await request.text();
        if (new TextEncoder().encode(rawBody).byteLength > 16 * 1024) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Preview request is too large.');
        }

        const body = JSON.parse(rawBody) as {
            template?: unknown;
            mode?: unknown;
            maxLength?: unknown;
            geoMode?: unknown;
            latencyAutoTest?: unknown;
            nameFreezeGeo?: unknown;
            addressGroups?: unknown;
        };
        if (typeof body.template !== 'string' || body.template.length > MAX_NAME_TEMPLATE_LENGTH) {
            return respond(false, HttpStatus.BAD_REQUEST, `Template must be at most ${MAX_NAME_TEMPLATE_LENGTH} characters.`);
        }

        const mode = body.mode === 'compact' || body.mode === 'ascii' ? body.mode : 'readable';
        const hasLength = body.maxLength !== undefined && body.maxLength !== null && body.maxLength !== '';
        const requestedLength = Number(body.maxLength);
        if (hasLength && (!Number.isInteger(requestedLength)
            || (requestedLength !== 0 && (requestedLength < MIN_NAME_MAX_LENGTH || requestedLength > 200)))) {
            return respond(false, HttpStatus.BAD_REQUEST, `Use 0 for unlimited or a whole number between ${MIN_NAME_MAX_LENGTH} and 200.`);
        }
        const maxLength = requestedLength > 0 ? requestedLength : undefined;
        const addressGroups = Array.isArray(body.addressGroups)
            ? body.addressGroups.filter((entry): entry is string => typeof entry === 'string')
            : undefined;
        return respond(true, HttpStatus.OK, '', buildNamePreview(body.template, {
            mode,
            maxLength,
            geoMode: body.geoMode === 'local' || body.geoMode === 'disabled' ? body.geoMode : 'auto',
            latencyAutoTest: body.latencyAutoTest === true,
            nameFreezeGeo: body.nameFreezeGeo === true,
            addressGroups
        }));
    } catch (error) {
        return respond(false, HttpStatus.BAD_REQUEST, safeError(error));
    }
}

async function testChainProxyEndpoint(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    const auth = await authenticate(request, env);
    if (!auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
    }

    try {
        const body = await request.json() as { chainProxy?: unknown };
        if (typeof body.chainProxy !== 'string' || !body.chainProxy.trim()) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Enter a Chain Proxy config to test.');
        }

        const result = await testChainProxy(body.chainProxy.trim());
        return respond(true, HttpStatus.OK, '', result);
    } catch (error) {
        return respond(false, HttpStatus.BAD_REQUEST, safeError(error));
    }
}

async function regenerateNameSnapshots(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    const auth = await authenticate(request, env);
    if (!auth) return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');

    try {
        let cursor: string | undefined;
        const names: string[] = [];
        do {
            const listed = await env.kv.list({ prefix: 'nameSnapshot:', ...(cursor ? { cursor } : {}) });
            names.push(...listed.keys.map(key => key.name));
            cursor = listed.list_complete ? undefined : listed.cursor || undefined;
        } while (cursor);

        await Promise.all(names.map(name => env.kv.delete(name)));
        return respond(true, HttpStatus.OK, 'Frozen config names will be regenerated on the next subscription fetch.', { count: names.length });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function getPanelSettings(request: Request, env: Env): Promise<Response> {
    const isPassSet = Boolean(await env.kv.get('pwd'));

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.', { isPassSet });
        }

        const { settings: kvSettings, telegramBot } = await getDataset(env);
        const mainSettings = getMainSettings();
        const data = {
            proxySettings: { ...kvSettings, ...mainSettings },
            telegramSettings: telegramBot,
            subscriptions,
            clients,
            clientLinks,
            isPassSet
        };

        return respond(true, HttpStatus.OK, undefined, data, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
    } catch (error) {
        console.error('[panel]', error);
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error occurred while fetching settings: ${safeError(error)}`
        );
    }
}

async function updatePanelSettings(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'PUT') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const newSettings: PanelSettings = await request.json();
        const errors = validateSettings(newSettings);
        if (errors) return respond(false, HttpStatus.BAD_REQUEST, 'Validation Error', errors);

        // Best-effort snapshot of the current settings before applying, so a bad
        // change can be rolled back. A snapshot failure never blocks the apply.
        await snapshotSettings(env);

        // Persist KV only after a successful deploy so a failed redeploy cannot
        // leave KV and the baked-in env vars disagreeing.
        await updateMainSettings(newSettings);
        await updateDataset(env, newSettings);

        const { securePath } = getGlobals();
        if (newSettings.securePath !== securePath) {
            const bot: TelegramBot | null = await env.kv.get('telegramBot', { type: 'json' });
            if (bot) {
                await setTelegramBot(newSettings.securePath, bot.telegramBotToken);
            }
        }

        return respond(true, HttpStatus.OK, '');
    } catch (error) {
        console.error('[panel]', error);
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function resetPanelSettings(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed!');
    }

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const [kvSettings, mainSettings] = await Promise.all([
            updateDataset(env),
            updateMainSettings(null)
        ]);

        return respond(true, HttpStatus.OK, '', { ...kvSettings, ...mainSettings });
    } catch (error) {
        console.error('[panel]', error);
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error occurred while resetting settings: ${safeError(error)}`
        );
    }
}

async function getMyIP(request: Request): Promise<Response> {
    const ip = await request.text();

    try {
        const response = await fetch(`http://ip-api.com/json/${ip}?nocache=${Date.now()}`);
        const geoLocation = await response.json();
        return respond(true, HttpStatus.OK, '', geoLocation);
    } catch (error) {
        console.error('Error fetching IP address:', error);
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `Error fetching IP address: ${safeError(error)}`
        )
    }
}

async function updateWarpConfigs(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        await fetchWarpAccounts(env);
        return respond(true, HttpStatus.OK, 'Warp configs updated successfully!');
    } catch (error) {
        console.error('[panel]', error);
        return respond(
            false,
            HttpStatus.INTERNAL_SERVER_ERROR,
            `An error occurred while updating Warp configs: ${safeError(error)}`
        );
    }
}

async function getUsageStats(request: Request, env: Env): Promise<Response> {
    try {
        const auth = await authenticate(request, env);
        if (!auth) return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        const rows = await getUsageSummary(env);
        return respond(true, HttpStatus.OK, '', rows);
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function getChainHealth(request: Request, env: Env): Promise<Response> {
    try {
        const auth = await authenticate(request, env);
        if (!auth) return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        return respond(true, HttpStatus.OK, '', await readChainHealth(env));
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function runChainHealth(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    try {
        const auth = await authenticate(request, env);
        if (!auth) return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        const { settings } = await getDataset(env);
        const { chainProxy } = settings;
        if (!(chainProxy ?? '').trim()) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Enter a Chain Proxy config first.');
        }
        const state = await checkChainHealth(env, chainProxy, message => sendTelegramMessage(env, message), true);
        return respond(true, HttpStatus.OK, '', state);
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function getBackups(request: Request, env: Env): Promise<Response> {
    try {
        const auth = await authenticate(request, env);
        if (!auth) return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        return respond(true, HttpStatus.OK, '', await listBackups(env));
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function restoreBackup(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    try {
        const auth = await authenticate(request, env);
        if (!auth) return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        const { ts } = await request.json() as { ts?: unknown };
        const tsNum = Number(ts);
        if (!Number.isInteger(tsNum) || tsNum <= 0) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Invalid backup timestamp.');
        }
        const value = await getBackup(env, tsNum);
        if (value === null) {
            return respond(false, HttpStatus.NOT_FOUND, 'Backup not found.');
        }

        // Validate before restoring so a corrupt/hand-edited snapshot can't
        // inject invalid settings. Reuse the same normalization as a normal apply.
        const parsed = JSON.parse(value) as PanelSettings;
        const errors = validateSettings(parsed);
        if (errors) return respond(false, HttpStatus.BAD_REQUEST, 'Backup failed validation', errors);

        // Snapshot the current (pre-restore) state first so the restore itself
        // is undoable, then write the restored settings through the same path.
        await snapshotSettings(env);
        await updateDataset(env, parsed);
        return respond(true, HttpStatus.OK, 'Settings restored.');
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function getErrorLog(request: Request, env: Env): Promise<Response> {
    try {
        const auth = await authenticate(request, env);
        if (!auth) return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        return respond(true, HttpStatus.OK, '', await readErrors(env));
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function clearErrorLog(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    try {
        const auth = await authenticate(request, env);
        if (!auth) return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        await clearErrors(env);
        return respond(true, HttpStatus.OK, 'Error log cleared.');
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function getAccessLog(request: Request, env: Env): Promise<Response> {
    try {
        const auth = await authenticate(request, env);
        if (!auth) return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        return respond(true, HttpStatus.OK, '', await readAccessLog(env));
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function getEndpoints(request: Request, env: Env): Promise<Response> {
    try {
        const auth = await authenticate(request, env);
        if (!auth) return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        return respond(true, HttpStatus.OK, '', await getLatencyRecords(env));
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function probeEndpoint(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    try {
        const auth = await authenticate(request, env);
        if (!auth) return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        const { address, port } = await request.json() as { address?: unknown; port?: unknown };
        if (typeof address !== 'string' || !address.trim()) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Enter an address to probe.');
        }
        const parsed = parseHostPort(address.trim(), true);
        const host = parsed.host || address.trim();
        const probePort = Number(port) || parsed.port || 443;
        if (!Number.isInteger(probePort) || probePort < 1 || probePort > 65535) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Invalid port.');
        }
        const result = await probeAddress(host, probePort);
        if (result.healthy) {
            await setLatency(env, host, result.elapsedMs, probePort);
        }
        return respond(true, HttpStatus.OK, '', { address: host, port: probePort, ms: result.elapsedMs, healthy: result.healthy, reachable: result.reachable });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

async function importConfigs(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    try {
        const auth = await authenticate(request, env);
        if (!auth) return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');

        const body = await request.json() as { uris?: unknown };
        const uris = Array.isArray(body.uris)
            ? body.uris.filter((line): line is string => typeof line === 'string').map(line => line.trim()).filter(Boolean)
            : [];

        if (!uris.length) return respond(false, HttpStatus.BAD_REQUEST, 'Paste at least one config to import.');
        if (uris.length > 500) return respond(false, HttpStatus.BAD_REQUEST, 'Too many configs (max 500).');

        const { settings } = await getDataset(env);
        const { customConfigs } = settings;
        const existing = new Set<string>((customConfigs ?? []).map(value => value.trim()).filter(Boolean));

        const added: string[] = [];
        const skipped: Array<{ line: string; reason: string }> = [];
        for (const line of uris) {
            if (line.length > 8192) {
                skipped.push({ line: line.slice(0, 80) + '…', reason: 'too long' });
                continue;
            }
            const fingerprint = fingerprintConfig(line);
            if (!fingerprint) {
                skipped.push({ line: line.slice(0, 80), reason: 'unsupported or invalid config URL' });
                continue;
            }
            if (existing.has(line) || existing.has(fingerprint)) {
                skipped.push({ line: line.slice(0, 80), reason: 'duplicate' });
                continue;
            }
            added.push(line);
            existing.add(line);
            existing.add(fingerprint);
        }

        if (!added.length) {
            return respond(false, HttpStatus.BAD_REQUEST, 'No valid configs to import.', skipped);
        }

        // Merge with existing settings, never replace them.
        const merged = [...(customConfigs ?? []), ...added];
        await updateDataset(env, { customConfigs: merged } as PanelSettings);
        return respond(true, HttpStatus.OK, `Imported ${added.length} config(s).`, { added: added.length, skipped });
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, safeError(error));
    }
}

// A stable fingerprint for dedupe: server + port + credential for the supported
// protocol families. Returns null when the line is not a supported config URL.
function fingerprintConfig(line: string): string | null {
    try {
        const url = new URL(line);
        const supported = new Set(['vless:', 'trojan:', 'vmess:', 'ss:', 'shadowsocks:', 'socks:', 'socks5:', 'http:', 'https:']);
        if (!supported.has(url.protocol)) return null;
        if (url.protocol === 'vmess:') {
            return `vmess:${url.host}`;
        }
        const host = url.hostname;
        const port = url.port || '';
        if (!host || !port) return null;
        return `${url.protocol}${host}:${port}`;
    } catch {
        return null;
    }
}