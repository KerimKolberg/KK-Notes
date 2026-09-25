import { describe, expect, it } from 'vitest';
import { Lz4Error, decodeAppleLz4, decodeLz4Block, isAppleLz4 } from '../lz4';

/**
 * LZ4 blocks, written by hand.
 *
 * There is no LZ4 encoder in this project to round-trip against, and that is
 * just as well: hand-built vectors state what the format *is* rather than
 * checking the decoder against a second implementation of the same guess. The
 * bytes below are the format's own rules applied on paper — a token whose high
 * nibble is the literal count and whose low nibble is the match length minus
 * four, a two-byte little-endian back-reference, and 255s to extend either.
 */

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

/** `bv41` + sizes + payload, then the end marker. */
function frame(payload: Uint8Array, decompressedSize: number): Uint8Array {
  const out = new Uint8Array(12 + payload.length + 4);
  out.set(utf8('bv41'), 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, decompressedSize, true);
  view.setUint32(8, payload.length, true);
  out.set(payload, 12);
  out.set(utf8('bv4$'), 12 + payload.length);
  return out;
}

/** `bv4-` + size + raw bytes, then the end marker. */
function rawFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length + 4);
  out.set(utf8('bv4-'), 0);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  out.set(utf8('bv4$'), 8 + payload.length);
  return out;
}

describe('an LZ4 block', () => {
  it('copies literals straight through', () => {
    // Token 0x50: five literals, no match. The block then runs out, which is
    // how a final literal-only sequence ends.
    const block = bytes(0x50, ...utf8('hello'));
    expect(text(decodeLz4Block(block, 5))).toBe('hello');
  });

  it('expands a back-reference', () => {
    // "abcdabcd": four literals, then a match of length 4 at offset 4.
    //   token 0x40 -> 4 literals, match nibble 0 -> length 0 + 4
    const block = bytes(0x40, ...utf8('abcd'), 0x04, 0x00);
    expect(text(decodeLz4Block(block, 8))).toBe('abcdabcd');
  });

  it('repeats a single byte when the match overlaps its own output', () => {
    // The case a block copy gets wrong. Offset 1, length 10: read the byte
    // just written, ten times, each read seeing the byte written before it.
    // A memcpy-style copy would read nine bytes that do not exist yet.
    const block = bytes(0x16, 0x41, 0x01, 0x00);
    expect(text(decodeLz4Block(block, 11))).toBe('A'.repeat(11));
  });

  it('expands a short overlapping run, where offset is less than length', () => {
    // "abababab…" from two literals and an offset of 2.
    const block = bytes(0x26, ...utf8('ab'), 0x02, 0x00);
    expect(text(decodeLz4Block(block, 12))).toBe('ab'.repeat(6));
  });

  it('reads an extended literal length', () => {
    // A literal nibble of 15 means "read more": 15 + 20 = 35 literals.
    const body = 'x'.repeat(35);
    const block = bytes(0xf0, 20, ...utf8(body));
    expect(text(decodeLz4Block(block, 35))).toBe(body);
  });

  it('reads a literal length extended past 255', () => {
    const body = 'y'.repeat(300);
    // 15 + 255 + 30 = 300. A 255 means keep reading.
    const block = bytes(0xf0, 255, 30, ...utf8(body));
    expect(text(decodeLz4Block(block, 300))).toBe(body);
  });

  it('reads an extended match length', () => {
    // One literal, then a match nibble of 15 extended by 6: 15 + 6 + 4 = 25.
    const block = bytes(0x1f, 0x5a, 0x01, 0x00, 6);
    expect(text(decodeLz4Block(block, 26))).toBe('Z'.repeat(26));
  });

  it('decodes an empty block to nothing', () => {
    expect(decodeLz4Block(bytes(), 0)).toEqual(new Uint8Array(0));
  });
});

