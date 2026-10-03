import { describe, expect, it, vi } from 'vitest';
import { releaseSourceCaches, SourceCache } from '../sourceCache';

describe('SourceCache', () => {
  it('reads once, and shares a reading still under way', async () => {
    const cache = new SourceCache<string>(4);
    const load = vi.fn(async () => 'words');
    const [a, b] = [cache.get('s', '1', load), cache.get('s', '1', load)];
    expect(a).toBe(b);
    expect(await a).toBe('words');
    await cache.get('s', '1', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not keep a reading that failed', async () => {
    const cache = new SourceCache<string>(4);
    await expect(cache.get('s', '1', () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(cache.size).toBe(0);
    expect(await cache.get('s', '1', async () => 'again')).toBe('again');
  });

  it('lets go of the least recently used once full', async () => {
    const cache = new SourceCache<number>(2);
    const one = vi.fn(async () => 1);
    await cache.get('s', '1', one);
    await cache.get('s', '2', async () => 2);
    await cache.get('s', '1', one); // 1 is now the most recent
    await cache.get('s', '3', async () => 3); // so 2 goes
    expect(cache.size).toBe(2);
    await cache.get('s', '1', one);
    expect(one).toHaveBeenCalledTimes(1);
    const two = vi.fn(async () => 2);
    await cache.get('s', '2', two);
    expect(two).toHaveBeenCalledTimes(1);
  });

  it('forgets a released source in every cache, and only that source', async () => {
    const words = new SourceCache<string>(8);
    const outlines = new SourceCache<string>(8);
    await words.get('a', '1', async () => 'a1');
    await words.get('ab', '1', async () => 'ab1');
    await outlines.get('a', '', async () => 'a-outline');
    releaseSourceCaches('a');
    expect(words.size).toBe(1);
    expect(outlines.size).toBe(0);
  });
});
