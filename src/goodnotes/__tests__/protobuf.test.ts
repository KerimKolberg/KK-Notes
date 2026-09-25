import { describe, expect, it } from 'vitest';
import {
  ProtobufError,
  WIRE_FIXED32,
  WIRE_FIXED64,
  WIRE_GROUP_START,
  WIRE_LENGTH,
  WIRE_VARINT,
  asFloat32Array,
  decodeMessage,
  parsesAsMessage,
  walkMessages,
} from '../protobuf';

/**
 * Protobuf, tested against messages written by hand.
 *
 * The wire format is the one part of this importer that *is* documented and
 * stable, so the vectors below are it: a tag is `field << 3 | wire`, a varint is
 * seven bits a byte with the top bit meaning "more", and the length-delimited
 * ones carry their own length. There is no schema anywhere in here, on purpose —
 * that is the property being tested.
 */

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const tag = (field: number, wire: number): number => (field << 3) | wire;

/** A varint, as a list of bytes. */
function varint(value: number | bigint): number[] {
  let n = BigInt(value);
  const out: number[] = [];
  for (;;) {
    const byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n === 0n) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

const varintField = (field: number, value: number | bigint): number[] => [
  ...varint(tag(field, WIRE_VARINT)),
  ...varint(value),
];

const lengthField = (field: number, body: Uint8Array | number[]): number[] => [
  ...varint(tag(field, WIRE_LENGTH)),
  ...varint(body.length),
  ...body,
];

function fixed32Field(field: number, write: (view: DataView) => void): number[] {
  const buffer = new ArrayBuffer(4);
  write(new DataView(buffer));
  return [...varint(tag(field, WIRE_FIXED32)), ...new Uint8Array(buffer)];
}

function fixed64Field(field: number, write: (view: DataView) => void): number[] {
  const buffer = new ArrayBuffer(8);
  write(new DataView(buffer));
  return [...varint(tag(field, WIRE_FIXED64)), ...new Uint8Array(buffer)];
}

/** Little-endian float32s, packed the way a repeated float field is. */
function packedFloats(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return out;
}

describe('reading a message', () => {
  it('splits a tag into a field number and a wire type', () => {
    const fields = decodeMessage(bytes(...varintField(1, 7), ...varintField(300, 1)));
    expect(fields).toEqual([
      { field: 1, wire: WIRE_VARINT, value: 7n },
      // Field 300 needs a two-byte tag, which is the point of reading it as a
      // varint rather than a byte.
      { field: 300, wire: WIRE_VARINT, value: 1n },
    ]);
  });

  it('keeps a varint as a bigint so 64 bits survive', () => {
    // A timestamp in nanoseconds is already past what a number holds exactly.
    const big = 18446744073709551615n; // 2^64 - 1
    const [field] = decodeMessage(bytes(...varintField(4, big)));
    expect(field).toEqual({ field: 4, wire: WIRE_VARINT, value: big });
    // The lossy reading, for contrast: a double has no bit left for the last
    // count and rounds this one up to 2^64.
    expect(BigInt(Number(big))).not.toBe(big);
    expect(BigInt(Number(big))).toBe(big + 1n);
  });

  it('reads a fixed32 as both an integer and a float', () => {
    // The wire does not say which it is, so both readings are offered and the
    // caller decides from context.
    const [field] = decodeMessage(bytes(...fixed32Field(2, (v) => v.setFloat32(0, 0.5, true))));
    expect(field).toMatchObject({ field: 2, wire: WIRE_FIXED32, float: 0.5 });
    expect((field as { uint: number }).uint).toBe(0x3f000000);
  });

  it('reads a fixed64 as both an integer and a double', () => {
    const [field] = decodeMessage(bytes(...fixed64Field(3, (v) => v.setFloat64(0, -12.25, true))));
    expect(field).toMatchObject({ field: 3, wire: WIRE_FIXED64, double: -12.25 });
    expect((field as { uint: bigint }).uint).toBe(0xc028800000000000n);
  });

  it('keeps a length-delimited field as raw bytes and nothing more', () => {
    // Deciding here whether this is a string, a message or packed floats would
    // be a guess; the bytes are kept so the caller can try each.
    const [field] = decodeMessage(bytes(...lengthField(5, utf8('Week 1'))));
    expect(field!.wire).toBe(WIRE_LENGTH);
    expect(new TextDecoder().decode((field as { bytes: Uint8Array }).bytes)).toBe('Week 1');
  });

  it('reads an empty length-delimited field', () => {
    const [field] = decodeMessage(bytes(...lengthField(5, [])));
    expect((field as { bytes: Uint8Array }).bytes.length).toBe(0);
  });

  it('decodes an empty message to no fields', () => {
    expect(decodeMessage(new Uint8Array(0))).toEqual([]);
  });

  it('reads repeated occurrences of one field as several fields', () => {
    // Protobuf has no notion of a repeated field on the wire; it is just the
    // same tag more than once.
    const fields = decodeMessage(bytes(...varintField(1, 10), ...varintField(1, 20), ...varintField(1, 30)));
    expect(fields.map((f) => (f as { value: bigint }).value)).toEqual([10n, 20n, 30n]);
  });
});

describe('groups, which are deprecated but still legal', () => {
  it('reads a group as a nested message that ends at its end tag', () => {
    const body = [...varintField(1, 5), ...lengthField(2, utf8('in'))];
    const message = bytes(
      ...varint(tag(9, WIRE_GROUP_START)),
      ...body,
      ...varint(tag(9, 4)),
      ...varintField(10, 1),
    );
    const fields = decodeMessage(message);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ field: 9, wire: WIRE_GROUP_START });
    expect((fields[0] as { fields: readonly unknown[] }).fields).toHaveLength(2);
    // The field after the group is still read, which is what proves the group
    // stopped where it should.
    expect(fields[1]).toEqual({ field: 10, wire: WIRE_VARINT, value: 1n });
  });

  it('reads an empty group', () => {
    const message = bytes(...varint(tag(3, WIRE_GROUP_START)), ...varint(tag(3, 4)));
    expect((decodeMessage(message)[0] as { fields: readonly unknown[] }).fields).toEqual([]);
  });
});

