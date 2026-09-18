import { afterEach, describe, expect, it } from 'vitest';
import { createPage, setPageDefaultsSource } from '../../document/operations';
import { DEFAULT_TEMPLATE_CONFIG, LIGHT_PAGE_BACKGROUND } from '../../document/constants';

afterEach(() => setPageDefaultsSource(null));

const preferred = {
  template: 'ruled' as const,
  templateConfig: { ...DEFAULT_TEMPLATE_CONFIG, spacing: 44 },
  backgroundColor: '#fffdf5',
};

describe('a page created with a preferred layout', () => {
  it('is blank when nothing has been set as a default', () => {
    const page = createPage();
    expect(page.template).toBe('blank');
    expect(page.backgroundColor).toBe(LIGHT_PAGE_BACKGROUND);
  });

  it('takes the layout the user set as their default', () => {
    setPageDefaultsSource(() => preferred);
    const page = createPage();
    expect(page.template).toBe('ruled');
    expect(page.templateConfig.spacing).toBe(44);
    expect(page.backgroundColor).toBe('#fffdf5');
  });

  it('lets an explicit request win, so a PDF import is still a PDF page', () => {
    // Every page goes through `createPage`, including the ones whose template
    // is not a preference at all.
    setPageDefaultsSource(() => preferred);
    const imported = createPage({ template: 'pdf', backgroundColor: '#ffffff' });
    expect(imported.template).toBe('pdf');
    expect(imported.backgroundColor).toBe('#ffffff');
    // …while the fields the caller left open still come from the default.
    expect(imported.templateConfig.spacing).toBe(44);
  });

  it('goes back to blank the moment the default is cleared', () => {
    setPageDefaultsSource(() => preferred);
    expect(createPage().template).toBe('ruled');
    setPageDefaultsSource(() => null);
    expect(createPage().template).toBe('blank');
  });

  it('is unaffected when no source is installed at all', () => {
    // `operations.ts` is a pure module the tests use without a store behind
    // it; it must keep working with nothing plugged in.
    setPageDefaultsSource(null);
    expect(createPage().template).toBe('blank');
  });
});
