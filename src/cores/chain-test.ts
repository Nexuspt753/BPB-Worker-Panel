// Online test for the Chain Proxy setting.
//
// The panel cannot apply and probe a chain proxy through a real proxy client,
// so this module runs a lightweight reachability test from the Worker itself:
//   1. Parse the chain proxy config into protocol + server + port (+ credentials).
//   2. TCP-probe the proxy server (is the VPS up and reachable from Cloudflare?).
//   3. For SOCKS5 / HTTP proxies, open a real tunnel to a fixed target through
//      the proxy (can it actually relay traffic to the server behind it?).
//
// VLESS / Trojan / Shadowsocks / VMess use encrypted or app-specific handshakes
// that a Worker cannot speak, so for those the test stops at TCP reachability
// and reports that clearly rather than guessing.
//
// This module is intentionally self-contained (no `@settings` dependency) so the
// parser is unit-testable without bootstrapping the settings module graph.

import { connect } from 'cloudflare:sockets';
import { base64DecodeUtf8, safeError } from '@common';

// A Cloudflare IP: the chain proxy's job is to reach the Cloudflare edge, so a
// successful relay to this target proves the proxy can reach the server behind it.
const CHAIN_TEST_TARGET = { host: '1.1.1.1', port: 443 } as const;

const TCP_TIMEOUT_MS = 5000;
const TUNNEL_TIMEOUT_MS = 6000;

export type ChainProxyProtocol = 'socks' | 'http' | 'vless' | 'trojan' | 'shadowsocks' | 'vmess';

export interface ParsedChainProxy {
    protocol: ChainProxyProtocol;
    server: string;
    port: number;
    user?: string;
    pass?: string;
}

export interface ChainProxyTestResult {
    status: 'ok' | 'warn' | 'fail';
    protocol: string;
    server: string;
    port: number;
    tcpReachable: boolean;
    tcpLatencyMs: number | null;
    tcpError?: string;
    tunnelTested: boolean;
    tunnelOk?: boolean;
    tunnelLatencyMs?: number | null;
    tunnelError?: string;
    target?: string;
    summary: string;
}

class TimeoutError extends Error { }

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); }
        );
    });
}

function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array): number {
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

// Reads are framed against a persistent buffer: a single socket read can return
// more bytes than a protocol message needs, and those extra bytes must be kept
// for the next read rather than dropped.
class BufferedReader {
    private buffer = new Uint8Array(0);

    constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) { }

    async readExact(count: number, timeoutMs: number): Promise<Uint8Array> {
        while (this.buffer.length < count) {
            const { value, done } = await withTimeout(this.reader.read(), timeoutMs, 'timed out waiting for the proxy');
            if (done || !value) throw new Error('the proxy closed the connection unexpectedly');
            this.append(value);
        }
        const out = this.buffer.slice(0, count);
        this.buffer = this.buffer.slice(count);
        return out;
    }

    async readUntil(stop: Uint8Array, maxLength: number, timeoutMs: number): Promise<Uint8Array> {
        while (this.buffer.length < maxLength) {
            const index = indexOfSubarray(this.buffer, stop);
            if (index !== -1) {
                const out = this.buffer.slice(0, index + stop.length);
                this.buffer = this.buffer.slice(index + stop.length);
                return out;
            }
            const { value, done } = await withTimeout(this.reader.read(), timeoutMs, 'timed out waiting for the proxy');
            if (done || !value) break;
            this.append(value);
        }
        throw new Error('the proxy sent an incomplete or oversized response');
    }

    private append(value: Uint8Array): void {
        const merged = new Uint8Array(this.buffer.length + value.length);
        merged.set(this.buffer, 0);
        merged.set(value, this.buffer.length);
        this.buffer = merged;
    }

    releaseLock(): void {
        try {
            this.reader.releaseLock();
        } catch { /* already released */ }
    }
}

function parseIPv4(address: string): number[] {
    const octets = address.trim().split('.').map(Number);
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        throw new Error(`"${address}" is not a valid IPv4 address`);
    }
    return octets;
}

function decodeCredentials(rawUser: string, rawPass: string): { user?: string; pass?: string } {
    // Standard form: socks5://base64(user:pass)@server:port. Plain user:pass is
    // also accepted; only treat the username as base64 when it actually decodes
    // to a "user:pass" pair, so short plain usernames are not misread.
    if (rawUser) {
        try {
            const decoded = base64DecodeUtf8(rawUser);
            if (decoded.includes(':')) {
                const [user, ...rest] = decoded.split(':');
                return { user: user || undefined, pass: rest.join(':') || undefined };
            }
        } catch {
            // Not base64 — fall through to the plain form.
        }
    }
    return {
        user: rawUser || undefined,
        pass: rawPass || undefined
    };
}

/**
 * Parse a Chain Proxy config URL into protocol + server + port (+ credentials
 * for SOCKS/HTTP). Throws with a user-facing message when the value is empty or
 * malformed, mirroring the panel validator's accepted formats.
 */
