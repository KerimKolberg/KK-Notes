import { describe, expect, it } from 'vitest';
import { leaveStep } from '../leaveDocument';
import { isPdfPath } from '../../desktop/fileService';

describe('going back to the library', () => {
  it('goes straight back with nothing unsaved, saves a note with a file, asks about one without', () => {
    expect(leaveStep(false, null)).toBe('go');
    expect(leaveStep(false, '/library/a.notex')).toBe('go');
    expect(leaveStep(true, '/library/a.notex')).toBe('save');
    expect(leaveStep(true, null)).toBe('ask');
  });
});

describe('Save As', () => {
  it('tells a PDF from a note by the name chosen', () => {
    expect(isPdfPath('C:\\\\Notes\\\\Lecture.pdf')).toBe(true);
    expect(isPdfPath('C:\\\\Notes\\\\Lecture.PDF')).toBe(true);
    expect(isPdfPath('C:\\\\Notes\\\\Lecture.notex')).toBe(false);
    expect(isPdfPath('content://docs/Lecture.pdf?x=1')).toBe(true);
  });
});
