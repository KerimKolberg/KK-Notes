/**
 * Apple's framed LZ4, which GoodNotes wraps some payloads in.
 *
 * Not the LZ4 frame format from lz4.org — Apple's own, the one that comes out
 * of `compression_encode_buffer` with `COMPRESSION_LZ4`. A stream is a run of
 * blocks, each introduced by a four-byte magic:
 *
 * | magic  | then |
 * | ------ | ---- |
 * | `bv41` | u32 decompressed size, u32 compressed size, then an LZ4 *block* |
 * | `bv4-` | u32 size, then that many raw bytes |
 * | `bv4$` | nothing; the stream ends here |
 *
 * The payload of a `bv41` block is a bare LZ4 block: sequences of literals and
 * back-references, with no frame header, no block checksum and no end marker
 * beyond running out of input.
 *
 * The one thing worth saying about the decoder is that a match may overlap the
 * output it is copying from — an offset of 1 with a length of 40 means "repeat
 * the last byte forty times", which is how LZ4 encodes runs. Copying that as a
 * block rather than byte by byte reads bytes that have not been written yet,
 * and produces output that is subtly wrong rather than obviously broken.
 */

export class Lz4Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Lz4Error';
  }
}

const MAGIC_COMPRESSED = 'bv41';
const MAGIC_RAW = 'bv4-';
const MAGIC_END = 'bv4$';

/** LZ4's minimum match length: the stored length has 4 subtracted from it. */
const MIN_MATCH = 4;

function magicAt(bytes: Uint8Array, at: number): string {
  if (at + 4 > bytes.length) return '';
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/** Does this payload begin with one of Apple's block magics? */
export function isAppleLz4(bytes: Uint8Array): boolean {
  const magic = magicAt(bytes, 0);
  return magic === MAGIC_COMPRESSED || magic === MAGIC_RAW || magic === MAGIC_END;
}

/**
 * Decompress one bare LZ4 block into exactly `expectedSize` bytes.
 *
 * The size is known from the frame header, which is what makes this safe to
 * run on a hostile file: the output buffer is allocated once, and every write
 * is bounds-checked against it rather than growing on demand.
 */
export function decodeLz4Block(input: Uint8Array, expectedSize: number): Uint8Array {
  const out = new Uint8Array(expectedSize);
  let inAt = 0;
  let outAt = 0;

  /** Read the extended length that follows a nibble of 15. */
  const readLength = (start: number): number => {
    let length = start;
    for (;;) {
      if (inAt >= input.length) throw new Lz4Error('The compressed block ends inside a length.');
      const byte = input[inAt++]!;
      length += byte;
      if (byte !== 255) return length;
    }
  };

  while (inAt < input.length) {
    const token = input[inAt++]!;

    let literals = token >> 4;
    if (literals === 15) literals = readLength(15);
    if (inAt + literals > input.length) throw new Lz4Error('The compressed block ends inside its literals.');
    if (outAt + literals > expectedSize) throw new Lz4Error('The compressed block holds more than it declared.');
    out.set(input.subarray(inAt, inAt + literals), outAt);
    inAt += literals;
    outAt += literals;

    // The last sequence in a block is literals only, and simply runs out.
    if (inAt >= input.length) break;

    if (inAt + 2 > input.length) throw new Lz4Error('The compressed block ends inside a match offset.');
    const offset = input[inAt]! | (input[inAt + 1]! << 8);
    inAt += 2;
    if (offset === 0 || offset > outAt) throw new Lz4Error('The compressed block references data before its start.');

    let matched = token & 0x0f;
    if (matched === 15) matched = readLength(15);
    matched += MIN_MATCH;
    if (outAt + matched > expectedSize) throw new Lz4Error('The compressed block holds more than it declared.');

    // Byte by byte, deliberately: a match may overlap what it is copying, and
    // an offset of 1 is how LZ4 writes a run of one repeated byte.
    let from = outAt - offset;
    for (let i = 0; i < matched; i++) out[outAt++] = out[from++]!;
  }

  if (outAt !== expectedSize) {
    throw new Lz4Error(`The compressed block produced ${outAt} bytes but declared ${expectedSize}.`);
  }
  return out;
}

/**
 * Walk a whole Apple-framed stream and concatenate what it holds.
 *
 * Returns the input unchanged when it carries no frame at all, so a caller can
 * hand over a payload that may or may not be compressed without looking first.
 */
export function decodeAppleLz4(bytes: Uint8Array): Uint8Array {
  if (!isAppleLz4(bytes)) return bytes;

  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blocks: Uint8Array[] = [];
  let at = 0;

  for (;;) {
    const magic = magicAt(bytes, at);
    if (magic === MAGIC_END || magic === '') break;

    if (magic === MAGIC_RAW) {
      if (at + 8 > bytes.length) throw new Lz4Error('A raw block’s header is truncated.');
      const size = data.getUint32(at + 4, true);
      const start = at + 8;
      if (start + size > bytes.length) throw new Lz4Error('A raw block runs past the end of the stream.');
      blocks.push(bytes.subarray(start, start + size));
      at = start + size;
      continue;
    }

    if (magic !== MAGIC_COMPRESSED) {
      throw new Lz4Error(`Unexpected block magic “${magic}” in the compressed stream.`);
    }
    if (at + 12 > bytes.length) throw new Lz4Error('A compressed block’s header is truncated.');
    const decompressedSize = data.getUint32(at + 4, true);
    const compressedSize = data.getUint32(at + 8, true);
    const start = at + 12;
    if (start + compressedSize > bytes.length) throw new Lz4Error('A compressed block runs past the end of the stream.');
    blocks.push(decodeLz4Block(bytes.subarray(start, start + compressedSize), decompressedSize));
    at = start + compressedSize;
  }

  if (blocks.length === 1) return blocks[0]!;
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let outAt = 0;
  for (const block of blocks) {
    out.set(block, outAt);
    outAt += block.length;
  }
  return out;
}