export function parseChainProxy(chainProxy: string): ParsedChainProxy {
    const value = (chainProxy ?? '').trim();
    if (!value) throw new Error('Enter a Chain Proxy config to test.');

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Invalid Chain Proxy config. Use socks5://, http://, vless://, trojan://, ss:// or vmess:// format.');
    }

    const rawProtocol = url.protocol.slice(0, -1).toLowerCase();
    let protocol: ChainProxyProtocol;
    if (rawProtocol === 'socks' || rawProtocol === 'socks5') protocol = 'socks';
    else if (rawProtocol === 'http' || rawProtocol === 'https') protocol = 'http';
    else if (rawProtocol === 'ss' || rawProtocol === 'shadowsocks') protocol = 'shadowsocks';
    else if (rawProtocol === 'vless') protocol = 'vless';
    else if (rawProtocol === 'trojan') protocol = 'trojan';
    else if (rawProtocol === 'vmess') protocol = 'vmess';
    else throw new Error(`Unsupported Chain Proxy protocol "${rawProtocol}".`);

    let server = '';
    let port = 0;

    if (protocol === 'vmess') {
        // vmess://base64(JSON) — the config JSON lives in the host part.
        try {
            const config = JSON.parse(base64DecodeUtf8(url.host)) as { add?: string; port?: string | number };
            server = String(config.add ?? '');
            port = Number(config.port);
        } catch {
            throw new Error('Invalid vmess config. The value after vmess:// must be a valid base64 JSON object.');
        }
    } else {
        server = url.hostname;
        port = Number(url.port || 0);
    }

    if (!server) throw new Error('The Chain Proxy config is missing a server address.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('The Chain Proxy config is missing a valid port (1-65535).');
    }

    const result: ParsedChainProxy = { protocol, server, port };
    if (protocol === 'socks' || protocol === 'http') {
        const credentials = decodeCredentials(url.username, url.password);
        if (credentials.user !== undefined) result.user = credentials.user;
        if (credentials.pass !== undefined) result.pass = credentials.pass;
    }

    return result;
}

async function tcpProbe(server: string, port: number): Promise<{ ok: boolean; latencyMs: number | null; error?: string }> {
    const start = Date.now();
    let socket: ReturnType<typeof connect> | undefined;
    try {
        socket = connect({ hostname: server, port });
        await withTimeout(socket.opened, TCP_TIMEOUT_MS, 'timed out connecting to the proxy server');
        return { ok: true, latencyMs: Date.now() - start };
    } catch (error) {
        return { ok: false, latencyMs: Date.now() - start, error: safeError(error) };
    } finally {
        await socket?.close().catch(() => { });
    }
}

function socks5ReplyMessage(reply: number): string {
    switch (reply) {
        case 0x01: return 'general SOCKS server failure';
        case 0x02: return 'connection not allowed by ruleset';
        case 0x03: return 'network unreachable';
        case 0x04: return 'host unreachable';
        case 0x05: return 'connection refused';
        case 0x06: return 'TTL expired';
        case 0x07: return 'command not supported';
        case 0x08: return 'address type not supported';
        default: return `unknown SOCKS5 reply code 0x${reply.toString(16)}`;
    }
}

async function socks5Tunnel(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    reader: BufferedReader,
    params: ParsedChainProxy,
    targetIp: number[],
    targetPort: number
): Promise<void> {
    // Greeting: offer no-auth and (if credentials present) username/password.
    const methods = params.user || params.pass ? [0x00, 0x02] : [0x00];
    await writer.write(new Uint8Array([0x05, methods.length, ...methods]));

    const [version, method] = await reader.readExact(2, TUNNEL_TIMEOUT_MS);
    if (version !== 0x05) throw new Error('the proxy returned an invalid SOCKS5 version');

    if (method === 0x02) {
        const userBytes = new TextEncoder().encode(params.user ?? '');
        const passBytes = new TextEncoder().encode(params.pass ?? '');
        if (userBytes.length > 255 || passBytes.length > 255) {
            throw new Error('SOCKS5 credentials are too long');
        }
        await writer.write(new Uint8Array([0x01, userBytes.length, ...userBytes, passBytes.length, ...passBytes]));
        const [authVersion, status] = await reader.readExact(2, TUNNEL_TIMEOUT_MS);
        if (authVersion !== 0x01 || status !== 0x00) throw new Error('SOCKS5 authentication failed');
    } else if (method === 0xff) {
        throw new Error('the proxy rejected every authentication method');
    } else if (method !== 0x00) {
        throw new Error(`the proxy chose an unsupported authentication method`);
    }

    // CONNECT to the target (IPv4 address).
    await writer.write(new Uint8Array([0x05, 0x01, 0x00, 0x01, ...targetIp, targetPort >> 8, targetPort & 0xff]));

    const head = await reader.readExact(4, TUNNEL_TIMEOUT_MS);
    const [replyVersion, reply, , addressType] = head;
    if (replyVersion !== 0x05) throw new Error('the proxy returned an invalid SOCKS5 reply');

    // Skip the bound address so the read cursor stays aligned for the caller.
    let addressLength: number;
    if (addressType === 0x01) addressLength = 4;
    else if (addressType === 0x04) addressLength = 16;
    else if (addressType === 0x03) {
        const [domainLength] = await reader.readExact(1, TUNNEL_TIMEOUT_MS);
        addressLength = domainLength;
    } else {
        throw new Error('the proxy returned an unsupported address type');
    }
    await reader.readExact(addressLength + 2, TUNNEL_TIMEOUT_MS);

    if (reply !== 0x00) throw new Error(`the proxy could not reach the target (${socks5ReplyMessage(reply)})`);
}

