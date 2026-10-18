// Console-8 — pure tape-machine logic. No DOM, no WebAudio: importable by bun test and the browser.
import { channelDefaults, masterDefaults } from './dsp.js';
import { encodeWav16, decodeWav16 } from './wav.js';

export const TRACKS = 8;
export const PROJECT_VERSION = 2;

export const ST_STOPPED = 'stopped';
export const ST_PLAYING = 'playing';
export const ST_RECORDING = 'recording';

// ---------------- transport state machine ----------------
export class Transport {
  constructor() {
    this.state = ST_STOPPED;
    this.position = 0; // seconds of tape
    this.armed = new Set(); // track indices
    this.recStart = null;
  }
  toggleArm(i) {
    if (this.armed.has(i)) this.armed.delete(i);
    else this.armed.add(i);
  }
  /** PLAY: start rolling; during recording it punches out (keeps rolling). */
  play() {
    if (this.state === ST_RECORDING) {
      const punch = { start: this.recStart, end: this.position };
      this.recStart = null;
      this.state = ST_PLAYING;
      return { ok: true, punchedOut: punch };
    }
    if (this.state === ST_STOPPED) {
      this.state = ST_PLAYING;
      return { ok: true };
    }
    return { ok: false, reason: 'already playing' };
  }
  /** REC: start recording from a stop, or punch in while playing. Needs an armed track. */
  rec() {
    if (this.state === ST_RECORDING) return { ok: false, reason: 'already recording' };
    if (this.armed.size === 0) return { ok: false, reason: 'no track armed' };
    const punchedIn = this.state === ST_PLAYING;
    this.recStart = this.position;
    this.state = ST_RECORDING;
    return { ok: true, start: this.recStart, punchedIn, tracks: [...this.armed] };
  }
  /** STOP: halt; if recording, returns the take bounds for finalization. */
  stop() {
    let take = null;
    if (this.state === ST_RECORDING) {
      take = { start: this.recStart, end: this.position, tracks: [...this.armed] };
    }
    this.recStart = null;
    this.state = ST_STOPPED;
    return { ok: true, take };
  }
  /** RTZ: return tape to zero. Refused while recording. */
  rtz() {
    if (this.state === ST_RECORDING) return { ok: false, reason: 'recording' };
    this.position = 0;
    return { ok: true };
  }
  /** Click-to-seek. Refused while recording. */
  seek(t) {
    if (this.state === ST_RECORDING) return { ok: false, reason: 'recording' };
    this.position = Math.max(0, t);
    return { ok: true };
  }
  /** Logical advance (the engine drives this from the audio clock). */
  advance(dt, rate = 1) {
    if (this.state !== ST_STOPPED) this.position += Math.max(0, dt) * rate;
  }
}

// ---------------- clips ----------------
let clipSeq = 1;

export function newClip(track, startOffset, name = '') {
  return {
    id: 'c' + clipSeq++,
    track,
    name: name || 'take',
    startOffset: Math.max(0, startOffset),
    duration: 0,
    pcm: null, // { sampleRate, channels, data: Float32Array interleaved } | null
  };
}

export const clipEnd = (c) => c.startOffset + c.duration;

/** Clip on a track sounding at time t (start inclusive, end exclusive). */
export function clipAtTime(clips, track, t) {
  return clips.find((c) => c.track === track && t >= c.startOffset && t < clipEnd(c)) || null;
}

export function allClips(project) {
  return project.tracks.flatMap((t) => t.clips);
}

/** End of the last clip on the whole tape; 0 when empty. */
export function mixEnd(project) {
  let end = 0;
  for (const c of allClips(project)) end = Math.max(end, clipEnd(c));
  return end;
}

/** Peak absolute sample of a pcm block; 0 when empty. */
export function pcmPeak(pcm) {
  if (!pcm || !pcm.data || pcm.data.length === 0) return 0;
  let pk = 0;
  const d = pcm.data;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > pk) pk = a;
  }
  return pk;
}

// ---------------- base64 (manual: no Buffer, no btoa) ----------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function u8ToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i], b = i + 1 < u8.length ? u8[i + 1] : 0, c = i + 2 < u8.length ? u8[i + 2] : 0;
    s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < u8.length ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < u8.length ? B64[c & 63] : '=');
  }
  return s;
}

