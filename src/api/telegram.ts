import { HttpStatus, respond, safeError } from '@common';
import { clients, getGlobals, getKvSettings, subscriptions } from '@settings';
import { updateDataset } from '@kv';
import { cleanIpHost, splitIpAndName, normalizeAddress } from '@cores/naming';
import { isDomain, isIPv4, isIPv6 } from '@cores/utils';
import { getCfWorkerUsage } from './usage';
import { authenticate } from '@auth';
import { TelegramBot } from '#types/settings';

export async function setupTelegramWebhook(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'PUT') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const { telegramBotToken, telegramUserId } = await request.json() as any;
        const botToken = telegramBotToken.trim();
        const userID = telegramUserId.trim();

        if (!botToken || !userID) {
            return respond(false, HttpStatus.BAD_REQUEST, 'Missing but info.');
        }

        const { securePath } = getGlobals();
        await setTelegramBot(securePath, botToken);

        const bot: TelegramBot = {
            telegramBotToken: botToken,
            telegramUserId: userID
        };

        await env.kv.put('telegramBot', JSON.stringify(bot));
        return respond(true, HttpStatus.OK, 'Telegram bot setup completed successfully!', bot);
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Error occurred while setting Telegram Bot: ${safeError(error)}`);
    }
}

export async function setTelegramBot(path: string, token: string) {
    const { origin } = getGlobals();
    const webhookUrl = new URL(`/${path}/telegram/webhook`, origin);
    const api = new URL(`https://api.telegram.org/bot${token}/setWebhook`);
    api.searchParams.set('url', webhookUrl.href);

    try {
        const res = await fetch(api);
        const data: any = await res.json();
        if (!data.ok) {
            throw new Error(data.description || 'Failed to set webhook.');
        }

        const commRes = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                commands: [
                    { command: 'start', description: '🤖 Show welcome menu' },
                    { command: 'config', description: '🔗 Get configs' },
                    { command: 'clients', description: '📱 Get supported clients' },
                    { command: 'usage', description: '📊 Monitor usage' },
                    { command: 'listips', description: '🧹 List Clean IPs' },
                    { command: 'addip', description: '➕ Add a Clean IP (ip#Name)' },
                    { command: 'delip', description: '➖ Remove a Clean IP' },
                ]
            })
        });

        const commData: any = await commRes.json();
        if (!commData.ok) {
            throw new Error(commData.description || 'Failed to set bot commands.');
        }
    } catch (error) {
        throw new Error(safeError(error));
    }
}

export async function removeTelegramBot(request: Request, env: Env) {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    try {
        const auth = await authenticate(request, env);
        if (!auth) {
            return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized or expired session.');
        }

        const { telegramBotToken } = await env.kv.get('telegramBot', { type: 'json' }) as any;
        const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/deleteWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                drop_pending_updates: true
            })
        });

        const data = await res.json() as { ok: boolean; description?: string };
        if (!res.ok || !data.ok) {
            throw new Error(data.description || `Failed with status ${res.status}`);
        }

        const bot: TelegramBot = { telegramBotToken: '', telegramUserId: '' };
        await env.kv.put('telegramBot', JSON.stringify(bot));

        return respond(true, HttpStatus.OK, 'Telegram bot webhook deleted successfully!', bot);
    } catch (error) {
        return respond(false, HttpStatus.INTERNAL_SERVER_ERROR, `Error occurred while removing Telegram bot: ${safeError(error)}`);
    }
}

interface TgUser {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
}

interface TgMessage {
    message_id: number;
    from: TgUser;
    chat: { id: number; type: string };
    text?: string;
}

interface TgCallbackQuery {
    id: string;
    from: TgUser;
    message?: { message_id: number; chat: { id: number } };
    data?: string;
}

interface TgUpdate {
    update_id: number;
    message?: TgMessage;
    callback_query?: TgCallbackQuery;
}

function mainKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🔗 Get Config', callback_data: 'sub' }],
            [{ text: '📱 Supported Clients', callback_data: 'clients' }],
            [{ text: '📊 Usage', callback_data: 'usage' }],
        ]
    };
}

function subKeyboard() {
    const subs = Object.entries(subscriptions).map(([type, category]) => [{
        text: `🔗 ${category.label}`,
        callback_data: `sub_${type}`
    }]);

    return {
        inline_keyboard: [
            ...subs,
            [{ text: '◀️ Back', callback_data: 'main' }]
        ]
    };
}

function usageKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🔄 Refresh', callback_data: 'usage_refresh' }],
            [{ text: '◀️ Back', callback_data: 'main' }]
        ]
    };
}

function clientsKeyboard() {
    const suppClients = clients.map(client => [{
        text: `🟢 ${client.name}`,
        callback_data: `client_${client.name}`
    }]);

    return {
        inline_keyboard: [
            ...suppClients,
            [{ text: '◀️ Back', callback_data: 'main' }]
        ]
    };
}

