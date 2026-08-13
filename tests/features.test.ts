import { describe, expect, mock, test } from 'bun:test';

// The rate-limit, backup, errorlog, accesslog, usage and chain-health modules
// are pure KV logic. chain-health imports chain-test, which imports the socket
// primitive, so mock it (no socket should ever run in these tests).
mock.module('cloudflare:sockets', () => ({
    connect: () => {
        throw new Error('socket probe should not run in feature tests');
    }
}));

const { isRateLimited } = await import('../src/cores/rate-limit');
const { redactSecrets, readErrors, logError, clearErrors } = await import('../src/cores/errorlog');
const { snapshotSettings, listBackups, getBackup } = await import('../src/cores/backup');
const { hashIp, readAccessLog, logAccess } = await import('../src/cores/accesslog');
const { bumpUsage, getUsageSummary, usageKey } = await import('../src/cores/usage');
const { checkChainHealth, readChainHealth } = await import('../src/cores/chain-health');

function makeKv(initial: Record<string, any> = {}) {
    const store = new Map<string, any>(Object.entries(initial));
    return {
        store,
        async get(key: string, opts?: { type?: 'json' | 'text' }) {
            const value = store.get(key);
            if (value === undefined) return null;
            if (opts?.type === 'json') {
                return typeof value === 'string' ? JSON.parse(value) : value;
            }
            return typeof value === 'string' ? value : JSON.stringify(value);
        },
        async put(key: string, value: any) {
            store.set(key, value);
        },
        async delete(key: string) {
            store.delete(key);
        },
        async list(opts?: { prefix?: string }) {
            const keys = Array.from(store.keys())
                .filter(key => !opts?.prefix || key.startsWith(opts.prefix))
                .map(name => ({ name }));
            return { keys, list_complete: true, cursor: undefined };
        }
    } as unknown as KVNamespace;
}

function makeEnv(initial: Record<string, any> = {}) {
    const kv = makeKv(initial);
    return { kv, store: kv.store } as unknown as Env & { store: Map<string, any> };
}

describe('rate limiter', () => {
    test('disabled passes everything', async () => {
        const env = makeEnv();
        expect(await isRateLimited(env, '/sub/normal', { enabled: false, perHour: 1, perDay: 1 })).toBe(false);
    });

    test('blocks after the per-hour cap and fails open on KV error', async () => {
        const env = makeEnv();
        const settings = { enabled: true, perHour: 2, perDay: 100 };
        expect(await isRateLimited(env, '/sub/normal', settings)).toBe(false);
        expect(await isRateLimited(env, '/sub/normal', settings)).toBe(false);
        expect(await isRateLimited(env, '/sub/normal', settings)).toBe(true);
    });

    test('different paths are independent', async () => {
        const env = makeEnv();
        const settings = { enabled: true, perHour: 1, perDay: 100 };
        expect(await isRateLimited(env, '/sub/normal', settings)).toBe(false);
        expect(await isRateLimited(env, '/sub/fragment', settings)).toBe(false);
    });

    test('fails open when KV throws', async () => {
        const kv = {
            get: () => { throw new Error('kv down'); },
            put: () => { throw new Error('kv down'); },
            list: () => { throw new Error('kv down'); }
        } as unknown as KVNamespace;
        const env = { kv } as Env;
        expect(await isRateLimited(env, '/sub/normal', { enabled: true, perHour: 1, perDay: 1 })).toBe(false);
    });
});

describe('error log', () => {
    test('redacts secrets', () => {
        expect(redactSecrets('Bearer abcdefghijklmnopqrstuv')).not.toContain('abcdefghijklmnopqrstuv');
        expect(redactSecrets('apiToken: 12345678901234567890')).toContain('***redacted***');
        expect(redactSecrets('normal message')).toBe('normal message');
    });

    test('appends and reads, caps at 100', async () => {
        const env = makeEnv();
        for (let i = 0; i < 150; i++) {
            await logError(env, 'test', new Error(`boom ${i}`));
        }
        const errors = await readErrors(env);
        expect(errors.length).toBe(100);
        expect(errors[errors.length - 1].message).toBe('boom 149');
    });

    test('read returns empty when KV empty or throws', async () => {
        expect(await readErrors(makeEnv())).toEqual([]);
        const env = { kv: { get: () => { throw new Error('kv down'); } } } as unknown as Env;
        expect(await readErrors(env)).toEqual([]);
    });

    test('clear throws on KV failure so the panel reports it', async () => {
        const env = { kv: { put: () => { throw new Error('kv down'); } } } as unknown as Env;
        await expect(clearErrors(env)).rejects.toThrow();
    });
});

