import { getGlobals } from '@settings';
import { handleTCPOutBound, makeReadableWebSocketStream, safeCloseTcpSocket } from '@protocols/common';

export async function TrOverWSHandler(request: Request): Promise<Response> {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    webSocket.binaryType = 'arraybuffer';

    let address = '';
    let portWithRandomLog = '';

    const log = (info: string, event?: string) => {
        console.error(`[trojan:${address}:${portWithRandomLog}] ${info}`, event || '');
    };

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

    let remoteSocketWapper: { value: any } = { value: null };
    let udpStreamWrite: any = null;

    const writableStream = new WritableStream({
        async write(chunk, _controller) {
            if (udpStreamWrite) {
                return udpStreamWrite(chunk);
            }

            if (remoteSocketWapper.value) {
                const writer = remoteSocketWapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const {
                hasError,
                message,
                portRemote = 443,
                addressRemote = '',
                rawClientData,
            } = parseTrHeader(chunk);

            address = addressRemote;
            portWithRandomLog = `${portRemote}--${Math.random()} tcp`;

            if (hasError) {
                throw new Error(message);
            }

            handleTCPOutBound(
                remoteSocketWapper,
                addressRemote,
                portRemote,
                rawClientData,
                webSocket,
                null,
                log
            );
        },
        close() {
            safeCloseTcpSocket(remoteSocketWapper.value);
        },
        abort(reason) {
            log(`readableWebSocketStream is aborted`, JSON.stringify(reason));
        }
    });

    readableWebSocketStream
        .pipeTo(writableStream)
        .catch(error => {
            log('readableWebSocketStream pipeTo error', error);
            safeCloseTcpSocket(remoteSocketWapper.value);
        });

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

export function sha224Hex(value: string): string {
    const bytes = new TextEncoder().encode(value);
    const bitLength = bytes.length * 8;
    const blockLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(blockLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;

    // SHA-224 uses the SHA-256 compression function with different initial
    // state and a seven-word output. Keep the implementation here dependency-
    // free so a standalone Worker does not need nodejs_compat for hashing.
    for (let index = 0; index < 8; index++) {
        padded[blockLength - 1 - index] = Math.floor(bitLength / 2 ** (index * 8)) & 0xff;
    }

    const hash = new Uint32Array([
        0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939,
        0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4
    ]);
    const roundConstants = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    const rotateRight = (word: number, bits: number) => (word >>> bits) | (word << (32 - bits));

    for (let offset = 0; offset < padded.length; offset += 64) {
        const words = new Uint32Array(64);
        for (let index = 0; index < 16; index++) {
            const position = offset + index * 4;
            words[index] = (
                (padded[position] << 24)
                | (padded[position + 1] << 16)
                | (padded[position + 2] << 8)
                | padded[position + 3]
            ) >>> 0;
        }
        for (let index = 16; index < 64; index++) {
            const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
            const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
            words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }

        let [a, b, c, d, e, f, g, h] = hash;
        for (let index = 0; index < 64; index++) {
            const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choose = (e & f) ^ (~e & g);
            const temp1 = (h + s1 + choose + roundConstants[index] + words[index]) >>> 0;
            const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }

        hash[0] = (hash[0] + a) >>> 0;
        hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0;
        hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0;
        hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0;
        hash[7] = (hash[7] + h) >>> 0;
    }

    return Array.from(hash.slice(0, 7), word => word.toString(16).padStart(8, '0')).join('');
}

function parseTrHeader(buffer: ArrayBuffer) {
    if (buffer.byteLength < 56) {
        return {
            hasError: true,
            message: 'invalid data',
        };
    }

    let crLfIndex = 56;
    const cr = new Uint8Array(buffer.slice(crLfIndex, crLfIndex + 1))[0];
    const lf = new Uint8Array(buffer.slice(crLfIndex + 1, crLfIndex + 2))[0];

    if (cr !== 0x0d || lf !== 0x0a) {
        return {
            hasError: true,
            message: 'invalid header format (missing CR LF)',
        };
    }

    const { trPass } = getGlobals();
    const password = new TextDecoder().decode(buffer.slice(0, crLfIndex));
    if (password !== sha224Hex(trPass)) {
        return {
            hasError: true,
            message: 'invalid password',
        };
    }

    const socks5DataBuffer = buffer.slice(crLfIndex + 2);
    if (socks5DataBuffer.byteLength < 6) {
        return {
            hasError: true,
            message: 'invalid SOCKS5 request data',
        };
    }

    const view = new DataView(socks5DataBuffer);
    const cmd = view.getUint8(0);
    if (cmd !== 1) {
        return {
            hasError: true,
            message: 'unsupported command, only TCP (CONNECT) is allowed',
        };
    }

    const atype = view.getUint8(1);
    let addressLength = 0;
    let addressIndex = 2;
    let address = '';

    switch (atype) {
        case 1:
            addressLength = 4;
            address = new Uint8Array(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength)).join('.');
            break;

        case 3:
            addressLength = new Uint8Array(socks5DataBuffer.slice(addressIndex, addressIndex + 1))[0];
            addressIndex += 1;
            address = new TextDecoder().decode(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength));
            break;

        case 4: {
            addressLength = 16;
            const dataView = new DataView(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength));
            const ipv6 = [];

            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }

            address = ipv6.join(':');
            break;
        }
        default:
            return {
                hasError: true,
                message: `invalid addressType is ${atype}`,
            };
    }

    if (!address) {
        return {
            hasError: true,
            message: `address is empty, addressType is ${atype}`,
        };
    }

    const portIndex = addressIndex + addressLength;
    const portBuffer = socks5DataBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    return {
        hasError: false,
        addressRemote: address,
        portRemote,
        rawClientData: socks5DataBuffer.slice(portIndex + 4),
    };
}
