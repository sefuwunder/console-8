import { describe, test, expect } from 'bun:test';
import { encodeWav16, decodeWav16 } from '../src/wav.js';

function sinePcm(sr = 44100, ch = 2, secs = 0.25, freq = 440) {
  const frames = Math.floor(sr * secs);
  const data = new Float32Array(frames * ch);
  for (let f = 0; f < frames; f++) {
    const v = 0.7 * Math.sin((2 * Math.PI * freq * f) / sr);
    for (let c = 0; c < ch; c++) data[f * ch + c] = v * (c === 0 ? 1 : 0.5);
  }
  return { sampleRate: sr, channels: ch, data };
}

describe('WAV encode', () => {
  test('header is a valid RIFF/WAVE/fmt/data layout', () => {
    const u8 = encodeWav16(sinePcm());
    const v = new DataView(u8.buffer);
    const rs = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    expect(rs(0)).toBe('RIFF');
    expect(rs(8)).toBe('WAVE');
    expect(rs(12)).toBe('fmt ');
    expect(rs(36)).toBe('data');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(2); // channels
    expect(v.getUint32(24, true)).toBe(44100); // sample rate
    expect(v.getUint16(34, true)).toBe(16); // bits
    const dataBytes = v.getUint32(40, true);
    expect(dataBytes).toBe(u8.length - 44);
    expect(v.getUint32(4, true)).toBe(36 + dataBytes); // RIFF size
  });
  test('byte rate and block align are consistent', () => {
    const u8 = encodeWav16(sinePcm(48000, 1, 0.1));
    const v = new DataView(u8.buffer);
    expect(v.getUint32(28, true)).toBe(48000 * 1 * 2);
    expect(v.getUint16(32, true)).toBe(2);
  });
  test('clips out-of-range samples', () => {
    const pcm = { sampleRate: 44100, channels: 1, data: new Float32Array([2, -2, 0.5]) };
    const u8 = encodeWav16(pcm);
    const v = new DataView(u8.buffer);
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(46, true)).toBe(-32768);
  });
});

describe('WAV round-trip', () => {
  test('decode(encode(x)) ~= x within 16-bit quantization', () => {
    const pcm = sinePcm();
    const back = decodeWav16(encodeWav16(pcm));
    expect(back.sampleRate).toBe(pcm.sampleRate);
    expect(back.channels).toBe(pcm.channels);
    expect(back.data.length).toBe(pcm.data.length);
    let maxErr = 0;
    for (let i = 0; i < back.data.length; i += 13) {
      maxErr = Math.max(maxErr, Math.abs(back.data[i] - pcm.data[i]));
    }
    expect(maxErr).toBeLessThan(1.5 / 32768 + 1e-9);
  });
  test('mono round-trips too', () => {
    const pcm = sinePcm(22050, 1, 0.1, 220);
    const back = decodeWav16(encodeWav16(pcm));
    expect(back.channels).toBe(1);
    expect(back.sampleRate).toBe(22050);
  });
});

describe('WAV decode validation', () => {
  test('rejects non-WAV bytes', () => {
    expect(() => decodeWav16(new Uint8Array(100))).toThrow();
    expect(() => decodeWav16(new Uint8Array([1, 2, 3]))).toThrow();
  });
  test('rejects a header claiming non-PCM', () => {
    const u8 = encodeWav16(sinePcm());
    const v = new DataView(u8.buffer);
    v.setUint16(20, 3, true); // float format tag
    expect(() => decodeWav16(u8)).toThrow();
  });
});
