import { describe, expect, it } from 'vitest';
import {
  ALL_NOTES,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  cleanTag,
  favouriteCount,
  matchesFilter,
  movePath,
  parseTags,
  removePath,
  setTags,
  tagCounts,
  toggleFavourite,
  type MetaMap,
} from '../noteMeta';

describe('tags as typed', () => {
  it('cleans one', () => {
    expect(cleanTag('  #Maths  ')).toBe('Maths');
    expect(cleanTag('a   b')).toBe('a b');
    expect(cleanTag('x'.repeat(100)).length).toBe(MAX_TAG_LENGTH);
    expect(cleanTag('###')).toBe('');
  });

  it('splits a list, dropping empties and repeats whatever their case', () => {
    expect(parseTags('school, Math,, math ; #Home\nwork')).toEqual(['school', 'Math', 'Home', 'work']);
    expect(parseTags('')).toEqual([]);
  });

  it('keeps no more than a note can carry', () => {
    expect(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(',')).length).toBe(MAX_TAGS);
  });
});

describe('the map', () => {
  it('toggles a favourite on and off, leaving nothing behind when it is off', () => {
    const on = toggleFavourite({}, '/a.notex');
    expect(on['/a.notex']).toEqual({ favourite: true });
    expect(toggleFavourite(on, '/a.notex')).toEqual({});
  });

  it('sets tags, keeping the favourite, and clears an entry with nothing in it', () => {
    let map: MetaMap = toggleFavourite({}, '/a.notex');
    map = setTags(map, '/a.notex', ['x']);
    expect(map['/a.notex']).toEqual({ favourite: true, tags: ['x'] });
    map = toggleFavourite(map, '/a.notex');
    map = setTags(map, '/a.notex', []);
    expect(map).toEqual({});
  });

  it('does not change a map it had nothing to do to', () => {
    const map: MetaMap = { '/a': { favourite: true } };
    expect(setTags({}, '/a', [])).toEqual({});
    expect(removePath(map, '/zzz')).toBe(map);
    expect(movePath(map, '/zzz', '/yyy')).toBe(map);
    expect(movePath(map, '/a', '/a')).toBe(map);
  });
});

describe('moving and deleting', () => {
  const map: MetaMap = {
    '/lib/a.notex': { favourite: true },
    '/lib/Work/b.notex': { tags: ['w'] },
    '/lib/Work/Deep/c.notex': { tags: ['d'] },
    '/lib/Workshop/d.notex': { favourite: true },
    'C:\\lib\\Work\\e.notex': { tags: ['win'] },
  };

  it('moves a note with its entry', () => {
    const next = movePath(map, '/lib/a.notex', '/lib/Work/a.notex');
    expect(next['/lib/Work/a.notex']).toEqual({ favourite: true });
    expect('/lib/a.notex' in next).toBe(false);
  });

  it('moves everything inside a folder, and nothing whose name only begins the same', () => {
    const next = movePath(map, '/lib/Work', '/lib/Archive/Work');
    expect(Object.keys(next).sort()).toEqual([
      '/lib/Archive/Work/Deep/c.notex',
      '/lib/Archive/Work/b.notex',
      '/lib/Workshop/d.notex',
      '/lib/a.notex',
      'C:\\lib\\Work\\e.notex',
    ]);
  });

  it('follows a folder on Windows, where paths use backslashes', () => {
    const next = movePath(map, 'C:\\lib\\Work', 'C:\\lib\\Old');
    expect(next['C:\\lib\\Old\\e.notex']).toEqual({ tags: ['win'] });
  });

  it('drops a deleted note, or a deleted folder and what was in it', () => {
    expect(Object.keys(removePath(map, '/lib/a.notex')).length).toBe(4);
    expect(Object.keys(removePath(map, '/lib/Work')).sort()).toEqual(['/lib/Workshop/d.notex', '/lib/a.notex', 'C:\\lib\\Work\\e.notex']);
  });
});

describe('what is in use', () => {
  const map: MetaMap = {
    '/a': { tags: ['Math', 'school'], favourite: true },
    '/b': { tags: ['math'] },
    '/c': { tags: ['home'], favourite: true },
  };

  it('counts tags, merging spellings, most used first', () => {
    expect(tagCounts(map)).toEqual([
      { tag: 'Math', count: 2 },
      { tag: 'home', count: 1 },
      { tag: 'school', count: 1 },
    ]);
    expect(favouriteCount(map)).toBe(2);
  });

  it('filters', () => {
    expect(matchesFilter(map['/a'], ALL_NOTES)).toBe(true);
    expect(matchesFilter(undefined, ALL_NOTES)).toBe(true);
    expect(matchesFilter(map['/b'], { kind: 'favourites' })).toBe(false);
    expect(matchesFilter(map['/c'], { kind: 'favourites' })).toBe(true);
    expect(matchesFilter(map['/b'], { kind: 'tag', tag: 'MATH' })).toBe(true);
    expect(matchesFilter(undefined, { kind: 'tag', tag: 'math' })).toBe(false);
  });
});
