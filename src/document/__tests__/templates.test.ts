import { describe, expect, it } from 'vitest';
import { A4_DIMENSIONS, DEFAULT_TEMPLATE_CONFIG } from '../constants';
import {
  isDarkBackground,
  lineFamily,
  parseColor,
  relativeLuminance,
  templateLines,
  templatePalette,
  templateSvg,
  type TemplatePage,
} from '../templates';

const base: TemplatePage = {
  dimensions: A4_DIMENSIONS,
  template: 'blank',
  templateConfig: DEFAULT_TEMPLATE_CONFIG,
  backgroundColor: '#ffffff',
};

describe('colour helpers', () => {
  it('parses hex and rgb() and measures luminance', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor('#1c1c21')).toEqual([28, 28, 33]);
    expect(parseColor('rgb(10, 20, 30)')).toEqual([10, 20, 30]);
    expect(parseColor('papayawhip')).toBeNull();
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1);
    expect(relativeLuminance('#000000')).toBeCloseTo(0);
    expect(isDarkBackground('#1c1c21')).toBe(true);
    expect(isDarkBackground('#fdf6e3')).toBe(false);
  });

  it('derives a theme-aware palette, or passes an explicit colour through', () => {
    expect(templatePalette('#ffffff', 'auto').line).toMatch(/rgba\(30, 41, 59/);
    expect(templatePalette('#1c1c21', 'auto').line).toMatch(/rgba\(226, 232, 240/);
    expect(templatePalette('#ffffff', '#ff0000')).toEqual({ line: '#ff0000', minor: '#ff0000', margin: '#ff0000' });
  });
});

describe('templateLines', () => {
  it('blank and pdf produce nothing', () => {
    expect(templateLines(base)).toEqual([]);
    expect(templateLines({ ...base, template: 'pdf' })).toEqual([]);
  });

  it('ruled: evenly spaced horizontals starting three rows down, plus a margin line', () => {
    const spacing = 32;
    const lines = templateLines({ ...base, template: 'ruled', templateConfig: { ...DEFAULT_TEMPLATE_CONFIG, spacing } });
    const horizontals = lines.filter((l) => l.y1 === l.y2);
    const verticals = lines.filter((l) => l.x1 === l.x2);
    expect(horizontals).toHaveLength(Math.floor((A4_DIMENSIONS.height - 3 * spacing) / spacing) + 1);
    expect(horizontals[0]?.y1).toBe(3 * spacing);
    expect(horizontals[1]?.y1).toBe(4 * spacing);
    expect(verticals).toHaveLength(1);
    expect(verticals[0]?.x1).toBe(96);

    const noMargin = templateLines({
      ...base,
      template: 'ruled',
      templateConfig: { ...DEFAULT_TEMPLATE_CONFIG, spacing, marginOffset: 0 },
    });
    expect(noMargin.filter((l) => l.x1 === l.x2)).toHaveLength(0);
  });

  it('grid: square cells', () => {
    const lines = templateLines({ ...base, template: 'grid' });
    const verticals = lines.filter((l) => l.x1 === l.x2);
    const horizontals = lines.filter((l) => l.y1 === l.y2);
    expect(verticals).toHaveLength(Math.floor(A4_DIMENSIONS.width / 20));
    expect(horizontals).toHaveLength(Math.floor(A4_DIMENSIONS.height / 20));
    expect(verticals[1]?.x1).toBe(40);
  });

  it('engineering: fine minor lines and bolder major lines every fifth cell', () => {
    const lines = templateLines({ ...base, template: 'engineering' });
    const widths = new Set(lines.map((l) => l.width));
    expect(widths.size).toBe(2);
    const major = lines.filter((l) => l.width === Math.max(...widths));
    const minor = lines.filter((l) => l.width === Math.min(...widths));
    expect(major.length).toBeLessThan(minor.length);
    expect(major.filter((l) => l.x1 === l.x2)[0]?.x1).toBe(100);
    expect(major[0]?.color).not.toBe(minor[0]?.color);
  });

  it('isometric: three line families, all clipped to the page', () => {
    const page = { ...base, template: 'isometric' as const };
    const lines = templateLines(page);
    // Direction is only defined modulo 180°.
    const angles = new Set(
      lines.map((l) => ((Math.round((Math.atan2(l.y2 - l.y1, l.x2 - l.x1) * 180) / Math.PI) % 180) + 180) % 180),
    );
    expect([...angles].sort((a, b) => a - b)).toEqual([30, 90, 150]);
    for (const l of lines) {
      for (const [x, y] of [
        [l.x1, l.y1],
        [l.x2, l.y2],
      ]) {
        expect(x).toBeGreaterThanOrEqual(-1e-6);
        expect(x).toBeLessThanOrEqual(A4_DIMENSIONS.width + 1e-6);
        expect(y).toBeGreaterThanOrEqual(-1e-6);
        expect(y).toBeLessThanOrEqual(A4_DIMENSIONS.height + 1e-6);
      }
    }
  });

  it('lineFamily spacing is the perpendicular pitch', () => {
    const family = lineFamily(90, 25, 100, 50, 1, '#000');
    expect(family.map((l) => Math.round(l.x1))).toEqual([0, 25, 50, 75, 100]);
    const diag = lineFamily(45, 10, 100, 100, 1, '#000');
    expect(diag.length).toBeGreaterThan(10);
  });

  it('templateSvg emits one <line> per template line', () => {
    const page = { ...base, template: 'grid' as const };
    const svg = templateSvg(page);
    expect((svg.match(/<line /g) ?? []).length).toBe(templateLines(page).length);
    expect(svg).toContain(`viewBox="0 0 ${A4_DIMENSIONS.width} ${A4_DIMENSIONS.height}"`);
  });
});
