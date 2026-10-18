// Console-8 — pure DSP math. No DOM, no WebAudio: importable by bun test and the browser.

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-9));

/**
 * Tube-style transfer curve: asymmetric soft saturation.
 * y = tanh(drive * (x + asym * x^2)) / drive
 * - f(0) = 0, f'(0) = 1 (unity at zero)
 * - monotonic on the operating range for asym <= 0.3
 * - |y| <= 1/drive (saturates)
 * - asymmetric: f(x) != -f(-x), which is what generates even harmonics
 * The curve spans the WaveShaperNode nominal input range [-1, 1].
 */
export function tubeCurve(n = 1024, drive = 2.0, asym = 0.22) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = -1 + (2 * i) / (n - 1);
    curve[i] = Math.tanh(drive * (x + asym * x * x)) / drive;
  }
  return curve;
}

/** Map a 0..1 knob to a logarithmic parameter range. */
export function knobToLog(knob, min, max) {
  const k = Math.min(1, Math.max(0, knob));
  return min * Math.pow(max / min, k);
}

/** Map a 0..1 knob to a linear parameter range. */
export function knobToLin(knob, min, max) {
  const k = Math.min(1, Math.max(0, knob));
  return min + (max - min) * k;
}

/** Inverse of knobToLog: parameter value back to 0..1 knob position. */
export function logToKnob(value, min, max) {
  return Math.log(value / min) / Math.log(max / min);
}

/** Fader 0..1 -> gain with a console-style taper. */
export function faderToGain(v) {
  const x = Math.min(1, Math.max(0, v));
  return x * x;
}

/** Equal-power pan law. pan -1 (L) .. 1 (R) -> [leftGain, rightGain]. */
export function panToGains(pan) {
  const p = Math.min(1, Math.max(-1, pan));
  const a = ((p + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

/** SSL-style 4-band EQ defaults + knob ranges. */
export function eqDefaults() {
  return {
    in: true,
    hf:  { type: 'highshelf', freq: 8000, gain: 0, freqMin: 2000,  freqMax: 16000 },
    hmf: { type: 'peaking',   freq: 2500, gain: 0, q: 1.0, freqMin: 600, freqMax: 8000, qMin: 0.3, qMax: 3 },
    lmf: { type: 'peaking',   freq: 400,  gain: 0, q: 1.0, freqMin: 100, freqMax: 2000, qMin: 0.3, qMax: 3 },
    lf:  { type: 'lowshelf',  freq: 120,  gain: 0, freqMin: 40,   freqMax: 400 },
  };
}

export function compDefaults() {
  return { threshold: -24, ratio: 4, attack: 0.012, release: 0.2, knee: 6, makeup: 0 };
}

export function limiterDefaults() {
  return { ceiling: -1.5, release: 0.08 };
}

/** Default per-channel strip state (UI + engine params). */
export function channelDefaults() {
  return {
    eq: eqDefaults(),
    comp: compDefaults(),
    limiter: limiterDefaults(),
    pan: 0,
    fader: 0.8,
    mute: false,
    solo: false,
    invert: false,
  };
}

export function masterDefaults() {
  return { tubeDrive: 0.25, tubeMix: 0.7, fader: 0.85, limCeiling: -1.0 };
}
