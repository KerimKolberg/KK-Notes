import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notePenIgnored, notePenStroke, resetPenTrouble, subscribePenTrouble } from '../penTrouble';

describe('saying why the pen wrote nothing', () => {
  let said: string[] = [];
  let stop: () => void = () => {};
  beforeEach(() => {
    resetPenTrouble();
    said = [];
    stop = subscribePenTrouble((m) => said.push(m));
  });
  afterEach(() => stop());

  it('says so when the side button turns writing into erasing nothing, twice in a row', () => {
    notePenStroke('pen', 'eraser-stroke', true, false);
    expect(said).toHaveLength(0);
    notePenStroke('pen', 'eraser-stroke', true, false);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/side button is held/);
  });

  it('says nothing when the button is used to erase something on purpose', () => {
    notePenStroke('pen', 'eraser-stroke', true, true);
    notePenStroke('pen', 'eraser-stroke', true, true);
    notePenStroke('pen', 'eraser-stroke', true, false);
    expect(said).toHaveLength(0);
  });

  it('starts counting again after a stroke that wrote', () => {
    notePenStroke('pen', 'eraser-stroke', true, false);
    notePenStroke('pen', 'pen', false, null);
    notePenStroke('pen', 'eraser-stroke', true, false);
    expect(said).toHaveLength(0);
  });

  it('says nothing for the eraser chosen on the toolbar', () => {
    notePenStroke('eraser-stroke', 'eraser-stroke', false, false);
    notePenStroke('eraser-stroke', 'eraser-stroke', false, false);
    expect(said).toHaveLength(0);
  });

  it('says so at once when a button no tool is set for stops the pen', () => {
    notePenIgnored(2);
    expect(said[0]).toMatch(/buttons 2/);
  });
});
