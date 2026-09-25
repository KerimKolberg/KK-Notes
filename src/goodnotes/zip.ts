/**
 * Just enough ZIP to open a `.goodnotes` archive.
 *
 * No dependency, because there does not need to be one: the container format
 * is a central directory of fixed-layout records, and the only compression a
 * real archive uses is deflate, which the platform already has as
 * `DecompressionStream('deflate-raw')` — in the Android WebView as much as in
 * a browser. A ZIP library would be 30-odd kB on the critical path for two
 * hundred lines of record reading.
 *
 * Listing is deliberately separate from reading, and synchronous. A failed
 * import needs to be able to say *what was in the archive* without inflating
 * any of it, and a notebook's pages are read one at a time rather than all at
 * once.
 */

/** ZIP record signatures, little-endian. */
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_END_LOCATOR = 0x07064b50;

/** The value a 32-bit field carries when the real one lives in a ZIP64 record. */
const ZIP64_SENTINEL = 0xffffffff;

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** Byte offset of this entry's *local* header. */
  readonly offset: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Find the end-of-central-directory record.
 *
 * It is at the end of the file, but not *at* the end: a ZIP may carry a
 * trailing comment of up to 64 kB, so the signature has to be searched for
 * backwards. Scanning from the end also means a file with the signature
 * somewhere in its data finds the real record first.
 */
function findEndRecord(bytes: Uint8Array): number {
  const data = view(bytes);
  const earliest = Math.max(0, bytes.length - (22 + 0xffff));
  for (let i = bytes.length - 22; i >= earliest; i--) {
    if (data.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) return i;
  }
  throw new ZipError('That file is not a ZIP archive (no end-of-central-directory record).');
}

/**
 * Every entry in the archive, in directory order.
 *
 * Reads the central directory rather than walking local headers: the local
 * headers can carry zeroed sizes with the real ones in a trailing data
 * descriptor, and the directory is the authority in any case.
 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length < 22) throw new ZipError('That file is too small to be a ZIP archive.');
  const data = view(bytes);
  const end = findEndRecord(bytes);

  const count = data.getUint16(end + 10, true);
  const directoryOffset = data.getUint32(end + 16, true);
  if (count === 0xffff || directoryOffset === ZIP64_SENTINEL) {
    // ZIP64 puts the real values in its own record. Nothing GoodNotes writes
    // should need it — that is 4 GB or 65 535 entries — so this says so
    // plainly rather than reading the wrong offsets and failing obscurely.
    const locator = end >= 20 ? data.getUint32(end - 20, true) : 0;
    throw new ZipError(
      locator === ZIP64_END_LOCATOR
        ? 'That archive uses ZIP64, which this importer does not read.'
        : 'That archive claims ZIP64 sizes but carries no ZIP64 record.',
    );
  }

  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length) throw new ZipError('The archive’s directory runs past the end of the file.');
    if (data.getUint32(at, true) !== CENTRAL_FILE_HEADER) {
      throw new ZipError(`The archive’s directory is damaged at entry ${i + 1}.`);
    }
    const nameLength = data.getUint16(at + 28, true);
    const extraLength = data.getUint16(at + 30, true);
    const commentLength = data.getUint16(at + 32, true);
    entries.push({
      // UTF-8 whether or not the general-purpose flag says so: the alternative
      // is CP437, and no archive this century writes names that are not ASCII
      // or UTF-8.
      name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      method: data.getUint16(at + 10, true),
      compressedSize: data.getUint32(at + 20, true),
      uncompressedSize: data.getUint32(at + 24, true),
      offset: data.getUint32(at + 42, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Inflate `bytes` with the platform's own deflate. */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('This device cannot decompress archives (no DecompressionStream).');
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * One entry's bytes.
 *
 * The local header has to be read even though the directory was: only it says
 * how long *this* entry's name and extra field are, and the data begins after
 * them. Trusting the directory's copy of those lengths is a classic way to
 * read an archive a few bytes out.
 */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const data = view(bytes);
  if (entry.offset + 30 > bytes.length || data.getUint32(entry.offset, true) !== LOCAL_FILE_HEADER) {
    throw new ZipError(`“${entry.name}” is not where the archive says it is.`);
  }
  const nameLength = data.getUint16(entry.offset + 26, true);
  const extraLength = data.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new ZipError(`“${entry.name}” runs past the end of the archive.`);

  const raw = bytes.subarray(start, end);
  if (entry.method === METHOD_STORED) return raw;
  if (entry.method === METHOD_DEFLATE) return inflateRaw(raw);
  throw new ZipError(`“${entry.name}” uses compression method ${entry.method}, which this importer does not read.`);
}

/**
 * Is this plausibly a ZIP at all? Cheap enough to ask before doing anything.
 *
 * An archive holding no files begins with its end record instead of a local
 * header, and is still a ZIP. Saying otherwise would have a caller report an
 * empty archive as the wrong kind of file rather than as an empty one.
 */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const signature = view(bytes).getUint32(0, true);
  return signature === LOCAL_FILE_HEADER || signature === END_OF_CENTRAL_DIRECTORY;
}
