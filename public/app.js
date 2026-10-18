// Console-8 — UI: console strips, tape machine, transport, meters.
import {
  knobToLog, knobToLin, logToKnob, eqDefaults,
} from '../src/dsp.js';
import {
  TRACKS, ST_STOPPED, ST_PLAYING, ST_RECORDING,
  newProject, serializeProject, serializeAutosave, deserializeProject,
  varispeedToRate, rateToVarispeed, fmtCounter, mixEnd, clipEnd, pcmPeak,
} from '../src/tape.js';
import { AudioEngine } from './engine.js';

const $ = (sel, r = document) => r.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------- knob ----------------
class Knob {
  constructor({ label, min, max, value, scale = 'lin', format = (v) => v.toFixed(2), accent = '#e0a458', onChange = () => {} }) {
    this.min = min; this.max = max; this.scale = scale;
    this.format = format; this.accent = accent; this.onChange = onChange;
    this.defPos = this.valToPos(value);
    this.pos = this.defPos;
    this.root = el('div', 'knob');
    this.cv = el('canvas', 'knob-cv');
    this.cv.width = 44; this.cv.height = 44;
    this.root.appendChild(this.cv);
    this.root.appendChild(el('div', 'knob-label', label));
    this.readout = el('div', 'knob-val', format(value));
    this.root.appendChild(this.readout);
    this.draw();
    this.cv.style.touchAction = 'none';
    this.cv.addEventListener('pointerdown', (e) => {
      this.cv.setPointerCapture(e.pointerId);
      this._y = e.clientY; this._pos = this.pos; this._fine = e.shiftKey;
      const mv = (ev) => {
        const range = this._fine ? 1500 : 150;
        this.setPos(this._pos + (this._y - ev.clientY) / range);
      };
      const up = () => {
        this.cv.removeEventListener('pointermove', mv);
        this.cv.removeEventListener('pointerup', up);
      };
      this.cv.addEventListener('pointermove', mv);
      this.cv.addEventListener('pointerup', up);
    });
    this.cv.addEventListener('dblclick', () => this.setPos(this.defPos));
  }
  valToPos(v) {
    return this.scale === 'log'
      ? Math.log(v / this.min) / Math.log(this.max / this.min)
      : (v - this.min) / (this.max - this.min);
  }
  posToVal(p) {
    return this.scale === 'log' ? knobToLog(p, this.min, this.max) : knobToLin(p, this.min, this.max);
  }
  setPos(p, fire = true) {
    this.pos = Math.min(1, Math.max(0, p));
    const v = this.posToVal(this.pos);
    this.readout.textContent = this.format(v);
    this.draw();
    if (fire) this.onChange(v);
  }
  setValue(v, fire = false) { this.setPos(this.valToPos(v), fire); }
  draw() {
    const g = this.cv.getContext('2d');
    const S = 44, cx = S / 2, cy = S / 2, r = S / 2 - 6;
    g.clearRect(0, 0, S, S);
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    g.lineWidth = 4; g.lineCap = 'round';
    g.strokeStyle = '#3a3a3a';
    g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
    g.strokeStyle = this.accent;
    g.beginPath(); g.arc(cx, cy, r, a0, a0 + this.pos * (a1 - a0)); g.stroke();
    const a = a0 + this.pos * (a1 - a0);
    g.strokeStyle = '#f2ede4'; g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * (r - 7), cy + Math.sin(a) * (r - 7));
    g.lineTo(cx + Math.cos(a) * (r + 1), cy + Math.sin(a) * (r + 1));
    g.stroke();
  }
}

function makeKnob(parent, opts) {
  const k = new Knob(opts);
  parent.appendChild(k.root);
  return k;
}

// ---------------- vertical fader ----------------
class Fader {
  constructor({ value = 0.8, onChange = () => {} }) {
    this.pos = value; this.onChange = onChange;
    this.root = el('div', 'fader');
    this.track = el('div', 'fader-track');
    this.fill = el('div', 'fader-fill');
    this.handle = el('div', 'fader-handle');
    this.track.append(this.fill, this.handle);
    this.root.appendChild(this.track);
    this.draw();
    this.track.style.touchAction = 'none';
    this.track.addEventListener('pointerdown', (e) => {
      this.track.setPointerCapture(e.pointerId);
      const mv = (ev) => {
        const r = this.track.getBoundingClientRect();
        this.setPos(1 - (ev.clientY - r.top) / r.height);
      };
      mv(e);
      const up = () => {
        this.track.removeEventListener('pointermove', mv);
        this.track.removeEventListener('pointerup', up);
      };
      this.track.addEventListener('pointermove', mv);
      this.track.addEventListener('pointerup', up);
    });
    this.track.addEventListener('dblclick', () => this.setPos(0.8));
  }
  setPos(p, fire = true) {
    this.pos = Math.min(1, Math.max(0, p));
    this.draw();
    if (fire) this.onChange(this.pos);
  }
  draw() {
    this.fill.style.height = `${this.pos * 100}%`;
    this.handle.style.bottom = `calc(${this.pos * 100}% - 5px)`;
  }
}

