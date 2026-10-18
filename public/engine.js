// Console-8 — WebAudio engine: channel strips, master tube stage, tape transport.
// Browser-only (needs AudioContext). Pure math lives in ../src/*.js.
import { dbToGain, faderToGain, tubeCurve } from '../src/dsp.js';
import {
  TRACKS, ST_STOPPED, ST_PLAYING, ST_RECORDING, Transport,
  newClip, clipEnd, allClips, mixEnd, VS_MIN, VS_MAX,
} from '../src/tape.js';
import { encodeWav16 } from '../src/wav.js';

/** Interleaved pcm -> AudioBuffer. */
export function pcmToBuffer(ctx, pcm) {
  const frames = Math.floor(pcm.data.length / pcm.channels);
  const buf = ctx.createBuffer(pcm.channels, frames, pcm.sampleRate);
  for (let ch = 0; ch < pcm.channels; ch++) {
    const d = buf.getChannelData(ch);
    for (let f = 0; f < frames; f++) d[f] = pcm.data[f * pcm.channels + ch];
  }
  return buf;
}

/** AudioBuffer -> interleaved pcm. */
export function bufferToPcm(buf) {
  const frames = buf.length;
  const channels = buf.numberOfChannels;
  const data = new Float32Array(frames * channels);
  for (let ch = 0; ch < channels; ch++) {
    const d = buf.getChannelData(ch);
    for (let f = 0; f < frames; f++) data[f * channels + ch] = d[f];
  }
  return { sampleRate: buf.sampleRate, channels, data };
}

