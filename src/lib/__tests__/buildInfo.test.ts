import { describe, expect, it } from 'vitest';
import { describeBuild } from '../buildInfo';

describe('which build this is', () => {
  it('names the release and the commit a build was made from', () => {
    expect(describeBuild({ version: '0.1.0', label: 'windows-42', commit: '78d6f1c' })).toBe('KK-Notes 0.1.0 · windows-42 · 78d6f1c');
    expect(describeBuild({ version: '0.1.0', label: 'android-50', commit: '' })).toBe('KK-Notes 0.1.0 · android-50');
  });

  it('says a build made by hand is one', () => {
    expect(describeBuild({ version: '0.1.0', label: '', commit: '' })).toBe('KK-Notes 0.1.0 · local build');
  });
});