describe('a damaged or hostile message', () => {
  it('refuses a truncated varint', () => {
    expect(() => decodeMessage(bytes(0x08, 0x80))).toThrow(/ends inside a varint/);
    expect(() => decodeMessage(bytes(0x80))).toThrow(/ends inside a varint/);
  });

  it('refuses a varint longer than 64 bits', () => {
    // Eleven continuation bytes: not a varint, however it got there.
    expect(() => decodeMessage(bytes(0x08, ...new Array(12).fill(0xff), 0x00))).toThrow(/longer than 64 bits/);
  });

  it('refuses a truncated fixed-width value', () => {
    expect(() => decodeMessage(bytes(tag(1, WIRE_FIXED32), 1, 2, 3))).toThrow(/ends inside a 32-bit value/);
    expect(() => decodeMessage(bytes(tag(1, WIRE_FIXED64), 1, 2, 3, 4, 5, 6, 7))).toThrow(/ends inside a 64-bit value/);
  });

  it('refuses a length that runs past the end', () => {
    expect(() => decodeMessage(bytes(tag(1, WIRE_LENGTH), 40, 1, 2, 3))).toThrow(/runs past the end/);
  });

  it('refuses field number 0', () => {
    // Tag 0 is also what a run of padding zeroes looks like, so this is the
    // check that stops zero-filled bytes parsing as an endless message.
    expect(() => decodeMessage(bytes(0x00, 0x00))).toThrow(/Field number 0/);
  });

  it('names the wire types that do not exist', () => {
    expect(() => decodeMessage(bytes(tag(1, 6), 0))).toThrow(/Wire type 6/);
    expect(() => decodeMessage(bytes(tag(1, 7), 0))).toThrow(/Wire type 7/);
  });

  it('throws a ProtobufError rather than a bare Error', () => {
    // The importer distinguishes "this file is not what I thought" from a bug.
    expect(() => decodeMessage(bytes(0x08, 0x80))).toThrow(ProtobufError);
  });

  it('refuses a message nested past the depth limit', () => {
    // A file can nest length-delimited fields as deeply as it likes for free,
    // which is a cheap way to exhaust the stack.
    let body = bytes(...varintField(1, 1));
    for (let i = 0; i < 40; i++) body = bytes(...lengthField(1, body));
    // The outer decode is shallow, so it succeeds; walking is where depth bites.
    expect(() => decodeMessage(body, 30)).toThrow(/nests too deeply/);
    expect([...walkMessages(decodeMessage(body))].length).toBeLessThan(40);
  });
});

describe('parsesAsMessage', () => {
  it('says yes to something that parses', () => {
    expect(parsesAsMessage(bytes(...varintField(1, 1)))).toBe(true);
  });

  it('says no to empty bytes and to bytes that do not parse', () => {
    expect(parsesAsMessage(new Uint8Array(0))).toBe(false);
    expect(parsesAsMessage(bytes(0x08, 0x80))).toBe(false);
    expect(parsesAsMessage(bytes(0x00))).toBe(false);
  });

  it('is only ever “worth trying”, because a string can parse too', () => {
    // 'H' is 0x48: field 9, wire type 0, so this ASCII text is a valid message.
    // The answer being wrong here is why the consumer looks for a numeric shape
    // rather than trusting the structure it walks into.
    expect(parsesAsMessage(utf8('H\u0001'))).toBe(true);
  });
});

