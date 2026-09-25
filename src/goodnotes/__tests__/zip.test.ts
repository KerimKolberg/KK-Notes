import { describe, expect, it } from 'vitest';
import { METHOD_DEFLATE, METHOD_STORED, ZipError, listZipEntries, looksLikeZip, readZipEntry } from '../zip';

/**
 * The ZIP reader, tested against archives built here rather than against a
 * fixture.
 *
 * Building them in the test is the point: a fixture proves one file parses,
 * while a builder lets the awkward cases be constructed deliberately — a
 * trailing comment hiding the end record, a local header whose extra field is
 * a different length from the directory's, a truncated entry. Those are the
 * ways a hand-written ZIP reader goes wrong.
 */

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface BuildEntry {
  name: string;
  body: Uint8Array;
  /** Compressed payload, when it differs from the body. */
  stored?: Uint8Array;
  method?: number;
  /** Extra field on the *local* header only, which is legal and common. */
  localExtra?: number;
}

/** Assemble a ZIP the way a real writer would. */
function buildZip(entries: BuildEntry[], options: { comment?: string } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = utf8(entry.name);
    const payload = entry.stored ?? entry.body;
    const method = entry.method ?? METHOD_STORED;
    const localExtra = entry.localExtra ?? 0;

    const local = new Uint8Array(30 + name.length + localExtra);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, entry.body.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, localExtra, true);
    local.set(name, 30);
    parts.push(local, payload);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, entry.body.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    directory.push(central);

    offset += local.length + payload.length;
  }

  const directoryBytes = directory.reduce((n, d) => n + d.length, 0);
  const comment = utf8(options.comment ?? '');
  const end = new Uint8Array(22 + comment.length);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directoryBytes, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, comment.length, true);
  end.set(comment, 22);

  const all = [...parts, ...directory, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('listing', () => {
  it('reads names, sizes and methods from the directory', () => {
    const zip = buildZip([
      { name: 'Document/metadata.plist', body: utf8('<plist/>') },
      { name: 'notes/0.pb', body: utf8('page one') },
    ]);
    const entries = listZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['Document/metadata.plist', 'notes/0.pb']);
    expect(entries[1]!.uncompressedSize).toBe(8);
    expect(entries[1]!.method).toBe(METHOD_STORED);
  });

  it('finds the end record behind a trailing comment', () => {
    // A comment may be up to 64 kB, so the record cannot simply be read from
    // the last 22 bytes.
    const zip = buildZip([{ name: 'a.txt', body: utf8('x') }], { comment: 'k'.repeat(5000) });
    expect(listZipEntries(zip).map((e) => e.name)).toEqual(['a.txt']);
  });

  it('is not fooled by the signature appearing inside the data', () => {
    // Scanning backwards is what makes this true; a forward search would stop
    // at the first match.
    const decoy = new Uint8Array(64);
    new DataView(decoy.buffer).setUint32(8, 0x06054b50, true);
    const zip = buildZip([{ name: 'decoy.bin', body: decoy }]);
    expect(listZipEntries(zip).map((e) => e.name)).toEqual(['decoy.bin']);
  });

  it('handles an archive with no entries', () => {
    expect(listZipEntries(buildZip([]))).toEqual([]);
  });

  it('refuses something that is not a ZIP, in words', () => {
    expect(() => listZipEntries(utf8('%PDF-1.7'))).toThrow(ZipError);
    expect(() => listZipEntries(new Uint8Array(0))).toThrow(/too small/);
    expect(() => listZipEntries(utf8('x'.repeat(200)))).toThrow(/not a ZIP/);
  });

  it('says so when the directory is damaged rather than reading nonsense', () => {
    const zip = buildZip([{ name: 'a.txt', body: utf8('x') }]);
    // Corrupt the central header's signature.
    const directoryOffset = new DataView(zip.buffer).getUint32(zip.length - 6, true);
    zip[directoryOffset] = 0;
    expect(() => listZipEntries(zip)).toThrow(/damaged/);
  });
});

describe('reading an entry', () => {
  it('returns stored bytes as they are', async () => {
    const zip = buildZip([{ name: 'a.bin', body: new Uint8Array([1, 2, 3, 250]) }]);
    const [entry] = listZipEntries(zip);
    expect([...(await readZipEntry(zip, entry!))]).toEqual([1, 2, 3, 250]);
  });

  it('inflates a deflated entry', async () => {
    // The platform's own deflate, which is the whole reason there is no
    // dependency here.
    const body = utf8('page '.repeat(400));
    const stored = await deflateRaw(body);
    expect(stored.length).toBeLessThan(body.length);
    const zip = buildZip([{ name: 'notes/0.pb', body, stored, method: METHOD_DEFLATE }]);
    const [entry] = listZipEntries(zip);
    expect(new TextDecoder().decode(await readZipEntry(zip, entry!))).toBe('page '.repeat(400));
  });

  it('reads the data offset from the local header, not the directory', async () => {
    // The two records carry their own extra-field lengths and they need not
    // agree. Trusting the directory's is a classic way to land a few bytes
    // into the payload.
    const zip = buildZip([{ name: 'a.txt', body: utf8('correct'), localExtra: 11 }]);
    const [entry] = listZipEntries(zip);
    expect(new TextDecoder().decode(await readZipEntry(zip, entry!))).toBe('correct');
  });

  it('reads each of several entries independently', async () => {
    const zip = buildZip([
      { name: 'one', body: utf8('first') },
      { name: 'two', body: utf8('second') },
      { name: 'three', body: utf8('third') },
    ]);
    const entries = listZipEntries(zip);
    const bodies = await Promise.all(entries.map((e) => readZipEntry(zip, e)));
    expect(bodies.map((b) => new TextDecoder().decode(b))).toEqual(['first', 'second', 'third']);
  });

  it('refuses an entry that is not where the directory says', async () => {
    const zip = buildZip([{ name: 'a.txt', body: utf8('x') }]);
    await expect(readZipEntry(zip, { ...listZipEntries(zip)[0]!, offset: 3 })).rejects.toThrow(/not where/);
  });

  it('refuses an entry that runs past the end', async () => {
    const zip = buildZip([{ name: 'a.txt', body: utf8('x') }]);
    await expect(readZipEntry(zip, { ...listZipEntries(zip)[0]!, compressedSize: 99999 })).rejects.toThrow(/past the end/);
  });

  it('names an unsupported compression method rather than returning junk', async () => {
    const zip = buildZip([{ name: 'a.txt', body: utf8('x'), method: 12 }]);
    await expect(readZipEntry(zip, listZipEntries(zip)[0]!)).rejects.toThrow(/method 12/);
  });
});

describe('looksLikeZip', () => {
  it('recognises the local header signature and nothing else', () => {
    expect(looksLikeZip(buildZip([{ name: 'a', body: utf8('b') }]))).toBe(true);
    // An archive with no files starts with its end record and is still a ZIP;
    // calling it something else makes an empty notebook look like a wrong file.
    expect(looksLikeZip(buildZip([]))).toBe(true);
    expect(looksLikeZip(utf8('%PDF-1.7'))).toBe(false);
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
    expect(looksLikeZip(new Uint8Array(0))).toBe(false);
  });
});
