import { handleTelegramWebhook, removeTelegramBot, setupTelegramWebhook } from '@api/telegram';
import { getGlobals, setSettings } from '@settings';
import { fallback } from './utils';

export async function handleTelegram(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await setSettings(env);
    const { pathname } = getGlobals();
    const path = pathname.split('/')[3];

    switch (path) {
        case 'setup':
            return setupTelegramWebhook(request, env);
        
        case 'remove':
            return removeTelegramBot(request, env);

        case 'webhook':
            return handleTelegramWebhook(request, env, ctx);

        default:
            return fallback(request);
    }
}