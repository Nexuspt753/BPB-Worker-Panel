import { HttpStatus, respond } from '@common';
import { SignJWT, jwtVerify } from 'jose';
import { getGlobals } from '@settings';

async function safeCompare(a: unknown, b: unknown): Promise<boolean> {
    const encode = (value: unknown): ArrayBuffer => {
        const bytes = new TextEncoder().encode(typeof value === 'string' ? value : '');
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        return buffer;
    };
    // Compare SHA-256 digests so the check runs over equal-length inputs and
    // never short-circuits on a length mismatch (timing-safe password compare).
    const [left, right] = await Promise.all([
        crypto.subtle.digest('SHA-256', encode(a)),
        crypto.subtle.digest('SHA-256', encode(b))
    ]);
    const l = new Uint8Array(left);
    const r = new Uint8Array(right);
    let diff = 0;
    for (let i = 0; i < l.length; i++) diff |= l[i] ^ r[i];
    return diff === 0;
}

export function logout(): Response {
    return respond(true, HttpStatus.OK, 'Successfully logged out!', null, {
        'Set-Cookie': 'jwtToken=; Path=/; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Content-Type': 'text/plain'
    });
}

export async function generateJWTToken(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return respond(false, HttpStatus.METHOD_NOT_ALLOWED, 'Method not allowed.');
    }

    const data = await request.json() as any;
    const savedPass = await env.kv.get('pwd');
    const { accEmail } = getGlobals();
    const username = data.username?.toLowerCase();
    if (username !== accEmail || !(await safeCompare(data.password, savedPass))) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Wrong Credentials.');
    }

    let secretKey = await env.kv.get('secretKey');
    if (!secretKey) {
        secretKey = generateSecretKey();
        await env.kv.put('secretKey', secretKey);
    }

    const secret = new TextEncoder().encode(secretKey);
    const { accID } = getGlobals();
    const jwtToken = await new SignJWT({ id: accID })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('24h')
        .sign(secret);

    return respond(true, HttpStatus.OK, 'Successfully generated Auth token', null, {
        'Set-Cookie': `jwtToken=${jwtToken}; Path=/; HttpOnly; Secure; Max-Age=${24 * 60 * 60}; SameSite=Strict`,
        'Content-Type': 'text/plain',
    });
}

function generateSecretKey(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);

    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function authenticate(request: Request, env: Env): Promise<boolean> {
    try {
        const secretKey = await env.kv.get('secretKey');
        if (secretKey === null) {
            return false;
        }

        const secret = new TextEncoder().encode(secretKey);
        const cookie = request.headers.get('Cookie')?.match(/(^|;\s*)jwtToken=([^;]*)/);
        const token = cookie ? cookie[2] : null;
        if (!token) {
            return false;
        }

        await jwtVerify(token, secret);
        return true;
    } catch (error) {
        console.error('[auth] verification failed');
        return false;
    }
}

export async function resetPassword(request: Request, env: Env): Promise<Response> {
    const auth = await authenticate(request, env);
    const oldPwd = await env.kv.get('pwd');
    if (oldPwd && !auth) {
        return respond(false, HttpStatus.UNAUTHORIZED, 'Unauthorized.');
    }

    const data = await request.json() as any;
    const { accEmail } = getGlobals();

    if (!auth && !data.username) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Missing username.');
    }

    if (data.username && data.username !== accEmail) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Wrong username.');
    }

    if (await safeCompare(data.password, oldPwd)) {
        return respond(false, HttpStatus.BAD_REQUEST, 'Please enter a new Password.');
    }

    await env.kv.put('pwd', data.password);

    return respond(true, HttpStatus.OK, 'Successfully logged in!', null, {
        'Set-Cookie': 'jwtToken=; Path=/; Secure; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Content-Type': 'text/plain',
    });
}