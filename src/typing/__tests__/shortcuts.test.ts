import { describe, expect, it } from 'vitest';
import { keyLabel, shortcutActions, SHORTCUT_GROUPS } from '../shortcuts';

describe('the typing shortcuts', () => {
  it('writes keys as each platform names them', () => {
    expect(keyLabel('Mod-Shift-8', false)).toBe('Ctrl+Shift+8');
    expect(keyLabel('Mod-Shift-8', true)).toBe('⌘⇧8');
    expect(keyLabel('Mod-.', false)).toBe('Ctrl+.');
    expect(keyLabel('Mod-ArrowLeft', false)).toBe('Ctrl+←');
    expect(keyLabel('Mod-\\\\', false)).toBe('Ctrl+\\\\');
    expect(keyLabel('Escape', false)).toBe('Esc');
  });

  it('shows what is typed, rather than a key, as it is', () => {
    expect(keyLabel('--', false)).toBe('--');
    expect(keyLabel('...', false)).toBe('...');
    expect(keyLabel('1. then space', false)).toBe('1. then space');
  });

  it('gives no key two jobs', () => {
    const seen = new Map<string, string>();
    for (const group of SHORTCUT_GROUPS) {
      for (const s of group.shortcuts) {
        if (!s.action) continue;
        for (const key of s.keys) {
          expect(seen.get(key), `${key}: ${s.label} and ${seen.get(key)}`).toBeUndefined();
          seen.set(key, s.label);
        }
      }
    }
    expect(shortcutActions().size).toBe(seen.size);
  });
});