async function tgFetch(token: string, method: string, body: any): Promise<any> {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}

function buildUsageText(totalUsage: number, panelUsage: number): string {
    const panelReqPct = Math.ceil(Number(panelUsage) / 100000 * 100);
    const totalReqPct = Math.ceil(Number(totalUsage) / 100000 * 100);
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    let text = [
        '📊 <b>Cloudflare Workers Usage</b>',
        `━━━━━━━━━━━━━━━━`,
        `📅 Today: ${today}`,
        '',
        `🔵 <b>${_project_} requests</b>`,
        `${panelUsage} / 100,000 (${panelReqPct}%)`,
        '',
        '🔵 <b>Total requests</b>',
        `${totalUsage} / 100,000 (${totalReqPct}%)`,
        '',
        ''
    ].join('<br>');

    if (totalReqPct > 80) {
        text += '🔴 <b>WARNING:</b> Approaching limit!<br>';
    } else {
        text += '✅ All within limits';
    }

    return text;
}

function buildSubUrl(type: string, app: string): URL {
    const { securePath, origin } = getGlobals();

    const url = new URL(`/${securePath}/sub/${type}`, origin);
    url.searchParams.set('app', app);

    return url;
}

function buildClientUrl(type: string, app: string, label: string): string {
    const url = buildSubUrl(type, app);

    if (app === 'sing-box' && type !== 'raw') {
        const singUrl = new URL('sing-box://import-remote-profile');
        singUrl.searchParams.set('url', url.href);
        singUrl.hash = `💦 ${_project_} ${label}`;

        return singUrl.href;
    }

    url.hash = `💦 ${_project_} ${label}`;
    return url.href;
}

function buildQrUrl(type: string, app: string, label: string): string {
    const { securePath, origin } = getGlobals();
    const url = buildClientUrl(type, app, label);

    const qrUrl = new URL(`/${securePath}/qrcode`, origin);
    qrUrl.searchParams.set('data', url);
    qrUrl.searchParams.set('nocache', Date.now().toString());

    return qrUrl.href;
}

function buildDocUrl(type: string, app: string): string | null {
    if (type === 'raw') return null;

    const url = buildSubUrl(type, app);
    const docUrl = new URL(url);

    const configApp = app.replace('xray-knocker', 'mahsang');
    const baseType = `${type}-${configApp}`;
    const isWg = ['wireguard', 'amnezia'].includes(app);

    const configType = isWg ? `${baseType}-conf` : baseType;
    const ext = isWg ? 'zip' : 'json';

    docUrl.pathname = `${url.pathname}/${_project_SM_}-${configType}.${ext}`;
    docUrl.searchParams.set('nocache', Date.now().toString());

    return docUrl.href;
}