// ---------------- app state ----------------
const engine = new AudioEngine();
let project = newProject();
try {
  const saved = localStorage.getItem('console-8-project');
  if (saved) project = deserializeProject(saved);
} catch { /* fresh project */ }
engine.project = project;
engine.varispeed = project.varispeed || 1.0;
const monState = new Array(TRACKS).fill(false);

let saveTimer = null;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('console-8-project', serializeAutosave(project)); } catch {}
    $('#save-state').textContent = 'autosaved ' + new Date().toLocaleTimeString() + ' (settings only, no audio)';
  }, 600);
}

function toast(msg) {
  $('#save-state').textContent = msg;
}

function applyChannel(i) {
  if (engine.ctx) engine.applyChannel(i, project.channels[i]);
}
function applyMaster() {
  if (engine.ctx) engine.applyMaster(project.master);
}
function applyAll() {
  for (let i = 0; i < TRACKS; i++) applyChannel(i);
  applyMaster();
}

// ---------------- top bar: transport + tape ----------------
let recBtn, playBtn, stopBtn, rtzBtn, counterEl, vsKnob, reelL, reelR, micEl;
let reelAngle = 0, lastFrameT = 0;

function buildTopbar() {
  const bar = $('#topbar');
  bar.append(el('div', 'logo', 'CONSOLE-8'));

  const tp = el('div', 'transport');
  recBtn = el('button', 'tbtn rec', '⏺ REC');
  recBtn.id = 'rec-btn';
  recBtn.onclick = onRec;
  playBtn = el('button', 'tbtn play', '▶ PLAY');
  playBtn.id = 'play-btn';
  playBtn.onclick = onPlay;
  stopBtn = el('button', 'tbtn stop', '⏹ STOP');
  stopBtn.id = 'stop-btn';
  stopBtn.onclick = onStop;
  rtzBtn = el('button', 'tbtn rtz', '⏮ RTZ');
  rtzBtn.id = 'rtz-btn';
  rtzBtn.onclick = onRtz;
  tp.append(recBtn, playBtn, stopBtn, rtzBtn);
  bar.appendChild(tp);

  counterEl = el('div', 'counter', '00:00');
  counterEl.id = 'counter';
  bar.appendChild(counterEl);

  const vsWrap = el('div', 'top-group');
  vsWrap.appendChild(el('span', 'top-label', 'VARISPEED'));
  vsKnob = makeKnob(vsWrap, {
    label: 'RATE', min: 0, max: 1, value: rateToVarispeed(engine.varispeed),
    format: (v) => varispeedToRate(v).toFixed(2) + 'x', accent: '#e07840',
    onChange: (v) => {
      const vv = Math.abs(v - 0.5) < 0.03 ? 0.5 : v; // center detent
      engine.setVarispeed(varispeedToRate(vv));
      autosave();
    },
  });
  vsKnob.defPos = 0.5; // double-click = 1.00x
  bar.appendChild(vsWrap);

  const reels = el('div', 'reels');
  reelL = el('canvas', 'reel'); reelL.width = reelL.height = 54;
  reelR = el('canvas', 'reel'); reelR.width = reelR.height = 54;
  reels.append(reelL, reelR);
  bar.appendChild(reels);

  micEl = el('span', 'mic-unknown', '● MIC');
  micEl.id = 'mic-status';
  micEl.title = 'microphone: unknown';
  bar.appendChild(micEl);
  engine.onMic = (st, detail) => {
    micEl.className = st === 'ok' ? 'mic-ok' : 'mic-error';
    micEl.title = 'microphone: ' + (st === 'ok' ? 'ready' : detail || 'unavailable');
  };

  const fileWrap = el('div', 'top-group');
  const saveBtn = el('button', 'file-btn', 'SAVE');
  saveBtn.onclick = downloadProject;
  const loadBtn = el('button', 'file-btn', 'LOAD');
  const loadInput = el('input');
  loadInput.type = 'file'; loadInput.accept = '.json,application/json';
  loadInput.style.display = 'none';
  loadInput.onchange = async () => {
    if (!loadInput.files[0]) return;
    const text = await loadInput.files[0].text();
    project = deserializeProject(text);
    engine.project = project;
    rebuildAll();
    autosave();
    loadInput.value = '';
  };
  loadBtn.onclick = () => loadInput.click();
  const bounceBtn = el('button', 'file-btn bounce', 'BOUNCE');
  bounceBtn.id = 'bounce-btn';
  bounceBtn.onclick = onBounce;
  const ss = el('span', 'save-state', '');
  ss.id = 'save-state';
  fileWrap.append(saveBtn, loadBtn, bounceBtn, loadInput, ss);
  bar.appendChild(fileWrap);

  engine.onState = refreshTransport;
  refreshTransport();
}

