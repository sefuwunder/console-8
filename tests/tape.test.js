import { describe, test, expect } from 'bun:test';
import {
  TRACKS, ST_STOPPED, ST_PLAYING, ST_RECORDING, Transport,
  newClip, clipEnd, clipAtTime, allClips, mixEnd, pcmPeak,
  u8ToB64, b64ToU8, clipToJson, clipFromJson,
  VS_MIN, VS_MAX, varispeedToRate, rateToVarispeed, fmtCounter,
  newProject, serializeProject, serializeAutosave, deserializeProject,
} from '../src/tape.js';
import { encodeWav16 } from '../src/wav.js';

function fakePcm(sr = 44100, ch = 1, secs = 1) {
  const n = Math.floor(sr * secs) * ch;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
  return { sampleRate: sr, channels: ch, data };
}

describe('transport state machine', () => {
  test('starts stopped at zero', () => {
    const t = new Transport();
    expect(t.state).toBe(ST_STOPPED);
    expect(t.position).toBe(0);
  });
  test('play from stop -> playing; stop -> stopped', () => {
    const t = new Transport();
    expect(t.play().ok).toBe(true);
    expect(t.state).toBe(ST_PLAYING);
    expect(t.stop().ok).toBe(true);
    expect(t.state).toBe(ST_STOPPED);
  });
  test('REC with no armed track is refused', () => {
    const t = new Transport();
    const r = t.rec();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no track armed/);
    expect(t.state).toBe(ST_STOPPED);
  });
  test('REC from stop with armed track -> recording', () => {
    const t = new Transport();
    t.position = 3.5;
    t.toggleArm(2);
    const r = t.rec();
    expect(r.ok).toBe(true);
    expect(r.start).toBeCloseTo(3.5, 10);
    expect(t.state).toBe(ST_RECORDING);
  });
  test('REC while playing punches in', () => {
    const t = new Transport();
    t.position = 10;
    t.play();
    t.toggleArm(0);
    const r = t.rec();
    expect(r.ok).toBe(true);
    expect(r.punchedIn).toBe(true);
    expect(t.state).toBe(ST_RECORDING);
  });
  test('PLAY while recording punches out and keeps rolling', () => {
    const t = new Transport();
    t.toggleArm(1);
    t.rec();
    t.position = 7.25;
    const r = t.play();
    expect(r.ok).toBe(true);
    expect(r.punchedOut.start).toBeCloseTo(0, 10);
    expect(r.punchedOut.end).toBeCloseTo(7.25, 10);
    expect(t.state).toBe(ST_PLAYING);
  });
  test('STOP while recording returns the take bounds', () => {
    const t = new Transport();
    t.position = 2;
    t.toggleArm(4);
    t.rec();
    t.position = 5.5;
    const r = t.stop();
    expect(r.take.start).toBeCloseTo(2, 10);
    expect(r.take.end).toBeCloseTo(5.5, 10);
    expect(r.take.tracks).toEqual([4]);
    expect(t.state).toBe(ST_STOPPED);
  });
  test('RTZ zeroes the counter, refused while recording', () => {
    const t = new Transport();
    t.position = 42;
    expect(t.rtz().ok).toBe(true);
    expect(t.position).toBe(0);
    t.toggleArm(0);
    t.rec();
    expect(t.rtz().ok).toBe(false);
    expect(t.position).toBe(0); // unchanged
  });
  test('seek moves the head, refused while recording, never negative', () => {
    const t = new Transport();
    expect(t.seek(12.5).ok).toBe(true);
    expect(t.position).toBeCloseTo(12.5, 10);
    expect(t.seek(-3).ok).toBe(true);
    expect(t.position).toBe(0);
    t.toggleArm(0);
    t.rec();
    expect(t.seek(5).ok).toBe(false);
  });
  test('advance moves only while rolling, scaled by rate', () => {
    const t = new Transport();
    t.advance(1);
    expect(t.position).toBe(0);
    t.play();
    t.advance(2, 1.5);
    expect(t.position).toBeCloseTo(3, 10);
  });
});

describe('clip model', () => {
  test('clip at offset 2.5 is active at 2.5, done at end', () => {
    const c = newClip(3, 2.5, 'vox');
    c.duration = 4;
    expect(clipEnd(c)).toBeCloseTo(6.5, 10);
    expect(clipAtTime([c], 3, 2.5)).toBe(c);
    expect(clipAtTime([c], 3, 6.499)).toBe(c);
    expect(clipAtTime([c], 3, 6.5)).toBe(null);
    expect(clipAtTime([c], 3, 2.499)).toBe(null);
    expect(clipAtTime([c], 2, 3)).toBe(null); // wrong track
  });
  test('mixEnd is the latest clip end, 0 when empty', () => {
    const p = newProject();
    expect(mixEnd(p)).toBe(0);
    const a = newClip(0, 1); a.duration = 2;
    const b = newClip(5, 10); b.duration = 3;
    p.tracks[0].clips.push(a); p.tracks[5].clips.push(b);
    expect(allClips(p).length).toBe(2);
    expect(mixEnd(p)).toBeCloseTo(13, 10);
  });
  test('pcmPeak measures signal', () => {
    expect(pcmPeak(null)).toBe(0);
    const pcm = fakePcm();
    expect(pcmPeak(pcm)).toBeGreaterThan(0.4);
  });
});