async function handleCallback(cq: TgCallbackQuery, token: string, chatId: number): Promise<void> {
    const data = cq.data || '';

    switch (data) {
        case 'sub':
            await tgFetch(token, 'sendMessage', {
                chat_id: chatId,
                text: '🔗 <b>Get Config</b><br><br>Choose a config type:',
                parse_mode: 'HTML',
                reply_markup: subKeyboard()
            });
            break;

        case 'clients':
            await tgFetch(token, 'sendMessage', {
                chat_id: chatId,
                text: '📱 <b>Supported clients</b><br><br>Choose a client:',
                parse_mode: 'HTML',
                reply_markup: clientsKeyboard()
            });
            break;

        case 'usage':
        case 'usage_refresh':
            const result = await getCfWorkerUsage();
            if (!result) {
                await tgFetch(token, 'sendMessage', {
                    chat_id: chatId,
                    text: '⚠️ Could not fetch usage data.',
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'main' }]] }
                });
                break;
            }

            if (!result.success) {
                await tgFetch(token, 'sendMessage', {
                    chat_id: chatId,
                    text: result.error,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'main' }]] }
                });
                break;
            }

            if (!result.total || !result.worker) break;
            const text = buildUsageText(result.total, result.worker);
            if (data === 'usage_refresh' && cq.message?.message_id) {
                await tgFetch(token, 'editMessageText', {
                    chat_id: chatId,
                    message_id: cq.message.message_id,
                    text: text,
                    parse_mode: 'HTML',
                    reply_markup: usageKeyboard()
                });
            } else {
                await tgFetch(token, 'sendMessage', {
                    chat_id: chatId,
                    text: text,
                    parse_mode: 'HTML',
                    reply_markup: usageKeyboard()
                });
            }
            break;

        default:
            const typeKey = data.split('_')[1];
            if (data.startsWith('sub_')) {
                const subscription = subscriptions[typeKey];
                if (!subscription) break;

                for (const [index, appInfo] of subscription.categories.entries()) {
                    const clientUrl = buildClientUrl(typeKey, appInfo.core, subscription.label);
                    const qrUrl = buildQrUrl(typeKey, appInfo.core, subscription.label);
                    const docUrl = buildDocUrl(typeKey, appInfo.core);
                    const wgClient = ['wireguard', 'amnezia'].includes(appInfo.core);

                    const supportedList = appInfo.clients.map(a => `✅ ${a}`).join('<br>');
                    const showUrl = wgClient ? '' : `<code>${clientUrl}</code><br><br>`;
                    const caption = `💦 <b>${_project_} ${subscription.label}</b><br><br>${showUrl}<b>Supported apps:</b><br><br>${supportedList}`;

                    const isLast = index === subscription.categories.length - 1;
                    const backBtn = {
                        reply_markup: {
                            inline_keyboard: [[{ text: '◀️ Back', callback_data: 'sub' }]]
                        }
                    };

                    if (wgClient) {
                        await tgFetch(token, 'sendDocument', {
                            chat_id: chatId,
                            document: docUrl,
                            caption: caption,
                            parse_mode: 'HTML',
                            ...(isLast && backBtn)
                        });
                    } else {
                        const hasDocument = typeKey !== 'raw';

                        await tgFetch(token, 'sendPhoto', {
                            chat_id: chatId,
                            photo: qrUrl,
                            caption: caption,
                            parse_mode: 'HTML',
                            ...(isLast && !hasDocument && backBtn)
                        });

                        if (hasDocument) {
                            await tgFetch(token, 'sendDocument', {
                                chat_id: chatId,
                                document: docUrl,
                                ...(isLast && backBtn)
                            });
                        }
                    }
                }
            }

            if (data.startsWith('client_')) {
                const client = clients.find(cli => cli.name === typeKey);
                if (!client) break;
                let text = [
                    `✅ <b>${client.name}</b>`,
                    `━━━━━━━━━━━━━━━━`,
                    `📍 <b>Minimum requirement:</b> ${client.minVer}`,
                    `🏚️ <b>Download source:</b> ${client.source}`,
                    '',
                    `📥 <a href=\"${atob(client.b64Url)}\"><b>Get latest version</b></a>`,
                    ''
                ].join('<br>');

                await tgFetch(token, 'sendMessage', {
                    chat_id: chatId,
                    text: text,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: '◀️ Back', callback_data: 'clients' }]]
                    }
                });
            }
    }
}

export async function handleTelegramWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const tgBot: TelegramBot | null = await env.kv.get('telegramBot', { type: 'json' });
    if (!tgBot) return new Response(null, { status: 200 });

    const { telegramBotToken: botToken, telegramUserId: userId } = tgBot;
    if (!botToken || !userId) return new Response(null, { status: 200 });

    const update: TgUpdate = await request.json();

    if (update.callback_query) {
        const cq = update.callback_query;
        if (cq.from.id.toString() !== userId) return new Response(null, { status: 200 });

        await tgFetch(botToken, 'answerCallbackQuery', { callback_query_id: cq.id });

        const chatId = cq.message?.chat.id;
        if (!chatId) return new Response(null, { status: 200 });

        const data = cq.data || '';

        if (data === 'main') {
            await tgFetch(botToken, 'sendMessage', {
                chat_id: chatId,
                text: `🤖 <b>${_project_} Panel Bot</b><br><br>Choose an option:`,
                parse_mode: 'HTML',
                reply_markup: mainKeyboard()
            });
        } else {
            await handleCallback(cq, botToken, chatId);
        }

        ctx.waitUntil(checkCfUsageWarning(botToken, chatId).catch(error => console.error('[telegram]', error)));
        return new Response(null, { status: 200 });
    }

    if (update.message) {
        if (update.message.from.id.toString() !== userId) return new Response(null, { status: 200 });

        const chatId = update.message.chat.id;
        const text = update.message.text || '';

        // Clean IP management commands carry arguments, so they are matched
        // by prefix before the exact-match menu switch below.
        if (await handleCleanIpCommand(text, botToken, chatId, env)) {
            ctx.waitUntil(checkCfUsageWarning(botToken, chatId).catch(error => console.error('[telegram]', error)));
            return new Response(null, { status: 200 });
        }

        switch (text) {
            case '/usage':
                const result = await getCfWorkerUsage();
                if (!result.success || !result.worker || !result.total) break;
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: buildUsageText(result.total, result.worker),
                    parse_mode: 'HTML',
                    reply_markup: usageKeyboard()
                });
                break;

            case '/clients':
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: '📱 <b>Supported clients</b><br><br>Choose a client:',
                    parse_mode: 'HTML',
                    reply_markup: clientsKeyboard()
                });
                break;

            case '/config':
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: '🔗 <b>Get Config</b><br><br>Choose a configuration type:',
                    parse_mode: 'HTML',
                    reply_markup: subKeyboard()
                });
                break;

            default:
                await tgFetch(botToken, 'sendMessage', {
                    chat_id: chatId,
                    text: `🤖 <b>${_project_} Panel Bot</b><br><br>Choose an option:`,
                    parse_mode: 'HTML',
                    reply_markup: mainKeyboard()
                });
                break;
        }

        ctx.waitUntil(checkCfUsageWarning(botToken, chatId).catch(error => console.error('[telegram]', error)));
        return new Response(null, { status: 200 });
    }

    return new Response(null, { status: 200 });
}

