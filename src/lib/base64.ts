/**
 * Base64, for the bytes a note carries inside its JSON: PDFs, recordings, images.
 *
 * The engine's own `Uint8Array.prototype.toBase64` / `Uint8Array.fromBase64` where it has them (current Chromium,
 * so WebView2 and Android's WebView), and a plain table-driven version where it does not. Both are far quicker than
 * the old route through `String.fromCharCode` and `btoa`, which took seconds for a textbook-sized PDF.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ENCODE = Uint8Array.from(ALPHABET, (c) => c.charCodeAt(0));
const PAD = 0x3d; // '='
const DECODE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

interface NativeBase64 {
  toBase64?: (this: Uint8Array) => string;
}
interface NativeBase64Static {
  fromBase64?: (text: string) => Uint8Array;
}
const nativeTo = (Uint8Array.prototype as NativeBase64).toBase64;
const nativeFrom = (Uint8Array as unknown as NativeBase64Static).fromBase64;

/** The base64 of `bytes` as ASCII bytes, ready to be written out as they are. */
export function base64Ascii(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  const whole = bytes.length - (bytes.length % 3);
  let o = 0;
  for (let i = 0; i < whole; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = ENCODE[v >>> 18]!;
    out[o++] = ENCODE[(v >>> 12) & 63]!;
    out[o++] = ENCODE[(v >>> 6) & 63]!;
    out[o++] = ENCODE[v & 63]!;
  }
  const rest = bytes.length - whole;
  if (rest > 0) {
    const v = (bytes[whole]! << 16) | (rest === 2 ? bytes[whole + 1]! << 8 : 0);
    out[o++] = ENCODE[v >>> 18]!;
    out[o++] = ENCODE[(v >>> 12) & 63]!;
    out[o++] = rest === 2 ? ENCODE[(v >>> 6) & 63]! : PAD;
    out[o++] = PAD;
  }
  return out;
}

const latin1 = new TextDecoder('latin1');

/** The base64 of `bytes`. */
export function encodeBase64(bytes: Uint8Array): string {
  if (nativeTo) return nativeTo.call(bytes);
  // Base64 is ASCII, which latin-1 reads byte for byte.
  return latin1.decode(base64Ascii(bytes));
}

/** The bytes of a base64 string; whitespace is skipped, anything else not base64 is an error. */
export function decodeBase64(text: string): Uint8Array {
  if (nativeFrom) return nativeFrom(text);
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === PAD) break;
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) continue;
    const v = c < 128 ? DECODE[c]! : -1;
    if (v < 0) throw new Error('Not base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.slice(0, o);
}
