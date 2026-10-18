// Console-8 — WebAudio engine: channel strips, master tube stage, voices, scheduler.
// Browser-only (needs AudioContext). Pure math lives in ../src/dsp.js and ../src/sequencer.js.
import {
  dbToGain, faderToGain, tubeCurve, midiToFreq, MELODIC,
} from '../src/dsp.js';
import { STEPS, CHANNELS, stepDur } from '../src/sequencer.js';

const ACCENT_VEL = 1.0;
const NORMAL_VEL = 0.62;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.project = null;      // set by app; mutated in place
    this.playing = false;
    this.step = 0;
    this.songIdx = 0;
    this.nextTime = 0;
    this.timerID = null;
    this.onStep = null;       // (step, patternId) => void, for the playhead
    this.samples = new Array(CHANNELS).fill(null);
    this._peakBuf = new Float32Array(512);
  }

  async init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.noiseBuf = this.makeNoise();
    this.buildMaster();
    this.channels = [];
    for (let i = 0; i < CHANNELS; i++) this.channels.push(this.buildChannel(i));
  }

  makeNoise() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // ---------- channel strip ----------
  // source -> EQ(4) -> comp -> makeup -> limiter -> invert -> pan -> fader -> mute -> analyser -> bus
  buildChannel() {
    const c = this.ctx;
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

  applyChannel(i, p) {
    const ch = this.channels[i];
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
    this.updateMutes();
  }

  updateMutes() {
    if (!this.project) return;
    const anySolo = this.project.channels.some((c) => c.solo);
    this.project.channels.forEach((p, i) => {
      const audible = p.mute ? false : anySolo ? p.solo : true;
      this.channels[i].muteG.gain.setTargetAtTime(audible ? 1 : 0, this.ctx.currentTime, 0.01);
    });
  }

  // ---------- master: bus -> TUBE -> limiter -> fader -> out ----------
  buildMaster() {
    const c = this.ctx;
    const m = (this.master = {});
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
    m.fader.connect(c.destination);
    // channel analysers feed the bus
    this._busWired = false;
  }

  wireBus() {
    if (this._busWired) return;
    for (const ch of this.channels) ch.analyser.connect(this.master.bus);
    this._busWired = true;
  }

  applyMaster(p) {
    const m = this.master;
    m.tubePre.gain.value = 1 + p.tubeDrive * 5; // 1x .. 6x into the shaper
    const a = (p.tubeMix * Math.PI) / 2;
    m.tubeDry.gain.value = Math.cos(a);
    m.tubeWet.gain.value = Math.sin(a);
    m.limiter.threshold.value = p.limCeiling;
    m.fader.gain.value = faderToGain(p.fader);
  }

  // ---------- voices ----------
  noiseSrc(t, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true;
    s.start(t); s.stop(t + dur + 0.05);
    return s;
  }

  envGain(t, peak, decay, attack = 0.003) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  kick(t, vel, out) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(43, t + 0.11);
    const g = this.envGain(t, 0.9 * vel, 0.42);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.55);
    const click = this.noiseSrc(t, 0.03);
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
    const cg = this.envGain(t, 0.25 * vel, 0.025, 0.001);
    click.connect(hp); hp.connect(cg); cg.connect(out);
  }

  snare(t, vel, out) {
    const c = this.ctx;
    const n = this.noiseSrc(t, 0.25);
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.8;
    const g = this.envGain(t, 0.55 * vel, 0.17);
    n.connect(bp); bp.connect(g); g.connect(out);
    const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = 186;
    const og = this.envGain(t, 0.4 * vel, 0.09);
    o.connect(og); og.connect(out); o.start(t); o.stop(t + 0.2);
  }

  clap(t, vel, out) {
    const c = this.ctx;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1150; bp.Q.value = 1.6;
    bp.connect(out);
    [0, 0.012, 0.025, 0.041].forEach((dt, i) => {
      const n = this.noiseSrc(t + dt, 0.06);
      const g = this.envGain(t + dt, (0.5 - i * 0.07) * vel, 0.05, 0.001);
      n.connect(bp); bp.connect(g); g.connect(out);
    });
  }

  hat(t, vel, out, open) {
    const c = this.ctx;
    const n = this.noiseSrc(t, open ? 0.4 : 0.08);
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7800;
    const g = this.envGain(t, 0.32 * vel, open ? 0.32 : 0.045, 0.001);
    n.connect(hp); hp.connect(g); g.connect(out);
  }

  bass(t, vel, out, midi) {
    const c = this.ctx;
    const f = midiToFreq(midi);
    const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const sub = c.createOscillator(); sub.type = 'sine'; sub.frequency.value = f / 2;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 7;
    lp.frequency.setValueAtTime(300 + vel * 1100, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + 0.25);
    const g = this.envGain(t, 0.6 * vel, 0.34);
    const sg = c.createGain(); sg.gain.value = 0.5;
    o.connect(lp); sub.connect(sg); sg.connect(lp); lp.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.5); sub.start(t); sub.stop(t + 0.5);
  }

  keys(t, vel, out, midi) {
    const c = this.ctx;
    const f = midiToFreq(midi);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.7;
    const g = this.envGain(t, 0.34 * vel, 0.55, 0.008);
    lp.connect(g); g.connect(out);
    for (const det of [-7, 5]) {
      const o = c.createOscillator(); o.type = 'sawtooth';
      o.frequency.value = f; o.detune.value = det;
      const og = c.createGain(); og.gain.value = 0.5;
      o.connect(og); og.connect(lp); o.start(t); o.stop(t + 0.75);
    }
  }

  lead(t, vel, out, midi) {
    const c = this.ctx;
    const f = midiToFreq(midi);
    const o = c.createOscillator(); o.type = 'square'; o.frequency.value = f;
    const lfo = c.createOscillator(); lfo.frequency.value = 5.5;
    const lfoG = c.createGain(); lfoG.gain.value = 7;
    lfo.connect(lfoG); lfoG.connect(o.detune);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 4;
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(4200, t + 0.06);
    lp.frequency.exponentialRampToValueAtTime(1500, t + 0.3);
    const g = this.envGain(t, 0.3 * vel, 0.3, 0.005);
    o.connect(lp); lp.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.45); lfo.start(t); lfo.stop(t + 0.45);
  }

  sample(t, vel, out, buf) {
    const c = this.ctx;
    const s = c.createBufferSource(); s.buffer = buf;
    const g = this.envGain(t, 0.85 * vel, Math.min(1.5, buf.duration), 0.004);
    s.connect(g); g.connect(out); s.start(t);
  }

  trigger(chIdx, stepVal, t) {
    const p = this.project.channels[chIdx];
    const out = this.channels[chIdx].input;
    const vel = stepVal === 2 ? ACCENT_VEL : NORMAL_VEL;
    const note = p.note || 60;
    switch (p.source) {
      case 'kick': this.kick(t, vel, out); break;
      case 'snare': this.snare(t, vel, out); break;
      case 'clap': this.clap(t, vel, out); break;
      case 'chat': this.hat(t, vel, out, false); break;
      case 'ohat': this.hat(t, vel, out, true); break;
      case 'bass': this.bass(t, vel, out, note); break;
      case 'keys': this.keys(t, vel, out, note); break;
      case 'lead': this.lead(t, vel, out, note); break;
      case 'sample': if (this.samples[chIdx]) this.sample(t, vel, out, this.samples[chIdx]); break;
    }
  }

  // ---------- transport + lookahead scheduler ----------
  play() {
    if (!this.ctx || this.playing) return;
    this.playing = true;
    this.step = 0;
    this.songIdx = 0;
    this.nextTime = this.ctx.currentTime + 0.06;
    this.timerID = setInterval(() => this.tick(), 25);
  }

  stop() {
    this.playing = false;
    clearInterval(this.timerID);
    this.timerID = null;
    if (this.onStep) this.onStep(-1, this.project.currentPattern);
  }

  currentPatternId() {
    const pr = this.project;
    if (pr.songMode && pr.song.length > 0) return pr.song[this.songIdx % pr.song.length];
    return pr.currentPattern;
  }

  tick() {
    if (!this.playing) return;
    const ahead = this.ctx.currentTime + 0.12;
    while (this.nextTime < ahead) {
      const pr = this.project;
      const dur = stepDur(pr.tempo);
      const pid = this.currentPatternId();
      // swing delays off-beat 16ths without shifting the grid
      const t = this.nextTime + (this.step % 2 === 1 ? pr.swing * dur : 0);
      const pattern = pr.patterns[pid];
      for (let ch = 0; ch < CHANNELS; ch++) {
        const v = pattern[ch][this.step];
        if (v > 0 && this.audible(ch)) this.trigger(ch, v, t);
      }
      const s = this.step, id = pid;
      const ms = Math.max(0, (t - this.ctx.currentTime) * 1000);
      setTimeout(() => { if (this.playing && this.onStep) this.onStep(s, id); }, ms);
      this.step++;
      if (this.step >= STEPS) {
        this.step = 0;
        if (pr.songMode) this.songIdx++;
      }
      this.nextTime += dur;
    }
  }

  audible(ch) {
    const chans = this.project.channels;
    const anySolo = chans.some((c) => c.solo);
    const p = chans[ch];
    return p.mute ? false : anySolo ? !!p.solo : true;
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

  async loadSample(ch, file) {
    const ab = await file.arrayBuffer();
    this.samples[ch] = await this.ctx.decodeAudioData(ab);
    return this.samples[ch].duration;
  }
}