describe('a damaged block', () => {
  it('refuses to read past its own input', () => {
    // Claims nine literals but carries three.
    expect(() => decodeLz4Block(bytes(0x90, 1, 2, 3), 9)).toThrow(/ends inside its literals/);
    expect(() => decodeLz4Block(bytes(0xf0, 255), 400)).toThrow(/ends inside a length/);
    expect(() => decodeLz4Block(bytes(0x10, 0x41, 0x01), 5)).toThrow(/ends inside a match offset/);
  });

  it('refuses a back-reference to before the start of the output', () => {
    // Offset 9 with only one byte written: a malformed or hostile block.
    expect(() => decodeLz4Block(bytes(0x10, 0x41, 0x09, 0x00), 12)).toThrow(/before its start/);
    expect(() => decodeLz4Block(bytes(0x10, 0x41, 0x00, 0x00), 12)).toThrow(/before its start/);
  });

  it('refuses to write more than the frame declared', () => {
    // The declared size is what bounds the allocation, so overrunning it is
    // the thing that must not silently work.
    expect(() => decodeLz4Block(bytes(0x50, ...utf8('hello')), 3)).toThrow(/more than it declared/);
    // Four literals then a 16-byte match: twenty bytes into a declared eight.
    expect(() => decodeLz4Block(bytes(0x4c, ...utf8('abcd'), 0x04, 0x00), 8)).toThrow(/more than it declared/);
  });

  it('refuses a block that produced less than it declared', () => {
    expect(() => decodeLz4Block(bytes(0x50, ...utf8('hello')), 40)).toThrow(/produced 5 bytes but declared 40/);
  });
});

describe('an Apple-framed stream', () => {
  it('unwraps a compressed frame', () => {
    const stream = frame(bytes(0x40, ...utf8('abcd'), 0x04, 0x00), 8);
    expect(isAppleLz4(stream)).toBe(true);
    expect(text(decodeAppleLz4(stream))).toBe('abcdabcd');
  });

  it('passes a raw frame through', () => {
    // `bv4-` is what the encoder emits when compressing would not have helped.
    expect(text(decodeAppleLz4(rawFrame(utf8('already small'))))).toBe('already small');
  });

  it('concatenates several frames', () => {
    const a = frame(bytes(0x50, ...utf8('first')), 5);
    const b = rawFrame(utf8('-second'));
    // Drop the first frame's end marker so the two run together.
    const joined = new Uint8Array(a.length - 4 + b.length);
    joined.set(a.subarray(0, a.length - 4), 0);
    joined.set(b, a.length - 4);
    expect(text(decodeAppleLz4(joined))).toBe('first-second');
  });

  it('leaves a payload that carries no frame alone', () => {
    // So a caller can hand over something that may or may not be compressed
    // without having to look first.
    const plain = utf8('{"not":"compressed"}');
    expect(decodeAppleLz4(plain)).toBe(plain);
    expect(isAppleLz4(plain)).toBe(false);
  });

  it('treats a bare end marker as an empty stream', () => {
    expect(decodeAppleLz4(utf8('bv4$'))).toEqual(new Uint8Array(0));
  });

  it('names a truncated or unknown frame rather than guessing', () => {
    expect(() => decodeAppleLz4(utf8('bv41\u0000\u0000'))).toThrow(/header is truncated/);
    const short = new Uint8Array(16);
    short.set(utf8('bv41'), 0);
    new DataView(short.buffer).setUint32(4, 100, true);
    new DataView(short.buffer).setUint32(8, 100, true);
    expect(() => decodeAppleLz4(short)).toThrow(/past the end/);

    const bogus = new Uint8Array(20);
    bogus.set(utf8('bv41'), 0);
    new DataView(bogus.buffer).setUint32(4, 1, true);
    new DataView(bogus.buffer).setUint32(8, 1, true);
    bogus[12] = 0x00; // a zero token: no literals, then a match with no offset
    expect(() => decodeAppleLz4(bogus)).toThrow(Lz4Error);
  });
});
