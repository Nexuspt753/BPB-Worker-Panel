import { decompressGzipBase64, safeError } from '@common';
import { logError } from '@cores/errorlog';

export async function renderError(error: any, env?: Env): Promise<Response> {
    const str = await decompressGzipBase64(ERROR_HTML_CONTENT);
    const html = str
        .replace('__ERROR_MESSAGE__', safeError(error))
        .replaceAll('__ICON__', ICON_CONTENT);

    // Best-effort capture into the bounded error log (never throws).
    if (env?.kv) {
        await logError(env, 'worker', error).catch(() => { });
    }

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}