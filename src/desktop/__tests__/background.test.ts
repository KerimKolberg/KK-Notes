import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../../document/operations';
import { useDocumentStore } from '../../document/store';
import mainConfig from '../../../src-tauri/tauri.conf.json?raw';
import windowsConfig from '../../../src-tauri/tauri.windows.conf.json?raw';

const saved: unknown[] = [];
vi.mock('../fileService', () => ({
  saveDraft: async (doc: unknown) => {
    saved.push(doc);
  },
}));
const recorder = { status: 'idle' as string, stopped: 0 };
vi.mock('../../audio/recorder', () => ({
  useRecorderStore: { getState: () => ({ status: recorder.status }) },
  stopRecording: async () => {
    recorder.stopped += 1;
    recorder.status = 'idle';
  },
}));

const { closesToTray, prepareToQuit, useBackgroundStore } = await import('../background');

beforeEach(() => {
  saved.length = 0;
  recorder.status = 'idle';
  recorder.stopped = 0;
  useDocumentStore.getState().loadDocument(createDocument(1, 'Lecture'), '/Lecture.notex');
});

describe('quitting from the tray', () => {
  it('leaves a clean note alone', async () => {
    await prepareToQuit();
    expect(saved).toHaveLength(0);
    expect(recorder.stopped).toBe(0);
  });

  it('keeps unsaved work in the draft', async () => {
    useDocumentStore.getState().setTitle('Lecture, edited');
    await prepareToQuit();
    expect(saved).toHaveLength(1);
  });

  it('finishes a recording in progress first', async () => {
    recorder.status = 'recording';
    await prepareToQuit();
    expect(recorder.stopped).toBe(1);
  });
});

describe('closing to the tray', () => {
  it('only when the shell says it is on', () => {
    useBackgroundStore.setState({ status: null });
    expect(closesToTray()).toBe(false);
    useBackgroundStore.setState({ status: { supported: true, openAtLogin: false, startInTray: false, closeToTray: true } });
    expect(closesToTray()).toBe(true);
  });
});

describe('the Windows window config', () => {

  it('is the main config\'s window, created hidden (the shell shows it unless it starts in the tray)', () => {
    const main = JSON.parse(mainConfig).app.windows;
    const windows = JSON.parse(windowsConfig).app.windows;
    expect(windows).toHaveLength(main.length);
    expect(windows[0].visible).toBe(false);
    // Made in `setup` instead, so its web view keeps its data in the folder named like the app (`data_dir.rs`).
    expect(windows[0].create).toBe(false);
    const { visible: _visible, create: _create, ...rest } = windows[0];
    void _visible;
    void _create;
    expect(rest).toEqual(main[0]);
  });
});