async function onRec() {
  const r = await engine.rec();
  if (!r.ok) toast('REC: ' + r.reason);
  refreshTransport();
  renderLanes();
}
async function onPlay() {
  const r = await engine.play();
  if (!r.ok) toast('PLAY: ' + (r.reason || 'busy'));
  refreshTransport();
}
async function onStop() {
  toast('stopping…');
  await engine.stop();
  toast('stopped');
  refreshTransport();
  renderLanes();
}
function onRtz() {
  const r = engine.rtz();
  if (!r.ok) toast('RTZ: ' + r.reason);
  refreshTransport();
}
async function onBounce() {
  toast('bouncing mix…');
  const r = await engine.bounceToWav();
  if (!r.ok) { toast('BOUNCE: ' + r.reason); return; }
  const blob = new Blob([r.wav], { type: 'audio/wav' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'console-8-mixdown.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('bounced ' + r.seconds.toFixed(1) + 's mixdown');
}

function refreshTransport() {
  const st = engine.transport.state;
  const anyArmed = engine.transport.armed.size > 0;
  recBtn.classList.toggle('armed', anyArmed);
  recBtn.classList.toggle('recording', st === ST_RECORDING);
  playBtn.classList.toggle('playing', st === ST_PLAYING || st === ST_RECORDING);
  playBtn.textContent = st === ST_STOPPED ? '▶ PLAY' : '▶ PLAY';
  for (let i = 0; i < TRACKS; i++) {
    const b = stripRefs[i] && stripRefs[i].armBtn;
    if (b) b.classList.toggle('armed', engine.transport.armed.has(i));
  }
}

function downloadProject() {
  const blob = new Blob([serializeProject(project, true)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'console-8-project.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('project saved (with audio)');
}

// ---------------- channel strips ----------------
const EQ_ACCENT = { hf: '#e06c5b', hmf: '#e0a458', lmf: '#7fb8d4', lf: '#7fd4a8' };
const stripRefs = [];

function sectionTitle(parent, text, extra) {
  const d = el('div', 'sec-title');
  d.appendChild(el('span', '', text));
  if (extra) d.appendChild(extra);
  parent.appendChild(d);
  return d;
}

function buildStrip(i) {
  const p = project.channels[i];
  const tp = project.tracks[i];
  const strip = el('div', 'strip');
  const refs = { knobs: {} };
  stripRefs[i] = refs;

  const head = el('div', 'strip-head');
  head.appendChild(el('span', 'ch-num', String(i + 1).padStart(2, '0')));
  const armBtn = el('button', 'arm-btn', 'ARM');
  armBtn.title = 'arm track for recording';
  armBtn.onclick = () => {
    engine.transport.toggleArm(i);
    armBtn.classList.toggle('armed', engine.transport.armed.has(i));
    refreshTransport();
    renderLanes();
  };
  const monBtn = el('button', 'mon-btn', 'MON');
  monBtn.title = 'input monitoring (mic through this strip)';
  monBtn.onclick = async () => {
    if (monState[i]) {
      monState[i] = false;
      engine.setMonitor(i, false);
      monBtn.classList.remove('active');
      return;
    }
    await engine.ensureCtx();
    const mic = await engine.ensureMic();
    if (!mic) {
      toast('mic unavailable — monitoring off');
      return;
    }
    monState[i] = true;
    engine.setMonitor(i, true);
    monBtn.classList.add('active');
  };
  const inSel = el('select', 'src-sel');
  for (const [v, l] of [['mic', 'Mic'], ['file', 'File']]) {
    const o = el('option', '', l);
    o.value = v;
    inSel.appendChild(o);
  }
  inSel.value = tp.input;
  inSel.title = 'record input for this track';
  inSel.onchange = () => { tp.input = inSel.value; autosave(); };
  head.append(armBtn, monBtn, inSel);
  strip.appendChild(head);
  refs.armBtn = armBtn; refs.monBtn = monBtn; refs.inSel = inSel;

  // drop zone for audio files -> clip at the drop time
  strip.addEventListener('dragover', (e) => { e.preventDefault(); strip.classList.add('drop'); });
  strip.addEventListener('dragleave', () => strip.classList.remove('drop'));
  strip.addEventListener('drop', async (e) => {
    e.preventDefault(); strip.classList.remove('drop');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    try {
      await engine.importFile(i, f, engine.transport.position);
      renderLanes(); autosave();
      toast('imported ' + f.name);
    } catch {
      toast('could not decode ' + f.name);
    }
  });

  // EQ
  const eqInBtn = el('button', 'eq-in' + (p.eq.in ? ' active' : ''), 'EQ IN');
  eqInBtn.onclick = () => {
    p.eq.in = !p.eq.in;
    eqInBtn.classList.toggle('active', p.eq.in);
    applyChannel(i); autosave();
  };
  sectionTitle(strip, 'EQ', eqInBtn);
  const eqGrid = el('div', 'eq-grid');
  const bands = [
    ['hf', 'HF', ['freq', 'gain']],
    ['hmf', 'HMF', ['freq', 'gain', 'q']],
    ['lmf', 'LMF', ['freq', 'gain', 'q']],
    ['lf', 'LF', ['freq', 'gain']],
  ];
  for (const [bk, label, params] of bands) {
    const col = el('div', 'eq-col');
    col.appendChild(el('div', 'eq-band', label));
    const b = p.eq[bk];
    const def = eqDefaults()[bk];
    for (const prm of params) {
      const isF = prm === 'freq', isQ = prm === 'q';
      const k = makeKnob(col, {
        label: prm.toUpperCase(),
        min: isF ? b.freqMin : isQ ? b.qMin : -15,
        max: isF ? b.freqMax : isQ ? b.qMax : 15,
        value: b[prm], scale: isF || isQ ? 'log' : 'lin',
        format: isF ? (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + '' : (v) => (isQ ? v.toFixed(2) : (v > 0 ? '+' : '') + v.toFixed(1)),
        accent: EQ_ACCENT[bk],
        onChange: (v) => { b[prm] = v; applyChannel(i); autosave(); },
      });
      refs.knobs[`eq_${bk}_${prm}`] = k;
    }
    eqGrid.appendChild(col);
  }
  strip.appendChild(eqGrid);

  // dynamics
  const dynTitle = el('div', 'sec-title');
  dynTitle.appendChild(el('span', '', 'DYNAMICS'));
  strip.appendChild(dynTitle);
  const dynRow = el('div', 'dyn-row');
  const grWrap = el('div', 'gr-wrap');
  grWrap.appendChild(el('div', 'gr-label', 'GR'));
  const grCv = el('canvas', 'gr-cv');
  grCv.width = 14; grCv.height = 120;
  grWrap.appendChild(grCv);
  refs.grCv = grCv;
  dynRow.appendChild(grWrap);
  const compKnobs = el('div', 'comp-knobs');
  const ck = (label, key, min, max, scale, fmt) => makeKnob(compKnobs, {
    label, min, max, value: p.comp[key], scale, format: fmt, accent: '#c9a0dc',
    onChange: (v) => { p.comp[key] = v; applyChannel(i); autosave(); },
  });
  refs.knobs.comp_thr = ck('THR', 'threshold', -48, 0, 'lin', (v) => v.toFixed(0) + 'dB');
  refs.knobs.comp_ratio = ck('RATIO', 'ratio', 1, 20, 'log', (v) => v.toFixed(1) + ':1');
  refs.knobs.comp_knee = ck('KNEE', 'knee', 0, 30, 'lin', (v) => v.toFixed(0) + 'dB');
  refs.knobs.comp_makeup = ck('MAKEUP', 'makeup', 0, 24, 'lin', (v) => '+' + v.toFixed(1) + 'dB');
  refs.knobs.comp_atk = makeKnob(compKnobs, {
    label: 'ATK', min: 0.1, max: 100, value: p.comp.attack * 1000, scale: 'log',
    format: (v) => v.toFixed(1) + 'ms', accent: '#c9a0dc',
    onChange: (v) => { p.comp.attack = v / 1000; applyChannel(i); autosave(); },
  });
  refs.knobs.comp_rel = makeKnob(compKnobs, {
    label: 'REL', min: 20, max: 1000, value: p.comp.release * 1000, scale: 'log',
    format: (v) => Math.round(v) + 'ms', accent: '#c9a0dc',
    onChange: (v) => { p.comp.release = v / 1000; applyChannel(i); autosave(); },
  });
  dynRow.appendChild(compKnobs);
  strip.appendChild(dynRow);
  const limRow = el('div', 'lim-row');
  limRow.appendChild(el('span', 'lim-label', 'LIMIT'));
  refs.knobs.lim_ceil = makeKnob(limRow, {
    label: 'CEIL', min: -12, max: 0, value: p.limiter.ceiling, format: (v) => v.toFixed(1) + 'dB', accent: '#e06c5b',
    onChange: (v) => { p.limiter.ceiling = v; applyChannel(i); autosave(); },
  });
  refs.knobs.lim_rel = makeKnob(limRow, {
    label: 'REL', min: 20, max: 500, value: p.limiter.release * 1000, scale: 'log',
    format: (v) => Math.round(v) + 'ms', accent: '#e06c5b',
    onChange: (v) => { p.limiter.release = v / 1000; applyChannel(i); autosave(); },
  });
  strip.appendChild(limRow);

  // pan + polarity
  const panRow = el('div', 'pan-row');
  refs.knobs.pan = makeKnob(panRow, {
    label: 'PAN', min: -1, max: 1, value: p.pan,
    format: (v) => v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.abs(Math.round(v * 100)),
    accent: '#7fd4a8',
    onChange: (v) => { p.pan = v; applyChannel(i); autosave(); },
  });
  const polBtn = el('button', 'pol-btn' + (p.invert ? ' active' : ''), 'Ø');
  polBtn.title = 'polarity invert';
  polBtn.onclick = () => {
    p.invert = !p.invert;
    polBtn.classList.toggle('active', p.invert);
    applyChannel(i); autosave();
  };
  panRow.appendChild(polBtn);
  strip.appendChild(panRow);

  // fader + meter + mute/solo
  const fadRow = el('div', 'fad-row');
  const meterCv = el('canvas', 'ch-meter');
  meterCv.width = 12; meterCv.height = 132;
  refs.meterCv = meterCv;
  fadRow.appendChild(meterCv);
  const fader = new Fader({
    value: p.fader,
    onChange: (v) => { p.fader = v; applyChannel(i); autosave(); },
  });
  refs.fader = fader;
  fadRow.appendChild(fader.root);
  const msCol = el('div', 'ms-col');
  const muteBtn = el('button', 'mute-btn' + (p.mute ? ' active' : ''), 'M');
  muteBtn.onclick = () => { p.mute = !p.mute; muteBtn.classList.toggle('active', p.mute); engine.updateMutes(); autosave(); };
  const soloBtn = el('button', 'solo-btn' + (p.solo ? ' active' : ''), 'S');
  soloBtn.onclick = () => { p.solo = !p.solo; soloBtn.classList.toggle('active', p.solo); engine.updateMutes(); autosave(); };
  msCol.append(muteBtn, soloBtn);
  fadRow.appendChild(msCol);
  strip.appendChild(fadRow);

  refs.polBtn = polBtn; refs.muteBtn = muteBtn; refs.soloBtn = soloBtn;
  refs.applyState = () => {
    const tp2 = project.tracks[i];
    inSel.value = tp2.input;
    armBtn.classList.toggle('armed', engine.transport.armed.has(i));
    eqInBtn.classList.toggle('active', p.eq.in);
    polBtn.classList.toggle('active', p.invert);
    muteBtn.classList.toggle('active', p.mute);
    soloBtn.classList.toggle('active', p.solo);
    const kv = (k, v) => k.setValue(v);
    kv(refs.knobs.eq_hf_freq, p.eq.hf.freq); kv(refs.knobs.eq_hf_gain, p.eq.hf.gain);
    kv(refs.knobs.eq_hmf_freq, p.eq.hmf.freq); kv(refs.knobs.eq_hmf_gain, p.eq.hmf.gain); kv(refs.knobs.eq_hmf_q, p.eq.hmf.q);
    kv(refs.knobs.eq_lmf_freq, p.eq.lmf.freq); kv(refs.knobs.eq_lmf_gain, p.eq.lmf.gain); kv(refs.knobs.eq_lmf_q, p.eq.lmf.q);
    kv(refs.knobs.eq_lf_freq, p.eq.lf.freq); kv(refs.knobs.eq_lf_gain, p.eq.lf.gain);
    kv(refs.knobs.comp_thr, p.comp.threshold); kv(refs.knobs.comp_ratio, p.comp.ratio);
    kv(refs.knobs.comp_atk, p.comp.attack * 1000); kv(refs.knobs.comp_rel, p.comp.release * 1000);
    kv(refs.knobs.comp_knee, p.comp.knee); kv(refs.knobs.comp_makeup, p.comp.makeup);
    kv(refs.knobs.lim_ceil, p.limiter.ceiling); kv(refs.knobs.lim_rel, p.limiter.release * 1000);
    kv(refs.knobs.pan, p.pan);
    fader.setPos(p.fader, false);
  };
  return strip;
}

// ---------------- master strip (unchanged) ----------------
let masterRefs = {};
function buildMaster() {
  const p = project.master;
  const m = el('div', 'strip master-strip');
  const title = el('div', 'sec-title');
  title.appendChild(el('span', '', 'MASTER BUS'));
  m.appendChild(title);

  const tubeSec = el('div', 'sec-title');
  tubeSec.appendChild(el('span', '', 'TUBE WARMTH'));
  m.appendChild(tubeSec);
  const tubeRow = el('div', 'tube-row');
  masterRefs.drive = makeKnob(tubeRow, {
    label: 'DRIVE', min: 0, max: 1, value: p.tubeDrive, format: (v) => Math.round(v * 100) + '%', accent: '#e07840',
    onChange: (v) => { p.tubeDrive = v; applyMaster(); autosave(); },
  });
  masterRefs.mix = makeKnob(tubeRow, {
    label: 'MIX', min: 0, max: 1, value: p.tubeMix, format: (v) => Math.round(v * 100) + '%', accent: '#e07840',
    onChange: (v) => { p.tubeMix = v; applyMaster(); autosave(); },
  });
  m.appendChild(tubeRow);

  const limSec = el('div', 'sec-title');
  limSec.appendChild(el('span', '', 'MASTER LIMITER'));
  m.appendChild(limSec);
  const limRow = el('div', 'tube-row');
  masterRefs.ceil = makeKnob(limRow, {
    label: 'CEIL', min: -12, max: 0, value: p.limCeiling, format: (v) => v.toFixed(1) + 'dB', accent: '#e06c5b',
    onChange: (v) => { p.limCeiling = v; applyMaster(); autosave(); },
  });
  m.appendChild(limRow);

  const fadSec = el('div', 'sec-title');
  fadSec.appendChild(el('span', '', 'OUT'));
  m.appendChild(fadSec);
  const fadRow = el('div', 'fad-row');
  const meterCv = el('canvas', 'master-meter');
  meterCv.width = 26; meterCv.height = 132;
  masterRefs.meterCv = meterCv;
  fadRow.appendChild(meterCv);
  const fader = new Fader({
    value: p.fader,
    onChange: (v) => { p.fader = v; applyMaster(); autosave(); },
  });
  masterRefs.fader = fader;
  fadRow.appendChild(fader.root);
  m.appendChild(fadRow);
  masterRefs.applyState = () => {
    masterRefs.drive.setValue(p.tubeDrive);
    masterRefs.mix.setValue(p.tubeMix);
    masterRefs.ceil.setValue(p.limCeiling);
    fader.setPos(p.fader, false);
  };
  return m;
}

// ---------------- tape timeline ----------------
const PXSEC = 60; // timeline pixels per second
let laneCanvases = [];

function xToTime(cv, e) {
  const r = cv.getBoundingClientRect();
  return Math.max(0, (e.clientX - r.left) / PXSEC);
}

function buildTape() {
  const wrap = $('#tape');
  wrap.innerHTML = '';
  const head = el('div', 'tape-head');
  head.appendChild(el('div', 'seq-title', 'TAPE — 8 TRACK'));
  head.appendChild(el('div', 'tape-note',
    'click a lane to move the playhead · drop audio onto a lane to place a clip · autosave keeps settings + clip layout only (no audio — use SAVE)'));
  wrap.appendChild(head);
  const scroll = el('div', 'lanes-scroll');
  const inner = el('div', 'lanes-inner');
  inner.id = 'lanes-inner';
  laneCanvases = [];
  for (let i = 0; i < TRACKS; i++) {
    const lane = el('div', 'lane');
    const lab = el('div', 'lane-label', 'TRK ' + (i + 1));
    lab.id = 'lanelabel-' + i;
    const cv = el('canvas', 'lane-cv');
    cv.height = 54;
    cv.addEventListener('click', (e) => { engine.seek(xToTime(cv, e)); });
    cv.addEventListener('dragover', (e) => { e.preventDefault(); cv.classList.add('drop'); });
    cv.addEventListener('dragleave', () => cv.classList.remove('drop'));
    cv.addEventListener('drop', async (e) => {
      e.preventDefault(); cv.classList.remove('drop');
      const f = e.dataTransfer.files[0];
      if (!f) return;
      try {
        await engine.importFile(i, f, xToTime(cv, e));
        renderLanes(); autosave();
        toast('imported ' + f.name);
      } catch {
        toast('could not decode ' + f.name);
      }
    });
    lane.append(lab, cv);
    inner.appendChild(lane);
    laneCanvases.push(cv);
  }
  const ph = el('div', 'playhead');
  ph.id = 'playhead';
  inner.appendChild(ph);
  scroll.appendChild(inner);
  wrap.appendChild(scroll);
  renderLanes();
}

function drawWave(g, pcm, x, w, h) {
  const d = pcm.data, ch = pcm.channels;
  const frames = Math.floor(d.length / ch);
  if (frames < 1 || w < 1) return;
  g.fillStyle = '#7fd4a8';
  const mid = h / 2;
  for (let px = 0; px < w; px++) {
    const f0 = Math.floor((px / w) * frames);
    const f1 = Math.max(f0 + 1, Math.floor(((px + 1) / w) * frames));
    let mn = 1, mx = -1;
    const stride = Math.max(1, Math.floor((f1 - f0) / 24));
    for (let f = f0; f < f1 && f < frames; f += stride) {
      const v = d[f * ch];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const y1 = mid - mx * (mid - 2), y2 = mid - mn * (mid - 2);
    g.fillRect(x + px, y1, 1, Math.max(1, y2 - y1));
  }
}

function renderLanes() {
  const width = Math.max(1200, Math.ceil((mixEnd(project) + 5) * PXSEC));
  for (let i = 0; i < TRACKS; i++) {
    const cv = laneCanvases[i];
    cv.width = width;
    const g = cv.getContext('2d');
    const H = cv.height;
    g.clearRect(0, 0, width, H);
    g.fillStyle = '#141416';
    g.fillRect(0, 0, width, H);
    // second marks
    g.fillStyle = '#2c2c31';
    g.font = '9px sans-serif';
    for (let s = 0; s * PXSEC < width; s += 5) {
      g.fillRect(s * PXSEC, 0, 1, 5);
      g.fillStyle = '#3a3a40';
      g.fillText(s + 's', s * PXSEC + 3, 10);
      g.fillStyle = '#2c2c31';
    }
    const armed = engine.transport.armed.has(i);
    for (const clip of project.tracks[i].clips) {
      const x = clip.startOffset * PXSEC;
      const w = Math.max(3, clip.duration * PXSEC);
      g.fillStyle = armed ? 'rgba(224,108,91,.25)' : 'rgba(127,212,168,.16)';
      g.fillRect(x, 12, w, H - 24);
      g.strokeStyle = armed ? '#e06c5b' : '#7fd4a8';
      g.strokeRect(x + 0.5, 12.5, w, H - 24);
      if (clip.pcm) {
        drawWave(g, clip.pcm, x + 2, w - 4, H - 28);
      } else {
        // audio missing (e.g. restored from autosave): hatch it
        g.strokeStyle = '#8a8578';
        g.beginPath();
        for (let hx = x; hx < x + w; hx += 8) {
          g.moveTo(hx, H - 12); g.lineTo(hx + 8, 12);
        }
        g.stroke();
        g.fillStyle = '#8a8578';
        g.font = '9px sans-serif';
        g.fillText('NO AUDIO', x + 4, H / 2 + 3);
      }
      g.fillStyle = '#d8d2c4';
      g.font = '9px sans-serif';
      const label = clip.name + ' @' + clip.startOffset.toFixed(1) + 's';
      g.fillText(label.slice(0, 40), x + 4, 11);
    }
    const lab = $('#lanelabel-' + i);
    if (lab) lab.classList.toggle('armed', armed);
  }
  const inner = $('#lanes-inner');
  if (inner) inner.style.width = width + 64 + 'px';
}

// ---------------- rebuild ----------------
function rebuildAll() {
  for (let i = 0; i < TRACKS; i++) stripRefs[i].applyState();
  masterRefs.applyState();
  vsKnob.setValue(rateToVarispeed(project.varispeed || 1));
  engine.varispeed = project.varispeed || 1;
  renderLanes();
  applyAll();
}

// ---------------- meters + tape UI loop ----------------
const peakHold = new Array(TRACKS).fill(0);
let masterHold = [0, 0];

function drawReel(cv, angle, rec) {
  const g = cv.getContext('2d');
  const S = 54, c = S / 2;
  g.clearRect(0, 0, S, S);
  g.strokeStyle = rec ? '#e06c5b' : '#8a8578';
  g.lineWidth = 3;
  g.beginPath(); g.arc(c, c, 22, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(c, c, 6, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = rec ? '#e06c5b' : '#d8d2c4';
  g.lineWidth = 4;
  for (let k = 0; k < 3; k++) {
    const a = angle + (k * Math.PI * 2) / 3;
    g.beginPath();
    g.moveTo(c + Math.cos(a) * 7, c + Math.sin(a) * 7);
    g.lineTo(c + Math.cos(a) * 20, c + Math.sin(a) * 20);
    g.stroke();
  }
}

function meterLoop() {
  requestAnimationFrame(meterLoop);
  const now = performance.now();
  const dt = lastFrameT ? (now - lastFrameT) / 1000 : 0;
  lastFrameT = now;
  if (!engine.ctx) return;
  const st = engine.transport.state;
  const rolling = st === ST_PLAYING || st === ST_RECORDING;
  // tape UI
  counterEl.textContent = fmtCounter(engine.positionNow());
  if (rolling) reelAngle += dt * 3.2 * engine.varispeed;
  drawReel(reelL, reelAngle, st === ST_RECORDING);
  drawReel(reelR, -reelAngle * 0.92, st === ST_RECORDING);
  const ph = $('#playhead');
  if (ph) ph.style.left = 64 + engine.positionNow() * PXSEC + 'px';
  // meters
  for (let i = 0; i < TRACKS; i++) {
    const pk = engine.channelPeak(i);
    peakHold[i] = Math.max(pk, peakHold[i] * 0.985);
    drawVertMeter(stripRefs[i].meterCv, pk, peakHold[i]);
    const gr = Math.min(24, -(engine.channelGR(i) || 0));
    drawGR(stripRefs[i].grCv, gr / 24);
  }
  const [l, r] = engine.masterPeaks();
  masterHold[0] = Math.max(l, masterHold[0] * 0.985);
  masterHold[1] = Math.max(r, masterHold[1] * 0.985);
  drawStereoMeter(masterRefs.meterCv, l, r, masterHold[0], masterHold[1]);
}

function drawVertMeter(cv, peak, hold) {
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#101010';
  g.fillRect(0, 0, W, H);
  const h = Math.min(1, peak) * H;
  const grad = g.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, '#3fae5a'); grad.addColorStop(0.7, '#e0c458'); grad.addColorStop(0.92, '#e06c5b');
  g.fillStyle = grad;
  g.fillRect(0, H - h, W, h);
  const hy = H - Math.min(1, hold) * H;
  g.fillStyle = '#f2ede4';
  g.fillRect(0, hy, W, 2);
}

function drawGR(cv, amt) {
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#101010';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#c9a0dc';
  g.fillRect(0, H - amt * H, W, amt * H);
}

function drawStereoMeter(cv, l, r, hl, hr) {
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#101010';
  g.fillRect(0, 0, W, H);
  const bw = W / 2 - 2;
  const grad = g.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, '#3fae5a'); grad.addColorStop(0.7, '#e0c458'); grad.addColorStop(0.92, '#e06c5b');
  g.fillStyle = grad;
  g.fillRect(1, H - Math.min(1, l) * H, bw, Math.min(1, l) * H);
  g.fillRect(bw + 3, H - Math.min(1, r) * H, bw, Math.min(1, r) * H);
  g.fillStyle = '#f2ede4';
  g.fillRect(1, H - Math.min(1, hl) * H, bw, 2);
  g.fillRect(bw + 3, H - Math.min(1, hr) * H, bw, 2);
}

// ---------------- boot ----------------
function boot() {
  buildTopbar();
  const strips = $('#strips');
  for (let i = 0; i < TRACKS; i++) strips.appendChild(buildStrip(i));
  $('#master-wrap').appendChild(buildMaster());
  buildTape();
  refreshTransport();

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName || '')) {
      e.preventDefault();
      togglePlayStop();
    }
  });

  requestAnimationFrame(meterLoop);
}

async function togglePlayStop() {
  const st = engine.transport.state;
  if (st === ST_STOPPED) await onPlay();
  else await onStop();
}

document.addEventListener('DOMContentLoaded', boot);

// debug / scripting handle (also used by automated verification)
window.__console8 = {
  engine,
  get project() { return project; },
  get transport() { return engine.transport; },
};