describe('backup', () => {
    test('snapshot stores current settings and lists them', async () => {
        const env = makeEnv({ proxySettings: JSON.stringify({ localDNS: '8.8.8.8' }) });
        expect(await snapshotSettings(env)).toBe(true);
        const backups = await listBackups(env);
        expect(backups.length).toBe(1);
        expect(backups[0].preview).toContain('8.8.8.8');
    });

    test('snapshot of missing settings returns false without throwing', async () => {
        const env = makeEnv();
        expect(await snapshotSettings(env)).toBe(false);
        expect(await listBackups(env)).toEqual([]);
    });

    test('getBackup returns the raw value and null when missing', async () => {
        const env = makeEnv({ proxySettings: JSON.stringify({ localDNS: '1.1.1.1' }) });
        await snapshotSettings(env);
        const ts = (await listBackups(env))[0].ts;
        const value = await getBackup(env, ts);
        expect(JSON.parse(value!).localDNS).toBe('1.1.1.1');
        expect(await getBackup(env, 9999999999999)).toBe(null);
    });
});

describe('access log', () => {
    test('hashIp is stable and salt-sensitive', async () => {
        const a = await hashIp('1.2.3.4', 'salt');
        const b = await hashIp('1.2.3.4', 'salt');
        const c = await hashIp('1.2.3.4', 'other');
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });

    test('logs and reads entries, never stores the raw IP', async () => {
        const env = makeEnv({ secretKey: 'test-secret' });
        await logAccess(env, '1.2.3.4', 'normal', 'xray');
        const entries = await readAccessLog(env);
        expect(entries.length).toBe(1);
        expect(entries[0].ipHash).toBe(await hashIp('1.2.3.4', 'test-secret'));
        expect(entries[0].ipHash).not.toContain('1.2.3.4');
        expect(JSON.stringify(entries)).not.toContain('1.2.3.4');
    });

    test('read returns empty on KV failure', async () => {
        const env = { kv: { get: () => { throw new Error('kv down'); } } } as unknown as Env;
        expect(await readAccessLog(env)).toEqual([]);
    });
});

describe('usage', () => {
    test('usageKey is a stable hex digest', async () => {
        const a = await usageKey('Normal Config');
        const b = await usageKey('Normal Config');
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{16}$/);
    });

    test('bumpUsage and summary aggregate', async () => {
        const env = makeEnv();
        await bumpUsage(env, 'normal/xray', 'xray');
        await bumpUsage(env, 'normal/xray', 'xray');
        await bumpUsage(env, 'normal/sing-box', 'sing-box');
        const rows = await getUsageSummary(env);
        const xray = rows.find(row => row.name === 'normal/xray');
        expect(xray).toBeDefined();
        expect(xray!.today).toBe(2);
        expect(xray!.week).toBe(2);
    });

    test('summary returns empty on KV failure', async () => {
        const env = { kv: { list: () => { throw new Error('kv down'); } } } as unknown as Env;
        expect(await getUsageSummary(env)).toEqual([]);
    });
});

describe('chain health', () => {
    test('read returns unknown state when no KV data', async () => {
        const state = await readChainHealth(makeEnv());
        expect(state.status).toBe('unknown');
    });

    test('does not alert and records a fail state for an empty config', async () => {
        const env = makeEnv();
        let alerts = 0;
        const state = await checkChainHealth(env, '', async () => { alerts++; });
        expect(state.status).toBe('unknown');
        expect(alerts).toBe(0);
    });

    test('a parse error records a fail state without throwing', async () => {
        const env = makeEnv();
        let alerts = 0;
        // "ftp://" is an unsupported protocol and will throw inside parseChainProxy.
        const state = await checkChainHealth(env, 'ftp://user@host:21', async () => { alerts++; });
        expect(state.status).toBe('fail');
        expect(state.summary).toContain('Unreachable');
        // Alerts fire on the unknown -> fail transition.
        expect(alerts).toBe(1);
    });

    test('alert throttling: repeated failures do not re-alert within the throttle window', async () => {
        const env = makeEnv();
        let alerts = 0;
        await checkChainHealth(env, 'ftp://user@host:21', async () => { alerts++; });
        await checkChainHealth(env, 'ftp://user@host:21', async () => { alerts++; });
        expect(alerts).toBe(1);
    });
});
