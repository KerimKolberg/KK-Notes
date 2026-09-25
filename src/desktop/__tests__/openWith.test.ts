import { describe, expect, it } from 'vitest';
import { classifyOpenWith, parseOpenWith } from '../openWith';

const request = (uri: string, mime = '') => ({ uri, mime });

describe('classifying what a launch pointed at', () => {
  it('recognises a PDF by its extension', () => {
    expect(classifyOpenWith(request('/sdcard/Download/lecture.pdf'))).toBe('pdf');
    expect(classifyOpenWith(request('/sdcard/Download/LECTURE.PDF'))).toBe('pdf');
  });

  it('recognises the app’s own documents', () => {
    expect(classifyOpenWith(request('/sdcard/Notes/Week 1.notex'))).toBe('notex');
    expect(classifyOpenWith(request('/sdcard/Notes/export.json'))).toBe('notex');
  });

  it('recognises a GoodNotes notebook', () => {
    expect(classifyOpenWith(request('/sdcard/Download/Chemistry.goodnotes'))).toBe('goodnotes');
    expect(classifyOpenWith(request('content://x/9', 'com.goodnotes.document'))).toBe('goodnotes');
  });

  it('does not take every archive for a notebook', () => {
    // A notebook is a ZIP, so the type a sender declares for one is the type it
    // declares for every archive. Claiming those would put the app in the
    // chooser for backups and font packs.
    expect(classifyOpenWith(request('content://x/9', 'application/zip'))).toBe('unknown');
    expect(classifyOpenWith(request('/x/photos.zip'))).toBe('unknown');
  });

  it('trusts the extension over what the sender claimed', () => {
    // File managers routinely hand over a content:// URI typed
    // application/octet-stream; the extension is the better evidence.
    expect(classifyOpenWith(request('/x/lecture.pdf', 'application/octet-stream'))).toBe('pdf');
    expect(classifyOpenWith(request('/x/notes.notex', 'text/plain'))).toBe('notex');
    // And a document is still a document when a sender calls it an archive.
    expect(classifyOpenWith(request('/x/notes.notex', 'application/zip'))).toBe('notex');
  });

  it('falls back to the MIME type when there is no extension to read', () => {
    // A content:// URI frequently has no visible file name at all.
    expect(classifyOpenWith(request('content://media/external/downloads/1042', 'application/pdf'))).toBe('pdf');
    expect(classifyOpenWith(request('content://x/9', 'application/x-notex+json'))).toBe('notex');
    expect(classifyOpenWith(request('content://x/9', 'application/pdf; charset=binary'))).toBe('pdf');
  });

  it('ignores a query string or fragment in the name', () => {
    expect(classifyOpenWith(request('content://x/doc.pdf?take=1'))).toBe('pdf');
    expect(classifyOpenWith(request('file:///tmp/a.notex#page=2'))).toBe('notex');
  });

  it('says so when it is neither', () => {
    expect(classifyOpenWith(request('/x/photo.jpg', 'image/jpeg'))).toBe('unknown');
    expect(classifyOpenWith(request('content://x/9', ''))).toBe('unknown');
    // Not a PDF just because the word appears in the path.
    expect(classifyOpenWith(request('/pdf/notes/readme.txt', 'text/plain'))).toBe('unknown');
  });
});

describe('reading the bridge payload', () => {
  it('parses what the activity sends', () => {
    expect(parseOpenWith('{"uri":"content://x/1","mime":"application/pdf"}')).toEqual({
      uri: 'content://x/1',
      mime: 'application/pdf',
    });
  });

  it('tolerates a missing MIME type', () => {
    expect(parseOpenWith('{"uri":"/tmp/a.pdf"}')).toEqual({ uri: '/tmp/a.pdf', mime: '' });
  });

  it('refuses anything that is not a request', () => {
    // This crosses a language boundary, so the shape is checked, not trusted.
    for (const payload of [null, undefined, '', 'not json', '[]', '{}', '{"uri":""}', '{"uri":"   "}', '{"uri":42}']) {
      expect(parseOpenWith(payload)).toBeNull();
    }
  });
});
