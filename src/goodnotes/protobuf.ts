/**
 * Protobuf, read by wire format alone.
 *
 * GoodNotes publishes no `.proto` files, so there is no schema to decode
 * against and no field means anything by name. What protobuf *does* guarantee
 * is that a message can be walked without one: every field is a varint tag
 * carrying a field number and a wire type, and the wire type says how long the
 * value is. That is enough to turn an opaque payload into a tree.
 *
 * Which is the whole strategy. Rather than guessing that stroke points live in
 * field 7 — a guess that would be wrong the moment GoodNotes renumbers
 * anything — the importer walks the tree and looks for values whose *shape*
 * says what they are: a packed run of float32s in a plausible coordinate
 * range. Field numbers never enter into it.
 *
 * Length-delimited fields are genuinely ambiguous on the wire: the same bytes
 * could be a nested message, a string, or packed numbers. So this keeps the
 * raw bytes and *offers* the readings, rather than committing to one.
 */

export class ProtobufError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtobufError';
  }
}

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH = 2;
export const WIRE_GROUP_START = 3;
export const WIRE_GROUP_END = 4;
export const WIRE_FIXED32 = 5;

export interface VarintField {
  readonly field: number;
  readonly wire: typeof WIRE_VARINT;
  /** Kept as a bigint: a varint may be 64 bits, which a number cannot hold exactly. */
  readonly value: bigint;
}

export interface Fixed32Field {
  readonly field: number;
  readonly wire: typeof WIRE_FIXED32;
  readonly uint: number;
  readonly float: number;
}

export interface Fixed64Field {
  readonly field: number;
  readonly wire: typeof WIRE_FIXED64;
  readonly uint: bigint;
  readonly double: number;
}

export interface LengthField {
  readonly field: number;
  readonly wire: typeof WIRE_LENGTH;
  readonly bytes: Uint8Array;
}

export interface GroupField {
  readonly field: number;
  readonly wire: typeof WIRE_GROUP_START;
  readonly fields: readonly PbField[];
}

export type PbField = VarintField | Fixed32Field | Fixed64Field | LengthField | GroupField;

/** How deep a nested message may go before it is treated as hostile. */
const MAX_DEPTH = 24;

interface Cursor {
  at: number;
}

function readVarint(bytes: Uint8Array, cursor: Cursor): bigint {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (cursor.at >= bytes.length) throw new ProtobufError('The message ends inside a varint.');
    // A varint is at most ten bytes; more than that is not a varint.
    if (shift > 63n) throw new ProtobufError('A varint is longer than 64 bits.');
    const byte = bytes[cursor.at++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7n;
  }
}

/**
 * Read one message's fields.
 *
 * Stops at a group-end tag so nested groups terminate, and throws rather than
 * returning a partial read on anything malformed — a file that does not parse
 * cleanly is one whose contents cannot be trusted to mean anything.
 */
export function decodeMessage(bytes: Uint8Array, depth = 0): PbField[] {
  if (depth > MAX_DEPTH) throw new ProtobufError('The message nests too deeply.');
  const cursor: Cursor = { at: 0 };
  return readFields(bytes, cursor, depth);
}

function readFields(bytes: Uint8Array, cursor: Cursor, depth: number): PbField[] {
  const out: PbField[] = [];
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (cursor.at < bytes.length) {
    const tag = readVarint(bytes, cursor);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field === 0) throw new ProtobufError('Field number 0 is not legal.');

    switch (wire) {
      case WIRE_VARINT:
        out.push({ field, wire: WIRE_VARINT, value: readVarint(bytes, cursor) });
        break;

      case WIRE_FIXED64: {
        if (cursor.at + 8 > bytes.length) throw new ProtobufError('The message ends inside a 64-bit value.');
        out.push({
          field,
          wire: WIRE_FIXED64,
          uint: data.getBigUint64(cursor.at, true),
          double: data.getFloat64(cursor.at, true),
        });
        cursor.at += 8;
        break;
      }

      case WIRE_LENGTH: {
        const length = Number(readVarint(bytes, cursor));
        if (length < 0 || cursor.at + length > bytes.length) {
          throw new ProtobufError('A length-delimited field runs past the end of the message.');
        }
        out.push({ field, wire: WIRE_LENGTH, bytes: bytes.subarray(cursor.at, cursor.at + length) });
        cursor.at += length;
        break;
      }

      case WIRE_GROUP_START: {
        // Deprecated, but still legal, and Apple's tooling has been known to
        // emit it. A group ends at a matching end tag rather than by length.
        if (depth > MAX_DEPTH) throw new ProtobufError('The message nests too deeply.');
        const fields = readFields(bytes, cursor, depth + 1);
        out.push({ field, wire: WIRE_GROUP_START, fields });
        break;
      }

      case WIRE_GROUP_END:
        return out;

      case WIRE_FIXED32: {
        if (cursor.at + 4 > bytes.length) throw new ProtobufError('The message ends inside a 32-bit value.');
        out.push({
          field,
          wire: WIRE_FIXED32,
          uint: data.getUint32(cursor.at, true),
          float: data.getFloat32(cursor.at, true),
        });
        cursor.at += 4;
        break;
      }

      default:
        throw new ProtobufError(`Wire type ${wire} is not a protobuf wire type.`);
    }
  }
  return out;
}

/**
 * Could these bytes be a nested message?
 *
 * Asked rather than assumed, because a length-delimited field is ambiguous on
 * the wire: a string of the right shape parses perfectly well as a message.
 * The answer is only ever "worth trying".
 */
export function parsesAsMessage(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  try {
    const fields = decodeMessage(bytes);
    return fields.length > 0;
  } catch {
    return false;
  }
}

/** A packed run of little-endian float32s, or `null` if the length is wrong for one. */
export function asFloat32Array(bytes: Uint8Array): Float32Array | null {
  if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
  const out = new Float32Array(bytes.length / 4);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = data.getFloat32(i * 4, true);
  return out;
}

/**
 * Walk every message in a tree, including nested ones, depth first.
 *
 * A length-delimited field is tried as a message and descended into when it
 * parses. That will sometimes descend into a string that happens to look like
 * one — which is harmless here, because the consumer is looking for a specific
 * numeric shape and a false message yields nothing that matches it.
 */
export function* walkMessages(fields: readonly PbField[], depth = 0): Generator<readonly PbField[]> {
  yield fields;
  if (depth > MAX_DEPTH) return;
  for (const field of fields) {
    if (field.wire === WIRE_GROUP_START) {
      yield* walkMessages(field.fields, depth + 1);
      continue;
    }
    if (field.wire !== WIRE_LENGTH) continue;
    let nested: PbField[] | null = null;
    try {
      nested = decodeMessage(field.bytes, depth + 1);
    } catch {
      nested = null;
    }
    if (nested && nested.length > 0) yield* walkMessages(nested, depth + 1);
  }
}