export function audibleAt(project, i) {
  const chans = project.channels;
  const anySolo = chans.some((c) => c.solo);
  const p = chans[i];
  return p.mute ? false : anySolo ? !!p.solo : true;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.project = null; // set by app; mutated in place
    this.transport = new Transport();
    this.varispeed = 1.0;
    this.active = []; // live clip BufferSources
    this.anchor = { t: 0, pos: 0 };
    this._peakBuf = new Float32Array(512);
    this.micStream = null;
    this.micError = null;
    this.monitorGains = [];
    this.recorder = null;
    this.recChunks = [];
    this.recTracks = [];
    this.onState = null; // () => void, UI refresh hook
    this.onMic = null; // (status: 'ok'|'error', detail?) => void
  }

  async init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.master = this.buildMasterGraph(this.ctx);
    this.master.fader.connect(this.ctx.destination);
    this.channels = [];
    for (let i = 0; i < TRACKS; i++) this.channels.push(this.buildChannelGraph(this.ctx));
    this.wireBus();
  }

  async ensureCtx() {
    if (!this.ctx) {
      await this.init();
      this.applyAll();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  _emit() {
    if (this.onState) this.onState();
  }

  // ---------- channel strip graph ----------
  // input -> EQ(4) -> comp -> makeup -> limiter -> invert -> pan -> fader -> mute -> analyser
  buildChannelGraph(c) {
    const ch = {};
    ch.input = c.createGain();
    const mk = (type, freq, q) => {
      const f = c.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q || 1;
      return f;
    };
    ch.eq = {
      hf: mk('highshelf', 8000), hmf: mk('peaking', 2500),
      lmf: mk('peaking', 400), lf: mk('lowshelf', 120),
    };
    ch.input.connect(ch.eq.hf);
    ch.eq.hf.connect(ch.eq.hmf); ch.eq.hmf.connect(ch.eq.lmf); ch.eq.lmf.connect(ch.eq.lf);
    ch.comp = c.createDynamicsCompressor();
    ch.eq.lf.connect(ch.comp);
    ch.makeup = c.createGain();
    ch.comp.connect(ch.makeup);
    ch.limiter = c.createDynamicsCompressor();
    ch.limiter.knee.value = 0; ch.limiter.ratio.value = 20; ch.limiter.attack.value = 0.002;
    ch.makeup.connect(ch.limiter);
    ch.invert = c.createGain();
    ch.limiter.connect(ch.invert);
    ch.pan = c.createStereoPanner();
    ch.invert.connect(ch.pan);
    ch.fader = c.createGain();
    ch.pan.connect(ch.fader);
    ch.muteG = c.createGain();
    ch.fader.connect(ch.muteG);
    ch.analyser = c.createAnalyser();
    ch.analyser.fftSize = 512;
    ch.muteG.connect(ch.analyser);
    return ch;
  }

  applyChannelNodes(ch, p) {
    const eq = p.eq;
    const set = (node, band) => {
      node.frequency.value = band.freq;
      node.gain.value = eq.in ? band.gain : 0;
      if (band.q !== undefined) node.Q.value = band.q;
    };
    set(ch.eq.hf, eq.hf); set(ch.eq.hmf, eq.hmf); set(ch.eq.lmf, eq.lmf); set(ch.eq.lf, eq.lf);
    const cp = p.comp;
    ch.comp.threshold.value = cp.threshold;
    ch.comp.knee.value = cp.knee;
    ch.comp.ratio.value = cp.ratio;
    ch.comp.attack.value = cp.attack;
    ch.comp.release.value = cp.release;
    ch.makeup.gain.value = dbToGain(cp.makeup);
    ch.limiter.threshold.value = p.limiter.ceiling;
    ch.limiter.release.value = p.limiter.release;
    ch.invert.gain.value = p.invert ? -1 : 1;
    ch.pan.pan.value = p.pan;
    ch.fader.gain.value = faderToGain(p.fader);
  }

  applyChannel(i, p) {
    this.applyChannelNodes(this.channels[i], p);
    this.updateMutes();
  }

  updateMutes() {
    if (!this.project || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.project.channels.forEach((p, i) => {
      this.channels[i].muteG.gain.setTargetAtTime(audibleAt(this.project, i) ? 1 : 0, now, 0.01);
    });
  }

  // ---------- master: bus -> TUBE -> limiter -> fader ----------
  buildMasterGraph(c) {
    const m = {};
    m.bus = c.createGain();
    m.tubeDry = c.createGain();
    m.tubePre = c.createGain();
    m.shaper = c.createWaveShaper();
    m.shaper.curve = tubeCurve(1024, 2.0, 0.22);
    m.shaper.oversample = '4x';
    m.warmLP = c.createBiquadFilter();
    m.warmLP.type = 'lowpass';
    m.warmLP.frequency.value = 16500;
    m.tubeWet = c.createGain();
    m.sum = c.createGain();
    m.bus.connect(m.tubeDry); m.tubeDry.connect(m.sum);
    m.bus.connect(m.tubePre); m.tubePre.connect(m.shaper);
    m.shaper.connect(m.warmLP); m.warmLP.connect(m.tubeWet); m.tubeWet.connect(m.sum);
    m.limiter = c.createDynamicsCompressor();
    m.limiter.knee.value = 0; m.limiter.ratio.value = 20;
    m.limiter.attack.value = 0.001; m.limiter.release.value = 0.1;
    m.sum.connect(m.limiter);
    m.fader = c.createGain();
    m.limiter.connect(m.fader);
    m.splitter = c.createChannelSplitter(2);
    m.fader.connect(m.splitter);
    m.anL = c.createAnalyser(); m.anR = c.createAnalyser();
    m.anL.fftSize = 512; m.anR.fftSize = 512;
    m.splitter.connect(m.anL, 0); m.splitter.connect(m.anR, 1);
    return m;
  }

  wireBus() {
    if (this._busWired) return;
    for (const ch of this.channels) ch.analyser.connect(this.master.bus);
    this._busWired = true;
  }

  applyMasterNodes(m, p) {
    m.tubePre.gain.value = 1 + p.tubeDrive * 5; // 1x .. 6x into the shaper
    const a = (p.tubeMix * Math.PI) / 2;
    m.tubeDry.gain.value = Math.cos(a);
    m.tubeWet.gain.value = Math.sin(a);
    m.limiter.threshold.value = p.limCeiling;
    m.fader.gain.value = faderToGain(p.fader);
  }

  applyMaster(p) {
    this.applyMasterNodes(this.master, p);
  }

  applyAll() {
    for (let i = 0; i < TRACKS; i++) this.applyChannel(i, this.project.channels[i]);
    this.applyMaster(this.project.master);
  }

  // ---------- mic + monitoring ----------
  async ensureMic() {
    if (this.micStream) return this.micStream;
    if (this.micError) return null;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia unavailable');
      }
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.micStream = s;
      this._buildMicGraph();
      if (this.onMic) this.onMic('ok');
      return s;
    } catch (e) {
      this.micError = (e && e.name) || 'denied';
      if (this.onMic) this.onMic('error', this.micError);
      return null;
    }
  }

  _buildMicGraph() {
    const c = this.ctx;
    this.micSrc = c.createMediaStreamSource(this.micStream);
    this.monitorGains = [];
    for (let i = 0; i < TRACKS; i++) {
      const g = c.createGain();
      g.gain.value = 0;
      this.micSrc.connect(g);
      g.connect(this.channels[i].input);
      this.monitorGains.push(g);
    }
  }

  setMonitor(i, on) {
    if (!this.ctx || !this.monitorGains[i]) return;
    this.monitorGains[i].gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  // ---------- tape transport ----------
  positionNow() {
    if (!this.ctx || this.transport.state === ST_STOPPED) return this.transport.position;
    return Math.max(0, this.anchor.pos + (this.ctx.currentTime - this.anchor.t) * this.varispeed);
  }

  _startPlayback(fromPos) {
    this._stopSources();
    const t0 = this.ctx.currentTime + 0.06;
    for (let i = 0; i < TRACKS; i++) {
      for (const clip of this.project.tracks[i].clips) {
        if (!clip.pcm) continue;
        if (clipEnd(clip) <= fromPos + 1e-6) continue;
        const s = this.ctx.createBufferSource();
        s.buffer = this._clipBuffer(clip);
        s.playbackRate.value = this.varispeed;
        s.connect(this.channels[i].input);
        const offset = Math.max(0, fromPos - clip.startOffset);
        try {
          s.start(t0, offset);
        } catch {
          continue;
        }
        this.active.push(s);
      }
    }
    this.anchor = { t: t0, pos: fromPos };
  }

  _stopSources() {
    for (const s of this.active) {
      try { s.stop(); } catch { /* already ended */ }
      try { s.disconnect(); } catch { /* noop */ }
    }
    this.active = [];
  }

  _clipBuffer(clip) {
    if (!clip._buf) clip._buf = pcmToBuffer(this.ctx, clip.pcm);
    return clip._buf;
  }

  async play() {
    await this.ensureCtx();
    const r = this.transport.play();
    if (!r.ok) return r;
    if (!r.punchedOut) this._startPlayback(this.transport.position);
    this._emit();
    return r;
  }

  async rec() {
    await this.ensureCtx();
    const wasPlaying = this.transport.state === ST_PLAYING;
    const r = this.transport.rec();
    if (!r.ok) return r;
    const recTracks = [...this.transport.armed].filter((i) => this.project.tracks[i].input === 'mic');
    if (recTracks.length === 0) {
      this.transport.stop();
      return { ok: false, reason: 'armed tracks are set to File input' };
    }
    const mic = await this.ensureMic();
    if (!mic) {
      this.transport.stop();
      return { ok: false, reason: 'mic unavailable' };
    }
    if (!wasPlaying) this._startPlayback(this.transport.position);
    this.recTracks = recTracks;
    this.recChunks = [];
    let recorder;
    try {
      recorder = new MediaRecorder(mic);
    } catch {
      this.transport.stop();
      return { ok: false, reason: 'recorder unsupported' };
    }
    this.recorder = recorder;
    this._recDone = new Promise((res) => { this._recDoneRes = res; });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.recChunks.push(e.data);
    };
    recorder.onstop = () => this._recDoneRes();
    recorder.start(250);
    this._emit();
    return { ok: true, tracks: recTracks, punchedIn: wasPlaying };
  }

  async stop() {
    if (this.ctx) this.transport.position = this.positionNow();
    const r = this.transport.stop();
    this._stopSources();
    if (this.recorder) {
      const rec = this.recorder;
      this.recorder = null;
      try {
        rec.stop();
        await this._recDone;
        await this._finalizeTake(r.take);
      } catch {
        /* recorder failed mid-stop: keep the tape rolling state clean */
      }
    }
    this._emit();
    return r;
  }

  async _finalizeTake(take) {
    const chunks = this.recChunks;
    this.recChunks = [];
    if (!take || !chunks.length) return null;
    try {
      const blob = new Blob(chunks, { type: (chunks[0] && chunks[0].type) || 'audio/webm' });
      const ab = await blob.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(ab);
      if (!buf || buf.duration < 0.05) return null;
      const pcm = bufferToPcm(buf);
      const made = [];
      for (const i of this.recTracks) {
        const clip = newClip(i, take.start, 'take');
        clip.pcm = pcm;
        clip.duration = buf.duration;
        this.project.tracks[i].clips.push(clip);
        made.push(clip);
      }
      return made;
    } catch {
      return null;
    }
  }

  rtz() {
    const r = this.transport.rtz();
    if (r.ok && this.ctx && this.transport.state !== ST_STOPPED) this._startPlayback(0);
    this._emit();
    return r;
  }

  seek(t) {
    const r = this.transport.seek(t);
    if (!r.ok) return r;
    if (this.ctx && this.transport.state !== ST_STOPPED) this._startPlayback(t);
    this._emit();
    return r;
  }

  setVarispeed(rate) {
    const nr = Math.min(VS_MAX, Math.max(VS_MIN, rate));
    if (this.ctx && this.transport.state !== ST_STOPPED) {
      const pos = this.positionNow();
      this.anchor = { t: this.ctx.currentTime, pos };
      this.transport.position = pos;
    }
    this.varispeed = nr;
    for (const s of this.active) {
      try { s.playbackRate.value = nr; } catch { /* noop */ }
    }
    if (this.project) this.project.varispeed = nr;
  }

  // ---------- clips: import + test hooks ----------
  async importFile(i, file, atTime) {
    await this.ensureCtx();
    const ab = await file.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(ab);
    const clip = newClip(i, atTime ?? this.transport.position,
      (file.name || 'import').replace(/\.[^.]+$/, '').slice(0, 32) || 'import');
    clip.pcm = bufferToPcm(buf);
    clip.duration = buf.duration;
    this.project.tracks[i].clips.push(clip);
    this._emit();
    return clip;
  }

  /** Headless-test hook: synthesize a tone clip straight into the model. */
  addTestTone(i, { freq = 440, dur = 1.0, start = 0, sr = 44100 } = {}) {
    const n = Math.max(1, Math.floor(dur * sr));
    const data = new Float32Array(n);
    for (let k = 0; k < n; k++) data[k] = 0.5 * Math.sin((2 * Math.PI * freq * k) / sr);
    const clip = newClip(i, start, 'test');
    clip.pcm = { sampleRate: sr, channels: 1, data };
    clip.duration = dur;
    this.project.tracks[i].clips.push(clip);
    return clip;
  }

  // ---------- mixdown ----------
  async bounceToWav() {
    const end = mixEnd(this.project);
    if (end <= 0 || !allClips(this.project).some((c) => c.pcm)) {
      return { ok: false, reason: 'tape is empty' };
    }
    const sr = 44100;
    const off = new OfflineAudioContext(2, Math.ceil(end * sr) + sr, sr);
    const bus = off.createGain();
    const m = this.buildMasterGraph(off);
    this.applyMasterNodes(m, this.project.master);
    m.fader.connect(off.destination);
    bus.connect(m.bus);
    for (let i = 0; i < TRACKS; i++) {
      const ch = this.buildChannelGraph(off);
      this.applyChannelNodes(ch, this.project.channels[i]);
      if (!audibleAt(this.project, i)) ch.muteG.gain.value = 0;
      ch.analyser.connect(bus);
      for (const clip of this.project.tracks[i].clips) {
        if (!clip.pcm) continue;
        const s = off.createBufferSource();
        s.buffer = pcmToBuffer(off, clip.pcm);
        s.playbackRate.value = this.varispeed;
        s.connect(ch.input);
        s.start(Math.max(0, clip.startOffset));
      }
    }
    const rendered = await off.startRendering();
    return { ok: true, wav: encodeWav16(bufferToPcm(rendered)), seconds: end };
  }

  // ---------- metering ----------
  peak(analyser) {
    analyser.getFloatTimeDomainData(this._peakBuf);
    let pk = 0;
    for (let i = 0; i < this._peakBuf.length; i++) {
      const a = Math.abs(this._peakBuf[i]);
      if (a > pk) pk = a;
    }
    return pk;
  }

  channelPeak(i) { return this.peak(this.channels[i].analyser); }
  channelGR(i) { return this.channels[i].comp.reduction || 0; }
  masterPeaks() { return [this.peak(this.master.anL), this.peak(this.master.anR)]; }
}
