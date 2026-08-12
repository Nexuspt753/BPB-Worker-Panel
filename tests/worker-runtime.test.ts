import { describe, expect, mock, test } from 'bun:test';

mock.module('cloudflare:sockets', () => ({
    connect: () => {
        throw new Error('socket connection should not run in hash tests');
    }
}));
Object.assign(globalThis, { VERSION: 'test' });

const { sha224Hex } = await import('../src/protocols/trojan');

describe('Cloudflare Worker crypto compatibility', () => {
    test('matches SHA-224 vectors without Node crypto', () => {
        expect(sha224Hex('')).toBe('d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f');
        expect(sha224Hex('abc')).toBe('23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7');
        expect(sha224Hex('pässwörd')).toBe('1fa1dc9715a45491364693be5cfc25e1e8478204b8b4ef6deee9d3b3');
    });

    test('generates Warp registration keys through Web Crypto', async () => {
        const { fetchWarpAccounts } = await import('../src/api/warp');
        const originalFetch = globalThis.fetch;
        const originalSetTimeout = globalThis.setTimeout;
        const saved: string[] = [];
        const requestKeys: string[] = [];

        globalThis.fetch = (async (_input, init) => {
            const body = JSON.parse(String(init?.body));
            requestKeys.push(body.key);
            return new Response(JSON.stringify({
                config: {
                    interface: { addresses: { v6: '2606:4700:110:8fd2::1' } },
                    client_id: 'client-id',
                    peers: [{ public_key: 'peer-public-key' }]
                }
            }));
        }) as typeof fetch;
        globalThis.setTimeout = ((handler: (...args: any[]) => void) => {
            handler();
            return 0 as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout;

        try {
            const accounts = await fetchWarpAccounts({
                kv: {
                    async put(_key: string, value: string) {
                        saved.push(value);
                    }
                }
            } as unknown as Env);

            expect(accounts).toHaveLength(2);
            expect(accounts.every(account => account.privateKey.length === 44)).toBe(true);
            expect(requestKeys).toHaveLength(2);
            expect(requestKeys.every(key => key.length === 44)).toBe(true);
            expect(accounts.every(account => account.warpIPv6.endsWith('/128'))).toBe(true);
            expect(saved).toHaveLength(1);
        } finally {
            globalThis.fetch = originalFetch;
            globalThis.setTimeout = originalSetTimeout;
        }
    });
});
