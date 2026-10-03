import { describe, expect, it } from 'vitest';
import { base64Ascii, decodeBase64, encodeBase64 } from '../base64';

const viaBtoa = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const random = (n: number, seed = 1): Uint8Array => {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
};

describe('base64', () => {
  it('encodes as btoa does, every length of remainder', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = random(n, n + 3);
      expect(encodeBase64(bytes)).toBe(viaBtoa(bytes));
      expect(new TextDecoder().decode(base64Ascii(bytes))).toBe(viaBtoa(bytes));
    }
  });

  it('decodes what it encodes, and what btoa wrote', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255, 1000, 4099]) {
      const bytes = random(n, n);
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
      expect(decodeBase64(viaBtoa(bytes))).toEqual(bytes);
    }
  });

  it('skips whitespace and refuses what is not base64', () => {
    expect(decodeBase64('aGVs\nbG8=')).toEqual(new TextEncoder().encode('hello'));
    expect(() => decodeBase64('aGVs*bG8=')).toThrow();
  });
});
