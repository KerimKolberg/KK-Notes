import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStroke } from '../../inking/__tests__/testUtils';
import type { Stroke } from '../../inking/types';
import { createDocument } from '../../document/operations';
import { deserializeDocument, serializeDocument } from '../../document/serialization';
import { selectIsDirty, useDocumentStore } from '../../document/store';
import { addRecordingToTab, captureSession, useTabStore } from '../../document/tabStore';
import { isPristine, sessionIsDirty } from '../../document/tabs';
import { isBlankNote } from '../../document/reading';
import type { Recording } from '../../document/types';
import { formatDuration, joinChunks, markTime, newMarks, pickMime } from '../recorder';
import { LATER_OPACITY, laterCount, markAt, withLaterFaded } from '../replay';

vi.mock('../../pdf/pdfRenderer', () => ({ releasePdfSource: () => {} }));

const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;

function recording(over: Partial<Recording> = {}): Recording {
  return {
    id: 'rec_1',
    startedAt: '2026-10-03T09:00:00.000Z',
    duration: 61.5,
    mime: 'audio/webm;codecs=opus',
    data: bytes(1, 2, 3, 250, 0, 7),
    marks: [{ strokeId: 'a', t: 1.25 }],
    ...over,
  };
}

const at = (id: string, x: number, y: number): Stroke => makeStroke([[x, y], [x + 20, y]], { id });

describe('recording', () => {
  it('picks the first format the engine can record in', () => {
    expect(pickMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickMime((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickMime(() => false)).toBe('');
  });

  it('marks a stroke with when it was begun, in seconds into the recording', () => {
    expect(markTime({ createdAt: 3500 }, 1000, 9000)).toBe(2.5);
    // Begun before the recording (a stroke moved or pasted in): it is marked as now.
    expect(markTime({ createdAt: 10 }, 1000, 9000)).toBe(8);
    expect(markTime({ createdAt: 1000 + 1234.567 }, 1000, 9000)).toBe(1.23);
  });

  it('marks only strokes it has not seen, looking only at pages that changed', () => {
    const a = at('a', 0, 0);
    const b = at('b', 0, 40);
    const c = { ...at('c', 0, 80), createdAt: 4000 };
    const seen = new Set(['a']);
    const before = [
      { id: 'p1', strokes: [a] },
      { id: 'p2', strokes: [b] },
    ];
    // p2 is the same list as before, so its unseen stroke is not looked at.
    const after = [{ id: 'p1', strokes: [a, c] }, before[1]!];
    expect(newMarks(before, after, seen, 1000, 6000)).toEqual([{ strokeId: 'c', t: 3 }]);
    expect(seen.has('c')).toBe(true);
    expect(seen.has('b')).toBe(false);
    expect(newMarks(after, [{ id: 'p1', strokes: [a, c] }, before[1]!], seen, 1000, 7000)).toEqual([]);
  });

  it('joins the chunks in order, up to one still being read', () => {
    expect(new Uint8Array(joinChunks([bytes(1, 2), bytes(3)])!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(joinChunks([bytes(1), undefined, bytes(3)])!)).toEqual(new Uint8Array([1]));
    expect(joinChunks([])).toBeNull();
    expect(joinChunks([undefined, bytes(1)])).toBeNull();
  });

  it('shows a length as minutes and seconds, and hours past the hour', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65.9)).toBe('1:05');
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(-4)).toBe('0:00');
  });
});

describe('replay', () => {
  const a = at('a', 0, 0);
  const b = at('b', 0, 100);
  const old = at('old', 0, 200);
  const times = new Map([
    ['a', 2],
    ['b', 10],
  ]);

  it('fades ink begun later than the position, and only that', () => {
    expect(laterCount([a, b, old], times, 5)).toBe(1);
    const shown = withLaterFaded([a, b, old], times, 5);
    expect(shown[0]).toBe(a);
    expect(shown[2]).toBe(old);
    expect(shown[1]!.id).toBe('b');
    expect(shown[1]!.style.opacity).toBeCloseTo(b.style.opacity * LATER_OPACITY);
    // The same faded copy every time, so a page redraws only when the position passes a stroke.
    expect(withLaterFaded([a, b, old], times, 6)[1]).toBe(shown[1]);
    expect(laterCount([a, b, old], times, 10)).toBe(0);
  });

  it('finds when the ink under a point was written', () => {
    expect(markAt([a, b, old], times, 10, 101, 4)).toBe(10);
    expect(markAt([a, b, old], times, 10, 1, 4)).toBe(2);
    // Writing from before the recording has no time; paper has none either.
    expect(markAt([a, b, old], times, 10, 200, 4)).toBeNull();
    expect(markAt([a, b, old], times, 10, 50, 4)).toBeNull();
  });

  it('takes the earliest of strokes written over each other', () => {
    const over = at('over', 0, 0);
    expect(markAt([a, over], new Map([['a', 7], ['over', 3]]), 10, 0, 4)).toBe(3);
  });
});

