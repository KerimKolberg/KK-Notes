import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { encodeNotexBytes, parseNotex } from '../../desktop/notex';
import { makeStroke } from '../../inking/__tests__/testUtils';
import { createDocument, createPage } from '../../document/operations';
import { rotatePage } from '../../document/rotatePage';
import type { Document, PdfPageRef } from '../../document/types';
import { readEmbeddedNote } from '../embeddedNote';
import { exportDocumentToPdf } from '../export';

function note(): Document {
  const doc = createDocument(2, 'Physics');
  return { ...doc, pages: doc.pages.map((p, i) => (i === 0 ? { ...p, strokes: [makeStroke([[100, 100], [300, 140]])] } : p)) };
}

async function onePagePdf(): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  const bytes = await pdf.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('a note saved as a PDF', () => {
  it('opens again as the note, its ink still ink', async () => {
    const doc = note();
    const pdf = await exportDocumentToPdf(doc, { note: encodeNotexBytes(doc) });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(2);
    const text = await readEmbeddedNote(pdf);
    expect(text).not.toBeNull();
    const back = parseNotex(text!).document;
    expect(back.pages.map((p) => p.strokes.length)).toEqual([1, 0]);
    expect(back.pages[0]!.strokes[0]!.id).toBe(doc.pages[0]!.strokes[0]!.id);
  });

  it('is a plain PDF when exported for someone else, and for any PDF this app did not save', async () => {
    const doc = note();
    expect(await readEmbeddedNote(await exportDocumentToPdf(doc))).toBeNull();
    expect(await readEmbeddedNote(new Uint8Array(await onePagePdf()))).toBeNull();
    expect(await readEmbeddedNote(new TextEncoder().encode('KKNotesSaved but not a PDF'))).toBeNull();
  });

  it('opens as the PDF it now is once another app has saved it', async () => {
    const doc = note();
    const saved = await PDFDocument.load(await exportDocumentToPdf(doc, { note: encodeNotexBytes(doc) }));
    saved.setModificationDate(new Date(Date.now() + 60_000));
    expect(await readEmbeddedNote(await saved.save())).toBeNull();
  });

  it('writes a turned PDF page turned', async () => {
    const data = await onePagePdf();
    const ref: PdfPageRef = { sourceId: 's', sourceName: 's.pdf', data, pageCount: 1, pageIndex: 0, viewBox: [0, 0, 600, 800], rotation: 0, scale: 4 / 3 };
    const page = rotatePage(createPage({ template: 'pdf', pdf: ref, dimensions: { width: 800, height: 1067 } }), 1);
    const out = await PDFDocument.load(await exportDocumentToPdf({ ...createDocument(1), pages: [page] }));
    expect(out.getPage(0).getRotation().angle).toBe(90);
  });
});
