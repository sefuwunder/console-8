import { describe, test, expect } from 'bun:test';
import {
  STEPS, CHANNELS, PATTERN_IDS, newPattern, toggleStep, stepDur,
  swingOffset, stepTime, planBar, patternHasNotes,
  newProject, serializeProject, deserializeProject,
} from '../src/sequencer.js';

describe('pattern model', () => {
  test('new pattern is 8x16 of zeros', () => {
    const p = newPattern();
    expect(p.length).toBe(CHANNELS);
    expect(p[0].length).toBe(STEPS);
    expect(patternHasNotes(p)).toBe(false);
  });
  test('toggle cycles 0 -> 1 -> 2 -> 0', () => {
    const p = newPattern();
    expect(toggleStep(p, 0, 0)).toBe(1);
    expect(toggleStep(p, 0, 0)).toBe(2);
    expect(toggleStep(p, 0, 0)).toBe(0);
    expect(patternHasNotes(p)).toBe(false);
  });
  test('starter project has a groove on pattern A', () => {
    const pr = newProject();
    expect(patternHasNotes(pr.patterns.A)).toBe(true);
    expect(pr.patterns.A[0][0]).toBe(2); // accented kick on the one
  });
});

describe('timing math', () => {
  test('16th at 120 BPM is 125 ms', () => {
    expect(stepDur(120)).toBeCloseTo(0.125, 10);
  });
  test('16th at 60 BPM is 250 ms', () => {
    expect(stepDur(60)).toBeCloseTo(0.25, 10);
  });
  test('no swing -> grid is perfectly even', () => {
    for (let s = 0; s < STEPS; s++) expect(swingOffset(s, 0.125, 0)).toBe(0);
  });
  test('swing delays only the off-beat 16ths', () => {
    const dur = stepDur(120);
    expect(swingOffset(0, dur, 0.5)).toBe(0);
    expect(swingOffset(1, dur, 0.5)).toBeCloseTo(0.5 * dur, 10);
    expect(swingOffset(2, dur, 0.5)).toBe(0);
    expect(swingOffset(15, dur, 0.3)).toBeCloseTo(0.3 * dur, 10);
  });
  test('stepTime places steps on the grid', () => {
    expect(stepTime(0, 10.0, 120, 0)).toBeCloseTo(10.0, 10);
    expect(stepTime(4, 10.0, 120, 0)).toBeCloseTo(10.5, 10);
  });
  test('planBar is strictly increasing with 16 steps', () => {
    for (const swing of [0, 0.2, 0.5]) {
      const times = planBar(100.0, 128, swing);
      expect(times.length).toBe(16);
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThan(times[i - 1]);
      }
      // bar length is preserved: 16 sixteenths
      expect(times[15] - times[0]).toBeLessThan(16 * stepDur(128));
      expect(times[15] - times[0]).toBeGreaterThan(14 * stepDur(128));
    }
  });
});

describe('serialization', () => {
  test('round-trip preserves everything', () => {
    const p = newProject();
    p.tempo = 140;
    p.patterns.C[7][15] = 2;
    p.channels[2].eq.hf.gain = 6;
    p.channels[2].mute = true;
    p.song = ['A', 'C'];
    const q = deserializeProject(serializeProject(p));
    expect(q.tempo).toBe(140);
    expect(q.patterns.C[7][15]).toBe(2);
    expect(q.channels[2].eq.hf.gain).toBe(6);
    expect(q.channels[2].mute).toBe(true);
    expect(q.song).toEqual(['A', 'C']);
  });
  test('garbage input yields a valid default project', () => {
    for (const bad of ['not json', '{}', '[]', '{"tempo":"fast"}', '{"patterns":{"A":[[1]]}}']) {
      const p = deserializeProject(bad);
      expect(p.tempo).toBeGreaterThanOrEqual(60);
      expect(p.patterns.A.length).toBe(CHANNELS);
      expect(p.channels.length).toBe(8);
    }
  });
  test('tempo and swing are clamped', () => {
    const p = deserializeProject('{"tempo":400,"swing":5}');
    expect(p.tempo).toBe(200);
    expect(p.swing).toBe(0.6);
  });
  test('song keeps only valid pattern ids', () => {
    const p = deserializeProject('{"song":["A","Z","B","A"]}');
    expect(p.song).toEqual(['A', 'B', 'A']);
  });
  test('pattern ids are A-D', () => {
    expect(PATTERN_IDS).toEqual(['A', 'B', 'C', 'D']);
  });
});