describe('recordings in a note', () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeId: null, clock: 1, splitId: null, splitRatio: 0.6, splitSide: 'right' });
    useDocumentStore.getState().newDocument();
    useDocumentStore.setState({ readOnly: false });
  });

  it('are saved in the file and read back', () => {
    const doc = { ...createDocument(1, 'Lecture'), recordings: [recording()] };
    const back = deserializeDocument(serializeDocument(doc));
    expect(back.recordings).toHaveLength(1);
    const r = back.recordings![0]!;
    expect(new Uint8Array(r.data)).toEqual(new Uint8Array([1, 2, 3, 250, 0, 7]));
    expect({ ...r, data: null }).toEqual({ ...recording(), data: null });
  });

  it('leave a note without any just as it was', () => {
    const doc = createDocument(1, 'Plain');
    expect(serializeDocument(doc)).not.toContain('recordings');
    expect(deserializeDocument(serializeDocument(doc)).recordings).toBeUndefined();
  });

  it('that are damaged are left out, and the rest kept', () => {
    const json = JSON.parse(serializeDocument({ ...createDocument(1), recordings: [recording()] })) as Record<string, unknown>;
    const good = (json.recordings as unknown[])[0] as Record<string, unknown>;
    json.recordings = [
      { ...good, id: 'no-data', data: 42 },
      'nonsense',
      { ...good, id: 'bad-marks', duration: -3, marks: [{ strokeId: 'x', t: -1 }, { strokeId: 'y', t: 4 }, null] },
    ];
    const back = deserializeDocument(JSON.stringify(json));
    expect(back.recordings!.map((r) => r.id)).toEqual(['bad-marks']);
    expect(back.recordings![0]!.duration).toBe(0);
    expect(back.recordings![0]!.marks).toEqual([{ strokeId: 'y', t: 4 }]);
  });

  it('make the note changed when added or taken out, and not once saved', () => {
    const store = useDocumentStore.getState();
    expect(selectIsDirty(useDocumentStore.getState())).toBe(false);
    store.addRecording(recording());
    expect(useDocumentStore.getState().document.recordings).toHaveLength(1);
    expect(selectIsDirty(useDocumentStore.getState())).toBe(true);
    useDocumentStore.getState().markSaved('/Lecture.notex');
    expect(selectIsDirty(useDocumentStore.getState())).toBe(false);
    useDocumentStore.getState().removeRecording('rec_1');
    expect(useDocumentStore.getState().document.recordings ?? []).toHaveLength(0);
    expect(selectIsDirty(useDocumentStore.getState())).toBe(true);
  });

  it('keep a note with nothing written from counting as blank', () => {
    const document = createDocument(1, '');
    const session = { document, filePath: null, savedPages: document.pages, savedTitle: document.title, savedCover: document.cover, readOnly: false };
    expect(isPristine(session)).toBe(true);
    expect(isBlankNote(session)).toBe(true);
    const recorded = { ...session, document: { ...document, recordings: [recording()] } };
    expect(isPristine(recorded)).toBe(false);
    expect(isBlankNote(recorded)).toBe(false);
  });

  it('go with a note to its tab when the tabs are switched while recording', async () => {
    useTabStore.getState().adoptCurrent();
    useDocumentStore.getState().setTitle('Lecture');
    const lecture = captureSession();
    const other = createDocument(1, 'Other');
    useTabStore.getState().openTab({ document: other, filePath: '/Other.notex', savedPages: other.pages, savedTitle: other.title, savedCover: other.cover, readOnly: false });
    expect(useDocumentStore.getState().document.title).toBe('Other');

    // A session that is not the note as it was put away is not written over.
    expect(await addRecordingToTab(lecture.document.id, recording(), { ...lecture.document })).toBe(false);

    expect(await addRecordingToTab(lecture.document.id, recording(), lecture.document)).toBe(true);
    const tab = useTabStore.getState().tabs.find((t) => t.session?.document.id === lecture.document.id)!;
    expect(tab.session!.document.recordings).toHaveLength(1);
    expect(sessionIsDirty(tab.session!)).toBe(true);
    expect(tab.dirty).toBe(true);
  });
});