export function b64ToU8(s) {
  if (typeof s !== 'string' || s.length % 4 !== 0) throw new Error('bad base64 length');
  const out = [];
  for (let i = 0; i < s.length; i += 4) {
    const v = (ch) => {
      if (ch === '=') return 0;
      const k = B64.indexOf(ch);
      if (k < 0) throw new Error('bad base64 char');
      return k;
    };
    const a = v(s[i]), b = v(s[i + 1]), c = v(s[i + 2]), d = v(s[i + 3]);
    out.push((a << 2) | (b >> 4));
    if (s[i + 2] !== '=') out.push(((b & 15) << 4) | (c >> 2));
    if (s[i + 3] !== '=') out.push(((c & 3) << 6) | d);
  }
  return new Uint8Array(out);
}

// ---------------- clip serialization ----------------
export function clipToJson(clip, includeAudio = true) {
  const j = {
    id: clip.id, track: clip.track, name: clip.name,
    startOffset: clip.startOffset, duration: clip.duration,
    wav: null,
  };
  if (includeAudio && clip.pcm) j.wav = u8ToB64(encodeWav16(clip.pcm));
  return j;
}

/** Never throws: bad entries become null (skipped) or audio-less clips. */
export function clipFromJson(j) {
  if (!j || typeof j !== 'object') return null;
  const track = j.track | 0;
  if (track < 0 || track >= TRACKS) return null;
  const clip = {
    id: String(j.id ?? ''),
    track,
    name: String(j.name ?? 'take').slice(0, 48),
    startOffset: Math.max(0, +j.startOffset || 0),
    duration: Math.max(0, +j.duration || 0),
    pcm: null,
  };
  if (typeof j.wav === 'string' && j.wav.length > 0) {
    try {
      clip.pcm = decodeWav16(b64ToU8(j.wav));
      clip.duration = clip.pcm.data.length / clip.pcm.channels / clip.pcm.sampleRate;
    } catch {
      clip.pcm = null; // keep the shell so the user sees the missing audio
    }
  }
  const m = /c(\d+)$/.exec(clip.id);
  if (m) clipSeq = Math.max(clipSeq, +m[1] + 1);
  return clip;
}

// ---------------- varispeed ----------------
export const VS_MIN = 0.5;
export const VS_MAX = 1.5;

/** 0..1 knob -> 0.5..1.5 playback rate (1.0 at center). */
export function varispeedToRate(knob) {
  const k = Math.min(1, Math.max(0, knob));
  return VS_MIN + (VS_MAX - VS_MIN) * k;
}

export function rateToVarispeed(rate) {
  const r = Math.min(VS_MAX, Math.max(VS_MIN, rate));
  return (r - VS_MIN) / (VS_MAX - VS_MIN);
}

// ---------------- timecode ----------------
export function fmtCounter(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return String(m).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

// ---------------- project ----------------
export function newTrack(i) {
  return { name: 'TRACK ' + (i + 1), input: 'mic', clips: [] };
}

export function newProject() {
  return {
    version: PROJECT_VERSION,
    varispeed: 1.0,
    tracks: Array.from({ length: TRACKS }, (_, i) => newTrack(i)),
    channels: Array.from({ length: TRACKS }, () => channelDefaults()),
    master: masterDefaults(),
  };
}

export function serializeProject(p, includeAudio = true) {
  return JSON.stringify({
    version: PROJECT_VERSION,
    varispeed: p.varispeed,
    tracks: p.tracks.map((t) => ({
      name: t.name,
      input: t.input,
      clips: t.clips.map((c) => clipToJson(c, includeAudio)),
    })),
    channels: p.channels,
    master: p.master,
  });
}

/** Autosave: settings + clip layout, never audio (quota). */
export function serializeAutosave(p) {
  return serializeProject(p, false);
}

/** Parse + validate. Never throws; unknown/old versions yield a fresh project. */
export function deserializeProject(json) {
  const fresh = newProject();
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return fresh;
  }
  if (!obj || typeof obj !== 'object' || obj.version !== PROJECT_VERSION) return fresh;
  const out = { ...fresh };
  if (typeof obj.varispeed === 'number') {
    out.varispeed = Math.min(VS_MAX, Math.max(VS_MIN, obj.varispeed));
  }
  if (Array.isArray(obj.tracks)) {
    out.tracks = fresh.tracks.map((def, i) => {
      const t = obj.tracks[i];
      if (!t || typeof t !== 'object') return def;
      const clips = Array.isArray(t.clips) ? t.clips.map(clipFromJson).filter(Boolean) : [];
      return {
        name: typeof t.name === 'string' ? t.name.slice(0, 24) : def.name,
        input: t.input === 'file' ? 'file' : 'mic',
        clips,
      };
    });
  }
  if (Array.isArray(obj.channels)) {
    out.channels = fresh.channels.map((def, i) => ({ ...def, ...(obj.channels[i] || {}) }));
  }
  if (obj.master && typeof obj.master === 'object') out.master = { ...fresh.master, ...obj.master };
  return out;
}
