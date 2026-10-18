// Console-8 — 16-bit WAV encode/decode. Pure: no DOM, no WebAudio.

/**
 * Encode interleaved float PCM to 16-bit PCM WAV.
 * pcm: { sampleRate, channels, data: Float32Array (interleaved) }
 * Returns Uint8Array with a 44-byte header.
 */
export function encodeWav16(pcm) {
  const { sampleRate, channels, data } = pcm;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('bad sampleRate');
  if (!Number.isInteger(channels) || channels < 1 || channels > 32) throw new Error('bad channels');
  const frames = Math.floor(data.length / channels);
  const bytes = frames * channels * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const wstr = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM format
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true); // byte rate
  v.setUint16(32, channels * 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  wstr(36, 'data');
  v.setUint32(40, bytes, true);
  for (let i = 0; i < frames * channels; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    // asymmetric clamp: +1 maps to 32767, -1 to -32768
    v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

/**
 * Decode a 16-bit PCM WAV produced by encodeWav16 (tolerates extra chunks).
 * Returns { sampleRate, channels, data: Float32Array interleaved }.
 * Throws on anything that is not 16-bit PCM.
 */
export function decodeWav16(u8) {
  if (!(u8 instanceof Uint8Array) || u8.length < 44) throw new Error('too short');
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const rs = (o) =>
    String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (rs(0) !== 'RIFF' || rs(8) !== 'WAVE') throw new Error('not a WAV');
  if (rs(12) !== 'fmt ') throw new Error('bad fmt chunk');
  if (v.getUint16(20, true) !== 1) throw new Error('not PCM');
  const channels = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  if (v.getUint16(34, true) !== 16) throw new Error('not 16-bit');
  if (channels < 1 || channels > 32 || sampleRate <= 0) throw new Error('bad format');
  // locate the data chunk (skip any extras like LIST)
  let off = 36;
  for (;;) {
    if (off + 8 > u8.length) throw new Error('no data chunk');
    if (rs(off) === 'data') break;
    off += 8 + v.getUint32(off + 4, true);
  }
  const bytes = v.getUint32(off + 4, true);
  const start = off + 8;
  if (start + bytes > u8.length) throw new Error('truncated data');
  const n = Math.floor(bytes / 2);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = v.getInt16(start + i * 2, true) / 32768;
  return { sampleRate, channels, data };
}
