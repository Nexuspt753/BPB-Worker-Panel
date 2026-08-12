import { WarpAccount } from '#types/settings';
interface WarpKeys {
    publicKey: string;
    privateKey: string;
}

export async function fetchWarpAccounts(env: Env): Promise<WarpAccount[]> {
    const warpAccounts: WarpAccount[] = [];

    try {

        const warpKeys = [
            await generateKeyPair(),
            await generateKeyPair()
        ];

        for (const [index, key] of warpKeys.entries()) {
            const { config } = await fetchAccount(key);
            warpAccounts.push({
                privateKey: key.privateKey,
                warpIPv6: `${config.interface.addresses.v6}/128`,
                reserved: config.client_id,
                publicKey: config.peers[0].public_key
            });

            if (index === 0) await new Promise(resolve => setTimeout(resolve, 2000));
        }

        await env.kv.put('warpAccounts', JSON.stringify(warpAccounts));
        return warpAccounts;

    } catch (error) {
        console.error(
            'Failed to fetch new WARP accounts:',
            error instanceof Error ? error.message : String(error)
        );

        throw new Error('Unable to provision unique WARP accounts.');
    }
}

async function fetchAccount(key: WarpKeys): Promise<any> {
    const response = await fetch('https://api.cloudflareclient.com/v0a4005/reg', {
        method: 'POST',
        headers: {
            'User-Agent': 'insomnia/13.0.2',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            install_id: '',
            fcm_token: '',
            tos: new Date().toISOString(),
            type: 'Android',
            model: 'PC',
            locale: 'en_US',
            warp_enabled: true,
            key: key.publicKey
        })
    });

    if (!response.ok) {
        throw new Error(`API returned status ${response.status}: ${await response.text()}`);
    }

    return response.json();
}

async function generateKeyPair(): Promise<WarpKeys> {
    // Use the Workers-native Web Crypto API instead of Node's crypto module. The
    // generated Worker is deployed as a standalone script and does not require
    // the nodejs_compat flag just to refresh Warp accounts.
    const pair = await crypto.subtle.generateKey(
        { name: 'X25519' },
        true,
        ['deriveBits']
    ) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));

    return {
        publicKey: bytesToBase64(publicKey),
        // PKCS#8 wraps the 32-byte X25519 scalar; the final 32 bytes are the
        // same raw private key used by the previous Node implementation.
        privateKey: bytesToBase64(privateKey.slice(-32))
    };
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}