describe('asFloat32Array', () => {
  it('reads a packed run of little-endian floats', () => {
    const floats = asFloat32Array(packedFloats([0, 1.5, -2.25, 1024]));
    expect(floats).not.toBeNull();
    expect([...floats!]).toEqual([0, 1.5, -2.25, 1024]);
  });

  it('returns null when the length cannot be a run of float32s', () => {
    expect(asFloat32Array(bytes(1, 2, 3))).toBeNull();
    expect(asFloat32Array(bytes(1, 2, 3, 4, 5))).toBeNull();
    expect(asFloat32Array(new Uint8Array(0))).toBeNull();
  });

  it('reads from a subarray at an unaligned offset', () => {
    // Fields come out of decodeMessage as subarrays of the whole file, so the
    // byte offset is whatever the tag left it at — almost never a multiple of
    // four. A Float32Array view over the buffer would throw here.
    const packed = packedFloats([3.5, -7]);
    const padded = new Uint8Array(packed.length + 3);
    padded.set(packed, 3);
    expect([...asFloat32Array(padded.subarray(3))!]).toEqual([3.5, -7]);
  });

  it('reads whatever the bytes say, including values that are not coordinates', () => {
    // Filtering by plausibility is the caller's job, not this function's.
    const odd = asFloat32Array(bytes(0xff, 0xff, 0xff, 0x7f, 0x00, 0x00, 0x80, 0x7f));
    expect(Number.isNaN(odd![0])).toBe(true);
    expect(odd![1]).toBe(Infinity);
  });
});

describe('walking a tree', () => {
  it('yields the top message first, then what it nests', () => {
    const inner = bytes(...varintField(1, 42));
    const middle = bytes(...lengthField(2, inner), ...varintField(3, 1));
    const top = bytes(...lengthField(4, middle));

    const visited = [...walkMessages(decodeMessage(top))];
    expect(visited).toHaveLength(3);
    expect(visited[0]![0]!.field).toBe(4);
    expect(visited[1]!.map((f) => f.field)).toEqual([2, 3]);
    expect(visited[2]![0]).toEqual({ field: 1, wire: WIRE_VARINT, value: 42n });
  });

  it('descends into a group', () => {
    const message = bytes(
      ...varint(tag(1, WIRE_GROUP_START)),
      ...varintField(2, 9),
      ...varint(tag(1, 4)),
    );
    const visited = [...walkMessages(decodeMessage(message))];
    expect(visited).toHaveLength(2);
    expect(visited[1]![0]).toEqual({ field: 2, wire: WIRE_VARINT, value: 9n });
  });

  it('reaches a packed float array however deep it is buried', () => {
    // The shape the importer is actually hunting for, three levels down and
    // with no field number anyone has to know in advance.
    const points = packedFloats([10, 20, 11, 21, 12, 22]);
    let body = bytes(...lengthField(7, points), ...varintField(1, 3));
    for (const field of [11, 4, 2]) body = bytes(...lengthField(field, body));

    const found: Float32Array[] = [];
    for (const message of walkMessages(decodeMessage(body))) {
      for (const field of message) {
        if (field.wire !== WIRE_LENGTH) continue;
        const floats = asFloat32Array(field.bytes);
        if (floats && floats.length === 6) found.push(floats);
      }
    }
    expect(found.some((f) => [...f].join() === '10,20,11,21,12,22')).toBe(true);
  });

  it('does not stop walking because one branch is not a message', () => {
    // A sibling that is plain text must not cost the tree its other branches.
    const real = bytes(...varintField(1, 5));
    const message = bytes(...lengthField(1, utf8('ÿÿ not protobuf')), ...lengthField(2, real));
    const visited = [...walkMessages(decodeMessage(message))];
    expect(visited.some((fields) => fields.length === 1 && fields[0]!.field === 1)).toBe(true);
  });

  it('descends into a string that happens to parse, harmlessly', () => {
    // Stated as a test because it is a known and accepted consequence: a false
    // message yields no packed floats, so the consumer sees nothing.
    const message = bytes(...lengthField(1, utf8('H\u0001')));
    const visited = [...walkMessages(decodeMessage(message))];
    expect(visited).toHaveLength(2);
    expect(visited[1]![0]!.field).toBe(9);
  });

  it('stops descending at the depth limit instead of recursing forever', () => {
    let body = bytes(...varintField(1, 1));
    for (let i = 0; i < 60; i++) body = bytes(...lengthField(1, body));
    const visited = [...walkMessages(decodeMessage(body))];
    expect(visited.length).toBeGreaterThan(1);
    expect(visited.length).toBeLessThanOrEqual(26);
  });
});