async function httpTunnel(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    reader: BufferedReader,
    params: ParsedChainProxy,
    targetHost: string,
    targetPort: number
): Promise<void> {
    const hostPort = `${targetHost}:${targetPort}`;
    let request = `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n`;
    if (params.user || params.pass) {
        request += `Proxy-Authorization: Basic ${btoa(`${params.user ?? ''}:${params.pass ?? ''}`)}\r\n`;
    }
    request += '\r\n';
    await writer.write(new TextEncoder().encode(request));

    const response = await reader.readUntil(new TextEncoder().encode('\r\n\r\n'), 8192, TUNNEL_TIMEOUT_MS);
    const text = new TextDecoder().decode(response);
    const statusLine = text.split('\r\n')[0] ?? '';
    const status = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)?.[1] ?? 0);

    if (status === 200) return;
    if (status >= 400) throw new Error(`the proxy rejected the tunnel (HTTP ${status})`);
    throw new Error(`the proxy returned an unexpected response (${statusLine || 'empty'})`);
}

async function openTunnel(
    params: ParsedChainProxy,
    targetHost: string,
    targetPort: number
): Promise<{ ok: boolean; latencyMs: number | null; error?: string }> {
    const start = Date.now();
    let socket: ReturnType<typeof connect> | undefined;
    try {
        socket = connect({ hostname: params.server, port: params.port });
        await withTimeout(socket.opened, TUNNEL_TIMEOUT_MS, 'timed out connecting to the proxy server');

        const writer = socket.writable.getWriter();
        const reader = new BufferedReader(socket.readable.getReader());
        try {
            if (params.protocol === 'socks') {
                await socks5Tunnel(writer, reader, params, parseIPv4(targetHost), targetPort);
            } else {
                await httpTunnel(writer, reader, params, targetHost, targetPort);
            }
        } finally {
            writer.releaseLock();
            reader.releaseLock();
        }

        return { ok: true, latencyMs: Date.now() - start };
    } catch (error) {
        return { ok: false, latencyMs: Date.now() - start, error: safeError(error) };
    } finally {
        await socket?.close().catch(() => { });
    }
}

function protocolLabel(protocol: ChainProxyProtocol): string {
    switch (protocol) {
        case 'socks': return 'SOCKS5';
        case 'http': return 'HTTP';
        case 'vless': return 'VLESS';
        case 'trojan': return 'Trojan';
        case 'shadowsocks': return 'Shadowsocks';
        case 'vmess': return 'VMess';
    }
}

/**
 * Run the full online chain proxy test: parse, TCP-probe the VPS, and (for
 * SOCKS/HTTP) verify the proxy actually relays to a fixed Cloudflare target.
 */
export async function testChainProxy(chainProxy: string): Promise<ChainProxyTestResult> {
    const parsed = parseChainProxy(chainProxy);
    const tcp = await tcpProbe(parsed.server, parsed.port);

    let tunnel: { tested: boolean; ok?: boolean; latencyMs?: number | null; error?: string } = { tested: false };
    if (tcp.ok && (parsed.protocol === 'socks' || parsed.protocol === 'http')) {
        const result = await openTunnel(parsed, CHAIN_TEST_TARGET.host, CHAIN_TEST_TARGET.port);
        tunnel = { tested: true, ok: result.ok, latencyMs: result.latencyMs, error: result.error };
    }

    const status: ChainProxyTestResult['status'] = !tcp.ok
        ? 'fail'
        : tunnel.tested && tunnel.ok
            ? 'ok'
            : 'warn';

    const target = `${CHAIN_TEST_TARGET.host}:${CHAIN_TEST_TARGET.port}`;
    let summary: string;
    if (!tcp.ok) {
        summary = `Unreachable: the panel could not connect to ${parsed.server}:${parsed.port}.`;
    } else if (tunnel.tested && tunnel.ok) {
        summary = `Working: the proxy is reachable and relayed a connection to ${target}.`;
    } else if (tunnel.tested && !tunnel.ok) {
        summary = `Reachable, but the proxy could not relay to ${target}.`;
    } else {
        summary = `Reachable: the VPS answered, but ${protocolLabel(parsed.protocol)} relay cannot be verified from the panel.`;
    }

    return {
        status,
        protocol: protocolLabel(parsed.protocol),
        server: parsed.server,
        port: parsed.port,
        tcpReachable: tcp.ok,
        tcpLatencyMs: tcp.latencyMs,
        tcpError: tcp.error,
        tunnelTested: tunnel.tested,
        tunnelOk: tunnel.ok,
        tunnelLatencyMs: tunnel.latencyMs,
        tunnelError: tunnel.error,
        target: tunnel.tested ? target : undefined,
        summary
    };
}
