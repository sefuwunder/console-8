// Console-8 — pure sequencer logic. No DOM, no WebAudio.
import { channelDefaults, masterDefaults } from './dsp.js';

export const STEPS = 16;
export const CHANNELS = 8;
export const PATTERN_IDS = ['A', 'B', 'C', 'D'];

// Step values: 0 = off, 1 = on, 2 = accent
export function newPattern() {
  return Array.from({ length: CHANNELS }, () => new Array(STEPS).fill(0));
}

/** Cycle a step 0 -> 1 -> 2 -> 0. Returns the new value. */
export function toggleStep(pattern, ch, step) {
  pattern[ch][step] = (pattern[ch][step] + 1) % 3;
  return pattern[ch][step];
}

/** Seconds per 16th note. */
export function stepDur(bpm) {
  return 60 / bpm / 4;
}

/**
 * Swing delays the off-beat 16ths (odd steps). swing 0..1, where 1 would
 * push the off-beat all the way to the next 16th.
 */
export function swingOffset(step, dur, swing) {
  return step % 2 === 1 ? swing * dur : 0;
}

/** Absolute time of a step within a bar starting at barStart. */
export function stepTime(step, barStart, bpm, swing) {
  const dur = stepDur(bpm);
  return barStart + step * dur + swingOffset(step, dur, swing);
}

/** Times for a full bar of 16 steps. Strictly increasing by construction. */
export function planBar(barStart, bpm, swing) {
  const out = [];
  for (let s = 0; s < STEPS; s++) out.push(stepTime(s, barStart, bpm, swing));
  return out;
}

export function patternHasNotes(pattern) {
  return pattern.some((row) => row.some((v) => v > 0));
}

export function newProject() {
  const patterns = {};
  for (const id of PATTERN_IDS) patterns[id] = newPattern();
  // starter groove on pattern A: four-on-floor kick, backbeat snare, hats
  const A = patterns.A;
  for (let s = 0; s < STEPS; s += 4) A[0][s] = 2;          // kick
  A[1][4] = 2; A[1][12] = 2;                                // snare
  for (let s = 0; s < STEPS; s += 2) A[2][s] = 1;           // closed hats
  A[3][14] = 1;                                             // open hat pickup
  A[4][0] = 1; A[4][7] = 1; A[4][10] = 1;                    // bass
  A[5][0] = 1; A[5][8] = 1;                                 // keys
  return {
    version: 1,
    tempo: 124,
    swing: 0.08,
    patterns,
    song: ['A', 'A', 'B', 'A'],
    songMode: false,
    currentPattern: 'A',
    channels: Array.from({ length: CHANNELS }, (_, i) => channelDefaults(i)),
    master: masterDefaults(),
  };
}

export function serializeProject(p) {
  return JSON.stringify(p);
}

/** Parse + validate, merging missing pieces with defaults. Never throws. */
export function deserializeProject(json) {
  const fresh = newProject();
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return fresh;
  }
  if (!obj || typeof obj !== 'object') return fresh;
  const out = { ...fresh };
  if (typeof obj.tempo === 'number') out.tempo = Math.min(200, Math.max(60, obj.tempo));
  if (typeof obj.swing === 'number') out.swing = Math.min(0.6, Math.max(0, obj.swing));
  if (obj.patterns && typeof obj.patterns === 'object') {
    for (const id of PATTERN_IDS) {
      const p = obj.patterns[id];
      if (Array.isArray(p) && p.length === CHANNELS && p.every((r) => Array.isArray(r) && r.length === STEPS)) {
        out.patterns[id] = p.map((r) => r.map((v) => (v === 1 || v === 2 ? v : 0)));
      }
    }
  }
  if (Array.isArray(obj.song)) out.song = obj.song.filter((id) => PATTERN_IDS.includes(id)).slice(0, 64);
  if (typeof obj.songMode === 'boolean') out.songMode = obj.songMode;
  if (PATTERN_IDS.includes(obj.currentPattern)) out.currentPattern = obj.currentPattern;
  if (Array.isArray(obj.channels)) {
    out.channels = fresh.channels.map((def, i) => ({ ...def, ...(obj.channels[i] || {}) }));
  }
  if (obj.master && typeof obj.master === 'object') out.master = { ...fresh.master, ...obj.master };
  return out;
}