async function checkCfUsageWarning(botToken: string, chatId: number): Promise<void> {
    const result = await getCfWorkerUsage();
    if (!result.success || !result.worker || !result.total) return;

    const nearLimit = result.total / 100000 * 100 > 80;
    if (nearLimit) {
        await tgFetch(botToken, 'sendMessage', {
            chat_id: chatId,
            text: buildUsageText(result.total, result.worker),
            parse_mode: 'HTML',
            reply_markup: usageKeyboard()
        });
    }
}

// The Clean IP entries accept an optional user label after `#` (see
// splitIpAndName); the bot commands manage exactly those entries.
function isValidIpHost(host: string): boolean {
    return isIPv4(host) || isIPv6(host) || isDomain(host);
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Handle /addip <ip[:port][#Name]>, /delip <host> and /listips.
 * Returns false when the message is not one of these commands so the caller
 * can fall through to the menu switch. Settings are already loaded by the
 * time the webhook runs (handleTelegram calls setSettings first).
 */
export async function handleCleanIpCommand(text: string, botToken: string, chatId: number, env: Env): Promise<boolean> {
    const trimmed = text.trim();
    const isAdd = /^\/addip\b/.test(trimmed);
    const isDelete = /^\/delip\b/.test(trimmed);
    if (!isAdd && !isDelete && trimmed !== '/listips') return false;

    const reply = (html: string) => tgFetch(botToken, 'sendMessage', {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML'
    });

    const settings = getKvSettings();

    try {
        if (trimmed === '/listips') {
            if (!settings.cleanIPs.length) {
                await reply('🧹 <b>Clean IPs</b><br><br>No Clean IPs configured.');
                return true;
            }
            const lines = settings.cleanIPs.map(entry => {
                const { host, name } = splitIpAndName(entry);
                return `• <code>${escapeHtml(host)}</code>${name ? ` — ${escapeHtml(name)}` : ''}`;
            });
            await reply(`🧹 <b>Clean IPs</b> (${settings.cleanIPs.length})<br><br>${lines.join('<br>')}`);
            return true;
        }

        if (isAdd) {
            const entry = trimmed.replace(/^\/addip\s*/u, '');
            const { host, name } = splitIpAndName(entry);
            if (!host || !isValidIpHost(host)) {
                await reply('⚠️ <b>Usage:</b> <code>/addip 143.112.242.123#Fast-Direct</code><br>The host must be a valid IPv4, IPv6 or domain.');
                return true;
            }

            if (settings.cleanIPs.some(candidate => normalizeAddress(cleanIpHost(candidate)) === normalizeAddress(host))) {
                await reply(`ℹ️ <code>${escapeHtml(host)}</code> is already configured. Send /listips to see it.`);
                return true;
            }

            // Keep the user's label; a bare host stays a legacy entry.
            settings.cleanIPs.push(name ? `${host}#${name}` : host);
            await updateDataset(env);
            await reply(`✅ Added Clean IP <code>${escapeHtml(host)}</code>${name ? ` as <b>${escapeHtml(name)}</b>` : ''}.<br>Update your subscription to pick up the new configs.`);
            return true;
        }

        // /delip
        const target = trimmed.replace(/^\/delip\s*/u, '');
        const { host } = splitIpAndName(target);
        if (!host || !isValidIpHost(host)) {
            await reply('⚠️ <b>Usage:</b> <code>/delip 143.112.242.123</code>');
            return true;
        }

        const before = settings.cleanIPs.length;
        settings.cleanIPs = settings.cleanIPs.filter(candidate => normalizeAddress(cleanIpHost(candidate)) !== normalizeAddress(host));
        if (settings.cleanIPs.length === before) {
            await reply(`ℹ️ No Clean IP matching <code>${escapeHtml(host)}</code> was found.`);
            return true;
        }

        await updateDataset(env);
        await reply(`🗑️ Removed Clean IP <code>${escapeHtml(host)}</code>.<br>Update your subscription to drop its configs.`);
        return true;
    } catch (error) {
        console.error('[telegram] clean-ip command failed:', error);
        await reply('❌ Could not update Clean IPs. Check the Worker logs and try again.');
        return true;
    }
}