import { describe, test, expect } from 'bun:test';
import {
  dbToGain, gainToDb, tubeCurve, knobToLog, knobToLin, logToKnob,
  faderToGain, panToGains, midiToFreq, midiToName, eqDefaults, compDefaults,
  limiterDefaults, channelDefaults, masterDefaults, SOURCES,
} from '../src/dsp.js';

describe('db/gain', () => {
  test('0 dB is unity and round-trips', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 10);
    expect(gainToDb(1)).toBeCloseTo(0, 10);
    expect(gainToDb(dbToGain(-12))).toBeCloseTo(-12, 8);
  });
  test('-6 dB halves amplitude', () => {
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 3);
  });
});

describe('tubeCurve', () => {
  const c = tubeCurve(1024, 2.0, 0.22);
  const at = (x) => {
    const i = Math.round(((x + 1) / 2) * (c.length - 1));
    return c[Math.min(c.length - 1, Math.max(0, i))];
  };
  test('has the requested length', () => {
    expect(c.length).toBe(1024);
  });
  test('zero maps to zero', () => {
    expect(Math.abs(at(0))).toBeLessThan(0.01);
  });
  test('unity slope at zero (derivative ~1)', () => {
    const d = (at(0.02) - at(-0.02)) / 0.04;
    expect(d).toBeCloseTo(1, 1);
  });
  test('monotonic increasing over the operating range', () => {
    let prev = -Infinity;
    for (let x = -1; x <= 1; x += 0.02) {
      const y = at(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = y;
    }
  });
  test('saturates below 1.2x', () => {
    expect(Math.abs(at(1))).toBeLessThan(1.2);
    expect(Math.abs(at(-1))).toBeLessThan(1.2);
  });
  test('asymmetric: not odd-symmetric (even harmonics)', () => {
    expect(Math.abs(at(0.8) + at(-0.8))).toBeGreaterThan(0.01);
  });
  test('drive increases saturation', () => {
    const soft = tubeCurve(512, 1.0, 0.22);
    const hard = tubeCurve(512, 4.0, 0.22);
    const pick = (arr, x) => arr[Math.round(((x + 1) / 2) * (arr.length - 1))];
    // harder drive -> output at x=1 is a smaller fraction of linear
    expect(pick(hard, 1) / 1).toBeLessThan(pick(soft, 1) / 1);
  });
});

describe('knob mappings', () => {
  test('knobToLog hits endpoints and geometric midpoint', () => {
    expect(knobToLog(0, 20, 20000)).toBeCloseTo(20, 6);
    expect(knobToLog(1, 20, 20000)).toBeCloseTo(20000, 6);
    expect(knobToLog(0.5, 20, 20000)).toBeCloseTo(Math.sqrt(20 * 20000), 3);
  });
  test('logToKnob inverts knobToLog', () => {
    expect(logToKnob(knobToLog(0.37, 40, 400), 40, 400)).toBeCloseTo(0.37, 8);
  });
  test('knobToLin is linear', () => {
    expect(knobToLin(0.25, 0, 100)).toBeCloseTo(25, 8);
  });
  test('knobs clamp outside 0..1', () => {
    expect(knobToLog(-1, 10, 100)).toBeCloseTo(10, 6);
    expect(knobToLin(2, 0, 5)).toBeCloseTo(5, 8);
  });
});

describe('fader and pan', () => {
  test('fader endpoints and monotonic taper', () => {
    expect(faderToGain(0)).toBe(0);
    expect(faderToGain(1)).toBe(1);
    let prev = -1;
    for (let v = 0; v <= 1; v += 0.05) {
      const g = faderToGain(v);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });
  test('equal-power pan law', () => {
    const [l, r] = panToGains(0);
    expect(l).toBeCloseTo(Math.SQRT1_2, 8);
    expect(r).toBeCloseTo(Math.SQRT1_2, 8);
    expect(panToGains(-1)[0]).toBeCloseTo(1, 8);
    expect(panToGains(-1)[1]).toBeCloseTo(0, 8);
    expect(panToGains(1)[0]).toBeCloseTo(0, 8);
    expect(panToGains(1)[1]).toBeCloseTo(1, 8);
  });
  test('pan preserves total power', () => {
    for (const p of [-0.7, -0.2, 0.3, 0.9]) {
      const [l, r] = panToGains(p);
      expect(l * l + r * r).toBeCloseTo(1, 8);
    }
  });
});

describe('pitch helpers', () => {
  test('A4 is 440 Hz', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
  });
  test('octave doubles', () => {
    expect(midiToFreq(81) / midiToFreq(69)).toBeCloseTo(2, 8);
  });
  test('note names', () => {
    expect(midiToName(60)).toBe('C4');
    expect(midiToName(69)).toBe('A4');
    expect(midiToName(36)).toBe('C2');
  });
});

describe('defaults', () => {
  test('EQ has 4 SSL-style bands', () => {
    const eq = eqDefaults();
    expect(eq.hf.type).toBe('highshelf');
    expect(eq.lf.type).toBe('lowshelf');
    expect(eq.hmf.type).toBe('peaking');
    expect(eq.lmf.type).toBe('peaking');
    expect(eq.hmf.q).toBeGreaterThan(0);
  });
  test('channel defaults cover 8 sources', () => {
    expect(SOURCES.length).toBe(9);
    for (let i = 0; i < 8; i++) {
      const c = channelDefaults(i);
      expect(SOURCES).toContain(c.source);
      expect(c.fader).toBeGreaterThan(0);
    }
  });
  test('master defaults are subtle', () => {
    const m = masterDefaults();
    expect(m.tubeDrive).toBeLessThanOrEqual(0.5);
    expect(m.tubeMix).toBeGreaterThan(0.5);
  });
  test('limiter default ceiling is below 0 dBFS', () => {
    expect(limiterDefaults().ceiling).toBeLessThan(0);
  });
});
