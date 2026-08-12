import { describe, expect, mock, test } from 'bun:test';

mock.module('cloudflare:sockets', () => ({
    connect: () => {
        throw new Error('socket probe should not run in utility tests');
    }
}));
Object.assign(globalThis, { VERSION: 'test' });

const { concatIf, isDomain, omitEmpty } = await import('../src/cores/utils');

describe('technical report fixes', () => {
    test('uses standalone collection helpers without changing the input when disabled', () => {
        const source = ['a'];
        expect(concatIf(source, false, 'b')).toBe(source);
        expect(concatIf(source, true, ['b', 'c'])).toEqual(['a', 'b', 'c']);
        expect(concatIf(source, true, 'b')).toEqual(['a', 'b']);
        expect(omitEmpty({})).toBeUndefined();

        const value = { enabled: true };
        expect(omitEmpty(value)).toBe(value);
    });

    test('accepts ASCII, punycode, and Unicode internationalized domains', () => {
        expect(isDomain('example.com')).toBe(true);
        expect(isDomain('xn--mnchen-3ya.de')).toBe(true);
        expect(isDomain('münchen.de')).toBe(true);
        expect(isDomain('例子.中国')).toBe(true);
        expect(isDomain('localhost')).toBe(false);
        expect(isDomain('example')).toBe(false);
        expect(isDomain('example..com')).toBe(false);
    });
});
