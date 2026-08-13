import { describe, expect, mock, test } from 'bun:test';

// The parser is pure, but the module also imports the socket primitive. Mock it
// so importing the module never touches a real socket.
mock.module('cloudflare:sockets', () => ({
    connect: () => {
        throw new Error('socket connection should not run in parsing tests');
    }
}));

const { parseChainProxy } = await import('../src/cores/chain-test');

describe('chain proxy parsing', () => {
    test('parses socks5 with plain credentials', () => {
        expect(parseChainProxy('socks5://user:pass@proxy.example:1080')).toEqual({
            protocol: 'socks',
            server: 'proxy.example',
            port: 1080,
            user: 'user',
            pass: 'pass'
        });
    });

    test('parses socks5 with base64 credentials', () => {
        const encoded = btoa('user:pass');
        expect(parseChainProxy(`socks5://${encoded}@proxy.example:1080`)).toEqual({
            protocol: 'socks',
            server: 'proxy.example',
            port: 1080,
            user: 'user',
            pass: 'pass'
        });
    });

    test('parses socks without credentials', () => {
        expect(parseChainProxy('socks://proxy.example:1080')).toEqual({
            protocol: 'socks',
            server: 'proxy.example',
            port: 1080
        });
    });

    test('parses http proxy with credentials', () => {
        expect(parseChainProxy('http://user:pass@proxy.example:8080')).toEqual({
            protocol: 'http',
            server: 'proxy.example',
            port: 8080,
            user: 'user',
            pass: 'pass'
        });
    });

    test('parses vless and trojan with ipv4 server', () => {
        expect(parseChainProxy('vless://00000000-0000-4000-8000-000000000001@1.2.3.4:443?security=tls&type=ws')).toEqual({
            protocol: 'vless',
            server: '1.2.3.4',
            port: 443
        });
        expect(parseChainProxy('trojan://secret@example.com:443?security=tls')).toEqual({
            protocol: 'trojan',
            server: 'example.com',
            port: 443
        });
    });

    test('parses shadowsocks with base64 userinfo', () => {
        const encoded = btoa('aes-256-gcm:secret');
        expect(parseChainProxy(`ss://${encoded}@example.com:8388`)).toEqual({
            protocol: 'shadowsocks',
            server: 'example.com',
            port: 8388
        });
    });

    test('parses vmess base64 config', () => {
        const encoded = btoa(JSON.stringify({ add: 'example.com', port: 443, id: 'uuid' }));
        expect(parseChainProxy(`vmess://${encoded}`)).toEqual({
            protocol: 'vmess',
            server: 'example.com',
            port: 443
        });
    });

    test('rejects empty input', () => {
        expect(() => parseChainProxy('')).toThrow();
        expect(() => parseChainProxy('   ')).toThrow();
    });

    test('rejects unsupported protocol', () => {
        expect(() => parseChainProxy('ftp://user@host:21')).toThrow(/Unsupported/);
    });

    test('rejects missing port', () => {
        expect(() => parseChainProxy('socks5://proxy.example')).toThrow(/port/);
    });

    test('rejects out-of-range port', () => {
        expect(() => parseChainProxy('socks5://proxy.example:99999')).toThrow(/port/);
    });
});
