import { describe, expect, it } from 'vitest';
import { describeAge, describePages, describeSize } from '../versions';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

describe('describeAge', () => {
  it('reads in the unit that fits', () => {
    expect(describeAge(NOW - 20_000, NOW)).toBe('just now');
    expect(describeAge(NOW - MIN, NOW)).toBe('1 minute ago');
    expect(describeAge(NOW - 12 * MIN, NOW)).toBe('12 minutes ago');
    expect(describeAge(NOW - 60 * MIN, NOW)).toBe('1 hour ago');
    expect(describeAge(NOW - 5 * 60 * MIN, NOW)).toBe('5 hours ago');
    expect(describeAge(NOW - 30 * 60 * MIN, NOW)).toBe('yesterday');
    expect(describeAge(NOW - 5 * 24 * 60 * MIN, NOW)).toBe('5 days ago');
  });

  it('gives a date once it is weeks old, and never reads a clock running behind as the future', () => {
    expect(describeAge(NOW - 30 * 24 * 60 * MIN, NOW)).toMatch(/\d{4}/);
    expect(describeAge(NOW + 5 * MIN, NOW)).toBe('just now');
  });
});

describe('describePages and describeSize', () => {
  it('counts pages', () => {
    expect([0, 1, 7].map(describePages)).toEqual(['No pages', '1 page', '7 pages']);
  });

  it('sizes in bytes, kilobytes and megabytes', () => {
    expect(describeSize(640)).toBe('640 B');
    expect(describeSize(12 * 1024)).toBe('12 KB');
    expect(describeSize(3.44 * 1024 * 1024)).toBe('3.4 MB');
    expect(describeSize(48 * 1024 * 1024)).toBe('48 MB');
  });
});