describe('base64', () => {
  test('round-trips arbitrary bytes', () => {
    const u8 = new Uint8Array([0, 1, 2, 250, 255, 16, 32, 64, 128, 7, 99]);
    expect(b64ToU8(u8ToB64(u8))).toEqual(u8);
  });
  test('round-trips a WAV blob', () => {
    const wav = encodeWav16(fakePcm(22050, 2, 0.1));
    expect(b64ToU8(u8ToB64(wav))).toEqual(wav);
  });
  test('rejects garbage', () => {
    expect(() => b64ToU8('!!!')).toThrow();
    expect(() => b64ToU8('abc')).toThrow();
  });
});

describe('clip serialization', () => {
  test('round-trip with audio preserves pcm', () => {
    const c = newClip(2, 2.5, 'gtr');
    c.pcm = fakePcm();
    c.duration = 1;
    const back = clipFromJson(clipToJson(c, true));
    expect(back.track).toBe(2);
    expect(back.name).toBe('gtr');
    expect(back.startOffset).toBeCloseTo(2.5, 10);
    expect(back.pcm.sampleRate).toBe(44100);
    // 16-bit quantization tolerance
    let maxErr = 0;
    for (let i = 0; i < back.pcm.data.length; i += 97) {
      maxErr = Math.max(maxErr, Math.abs(back.pcm.data[i] - c.pcm.data[i]));
    }
    // asymmetric full-scale encode (±1 -> 32767/-32768) vs /32768 decode:
    // worst-case error is 1.5 LSB
    expect(maxErr).toBeLessThan(1.5 / 32768 + 1e-9);
  });
  test('audio-excluded json keeps layout only', () => {
    const c = newClip(0, 1, 'x');
    c.pcm = fakePcm();
    c.duration = 1;
    const back = clipFromJson(clipToJson(c, false));
    expect(back.pcm).toBe(null);
    expect(back.startOffset).toBe(1);
    expect(back.name).toBe('x');
  });
  test('bad entries become null', () => {
    expect(clipFromJson(null)).toBe(null);
    expect(clipFromJson({ track: 99 })).toBe(null);
    expect(clipFromJson({ track: -1 })).toBe(null);
  });
});

describe('varispeed', () => {
  test('knob maps 0..1 to 0.5..1.5 with center at 1.0', () => {
    expect(varispeedToRate(0)).toBeCloseTo(VS_MIN, 10);
    expect(varispeedToRate(1)).toBeCloseTo(VS_MAX, 10);
    expect(varispeedToRate(0.5)).toBeCloseTo(1.0, 10);
  });
  test('rate inverts the knob', () => {
    expect(rateToVarispeed(varispeedToRate(0.37))).toBeCloseTo(0.37, 8);
  });
  test('counter formats mm:ss', () => {
    expect(fmtCounter(0)).toBe('00:00');
    expect(fmtCounter(65)).toBe('01:05');
    expect(fmtCounter(600)).toBe('10:00');
  });
});

describe('project', () => {
  test('fresh project: 8 tracks, strips, master, varispeed 1', () => {
    const p = newProject();
    expect(p.tracks.length).toBe(TRACKS);
    expect(p.channels.length).toBe(8);
    expect(p.varispeed).toBe(1);
    expect(p.master.tubeDrive).toBeLessThanOrEqual(0.5);
  });
  test('download round-trip keeps clips + audio', () => {
    const p = newProject();
    const c = newClip(1, 2.5, 'vox');
    c.pcm = fakePcm(44100, 1, 0.2);
    c.duration = 0.2;
    p.tracks[1].clips.push(c);
    p.tracks[1].input = 'file';
    p.channels[3].mute = true;
    const q = deserializeProject(serializeProject(p, true));
    expect(q.tracks[1].clips.length).toBe(1);
    expect(q.tracks[1].clips[0].pcm).not.toBe(null);
    expect(q.tracks[1].clips[0].startOffset).toBeCloseTo(2.5, 10);
    expect(q.tracks[1].input).toBe('file');
    expect(q.channels[3].mute).toBe(true);
  });
  test('autosave keeps layout, drops audio', () => {
    const p = newProject();
    const c = newClip(0, 4, 'drums');
    c.pcm = fakePcm(44100, 1, 0.2);
    c.duration = 0.2;
    p.tracks[0].clips.push(c);
    const q = deserializeProject(serializeAutosave(p));
    expect(q.tracks[0].clips.length).toBe(1);
    expect(q.tracks[0].clips[0].pcm).toBe(null);
    expect(q.tracks[0].clips[0].startOffset).toBe(4);
  });
  test('garbage and v1 projects yield fresh defaults', () => {
    for (const bad of ['not json', '{}', '{"version":1,"patterns":{}}', '{"version":99}']) {
      const p = deserializeProject(bad);
      expect(p.tracks.length).toBe(TRACKS);
      expect(p.channels.length).toBe(8);
      expect(p.varispeed).toBe(1);
    }
  });
  test('varispeed is clamped on load', () => {
    expect(deserializeProject('{"version":2,"varispeed":9}').varispeed).toBe(VS_MAX);
    expect(deserializeProject('{"version":2,"varispeed":-2}').varispeed).toBe(VS_MIN);
  });
});
