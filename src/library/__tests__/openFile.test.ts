import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPENABLE_ACCEPT, OPENABLE_EXTENSIONS, isOpenable } from '../openFile';

/**
 * The library's Open button.
 *
 * The rule worth pinning is that a file picked here goes through the *same*
 * decision as one tapped in a file manager. Two code paths that both "open a
 * PDF" drift — one preserves the page size, the other does not; one keeps the
 * title, the other invents one — and the divergence only shows up when
 * somebody compares the two documents.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('what the picker offers', () => {
  it('covers documents and PDFs', () => {
    expect([...OPENABLE_EXTENSIONS]).toEqual(['notex', 'json', 'pdf']);
    for (const fragment of ['.notex', '.pdf', 'application/pdf']) {
      expect(OPENABLE_ACCEPT).toContain(fragment);
    }
  });

  it('recognises a file by extension, through a query string', () => {
    // Extension before MIME on purpose: a `content://` URI is routinely typed
    // `application/octet-stream`, and a browser File sometimes has no type.
    expect(isOpenable('week 1.notex')).toBe(true);
    expect(isOpenable('/sdcard/Download/Lecture.PDF')).toBe(true);
    expect(isOpenable('content://downloads/42/report.pdf?take=1')).toBe(true);
    expect(isOpenable('notes.json')).toBe(true);

    expect(isOpenable('photo.png')).toBe(false);
    expect(isOpenable('pdf')).toBe(false);
    expect(isOpenable('notexfile')).toBe(false);
    expect(isOpenable('')).toBe(false);
  });
});

describe('the desktop path', () => {
  async function load(picked: string | null) {
    const openRequested = vi.fn().mockResolvedValue({ view: 'document', path: picked });
    const open = vi.fn().mockResolvedValue(picked);
    vi.doMock('../../desktop/boot', () => ({ openRequested, importPdfFileAsDocument: vi.fn() }));
    vi.doMock('../../desktop/tauri', () => ({ isTauri: () => true, tauriDialog: async () => ({ open }) }));
    const mod = await import('../openFile');
    return { ...mod, openRequested, open };
  }

  it('hands the picked path to the same opener an intent uses', async () => {
    const m = await load('/sdcard/Download/Lecture.pdf');
    const target = await m.openFileFromLibrary();
    expect(m.openRequested).toHaveBeenCalledWith({ uri: '/sdcard/Download/Lecture.pdf', mime: '' });
    expect(target).toEqual({ view: 'document', path: '/sdcard/Download/Lecture.pdf' });
  });

  it('offers PDFs and documents in one filter, so the user need not know which they want', async () => {
    const m = await load('/x.notex');
    await m.openFileFromLibrary();
    const filters = m.open.mock.calls[0]![0].filters as { name: string; extensions: string[] }[];
    expect(filters[0]!.extensions).toEqual(['notex', 'json', 'pdf']);
  });

  it('opens nothing when the picker is cancelled', async () => {
    const m = await load(null);
    expect(await m.openFileFromLibrary()).toBeNull();
    expect(m.openRequested).not.toHaveBeenCalled();
  });
});

describe('the browser path', () => {
  async function load() {
    const loadDocument = vi.fn();
    const setNotice = vi.fn();
    const importPdfFileAsDocument = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../desktop/boot', () => ({ openRequested: vi.fn(), importPdfFileAsDocument }));
    vi.doMock('../../desktop/tauri', () => ({ isTauri: () => false, tauriDialog: vi.fn() }));
    vi.doMock('../../document/store', () => ({ useDocumentStore: { getState: () => ({ loadDocument }) } }));
    vi.doMock('../../desktop/desktopStore', () => ({ useDesktopStore: { getState: () => ({ setNotice }) } }));
    const mod = await import('../openFile');
    return { ...mod, loadDocument, setNotice, importPdfFileAsDocument };
  }

  const asFile = (name: string, body: string, type = ''): File =>
    ({ name, type, text: async () => body }) as unknown as File;

  it('opens a document from its bytes', async () => {
    const m = await load();
    // Built by the real encoder rather than hand-written JSON, so this is the
    // shape the app actually writes.
    const { encodeNotex } = await import('../../desktop/notex');
    const { createDocument } = await import('../../document/operations');
    const notex = encodeNotex(createDocument(1, 'Week 1'));

    expect(await m.openBrowserFile(asFile('week 1.notex', notex))).toEqual({ view: 'document', path: null });
    expect(m.loadDocument).toHaveBeenCalledWith(expect.objectContaining({ title: 'Week 1' }), null);
  });

  it('imports a PDF rather than trying to parse it as a document', async () => {
    const m = await load();
    expect(await m.openBrowserFile(asFile('Lecture.pdf', '', 'application/pdf'))).toEqual({ view: 'document', path: null });
    expect(m.importPdfFileAsDocument).toHaveBeenCalled();
    expect(m.loadDocument).not.toHaveBeenCalled();
  });

  it('reports a file it cannot read instead of failing silently', async () => {
    // The library shows this notice. Silence is what made the Android
    // "open with" bug so hard to see.
    const m = await load();
    expect(await m.openBrowserFile(asFile('notes.notex', 'not json'))).toBeNull();
    expect(m.setNotice).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('notes.notex') }));
  });
});
