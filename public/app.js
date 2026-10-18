// Console-8 — UI: console strips, knobs, sequencer, transport, meters.
import {
  knobToLog, knobToLin, logToKnob, midiToName,
  SOURCE_LABELS, MELODIC, eqDefaults,
} from '../src/dsp.js';
import {
  STEPS, CHANNELS, PATTERN_IDS, toggleStep,
  newProject, serializeProject, deserializeProject,
} from '../src/sequencer.js';
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

let saveTimer = null;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('console-8-project', serializeProject(project)); } catch {}
    $('#save-state').textContent = 'autosaved ' + new Date().toLocaleTimeString();
  }, 600);
}

function applyChannel(i) {
  if (engine.ctx) engine.applyChannel(i, project.channels[i]);
}
function applyMaster() {
  if (engine.ctx) engine.applyMaster(project.master);
}
function applyAll() {
  for (let i = 0; i < CHANNELS; i++) applyChannel(i);
  applyMaster();
}

// ---------------- top bar ----------------
function buildTopbar() {
  const bar = $('#topbar');
  bar.append(el('div', 'logo', 'CONSOLE-8'));
  const tp = el('div', 'transport');
  const playBtn = el('button', 'play-btn', '▶ PLAY');
  playBtn.id = 'play-btn';
  playBtn.onclick = togglePlay;
  tp.appendChild(playBtn);
  bar.appendChild(tp);

  const tempoWrap = el('div', 'top-group');
  tempoWrap.appendChild(el('span', 'top-label', 'TEMPO'));
  const tempoKnob = makeKnob(tempoWrap, {
    label: 'BPM', min: 60, max: 200, value: project.tempo, format: (v) => Math.round(v) + '',
    accent: '#7fd4a8',
    onChange: (v) => { project.tempo = Math.round(v); autosave(); },
  });
  window._tempoKnob = tempoKnob;
  const swingKnob = makeKnob(tempoWrap, {
    label: 'SWING', min: 0, max: 0.6, value: project.swing, format: (v) => Math.round(v * 100) + '%',
    accent: '#7fb8d4',
    onChange: (v) => { project.swing = v; autosave(); },
  });
  window._swingKnob = swingKnob;
  bar.appendChild(tempoWrap);

  const patWrap = el('div', 'top-group');
  patWrap.appendChild(el('span', 'top-label', 'PATTERN'));
  const patBtns = el('div', 'pat-btns');
  window._patBtns = {};
  for (const id of PATTERN_IDS) {
    const b = el('button', 'pat-btn' + (project.currentPattern === id ? ' active' : ''), id);
    b.onclick = () => selectPattern(id);
    window._patBtns[id] = b;
    patBtns.appendChild(b);
  }
  patWrap.appendChild(patBtns);
  bar.appendChild(patWrap);

  const songWrap = el('div', 'top-group');
  songWrap.appendChild(el('span', 'top-label', 'SONG'));
  const songToggle = el('button', 'song-toggle' + (project.songMode ? ' active' : ''), project.songMode ? 'SONG: ON' : 'SONG: OFF');
  songToggle.onclick = () => {
    project.songMode = !project.songMode;
    songToggle.textContent = project.songMode ? 'SONG: ON' : 'SONG: OFF';
    songToggle.classList.toggle('active', project.songMode);
    autosave();
  };
  window._songToggle = songToggle;
  songWrap.appendChild(songToggle);
  const songRow = el('div', 'song-row');
  window._songChips = el('div', 'song-chips');
  songRow.appendChild(window._songChips);
  const addRow = el('div', 'song-add');
  for (const id of PATTERN_IDS) {
    const b = el('button', 'song-add-btn', '+' + id);
    b.onclick = () => { project.song.push(id); renderSong(); autosave(); };
    addRow.appendChild(b);
  }
  const back = el('button', 'song-add-btn', '⌫');
  back.onclick = () => { project.song.pop(); renderSong(); autosave(); };
  const clr = el('button', 'song-add-btn', 'CLR');
  clr.onclick = () => { project.song = []; renderSong(); autosave(); };
  addRow.append(back, clr);
  songRow.appendChild(addRow);
  songWrap.appendChild(songRow);
  bar.appendChild(songWrap);

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
  fileWrap.append(saveBtn, loadBtn, loadInput, el('span', 'save-state', ''));
  loadInput.id = 'load-input';
  fileWrap.querySelector('.save-state').id = 'save-state';
  bar.appendChild(fileWrap);
  renderSong();
}

function renderSong() {
  const w = window._songChips;
  w.innerHTML = '';
  project.song.forEach((id) => w.appendChild(el('span', 'song-chip', id)));
  if (!project.song.length) w.appendChild(el('span', 'song-empty', '— empty —'));
}

function selectPattern(id) {
  project.currentPattern = id;
  for (const k of PATTERN_IDS) window._patBtns[k].classList.toggle('active', k === id);
  renderGrid();
  autosave();
}

function downloadProject() {
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'console-8-project.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
  const strip = el('div', 'strip');
  const refs = { knobs: {} };
  stripRefs[i] = refs;

  const head = el('div', 'strip-head');
  head.appendChild(el('span', 'ch-num', String(i + 1).padStart(2, '0')));
  const srcSel = el('select', 'src-sel');
  for (const s of ['kick', 'snare', 'clap', 'chat', 'ohat', 'bass', 'keys', 'lead', 'sample']) {
    const o = el('option', '', SOURCE_LABELS[s]);
    o.value = s;
    srcSel.appendChild(o);
  }
  srcSel.value = p.source;
  srcSel.onchange = () => {
    p.source = srcSel.value;
    noteSel.style.display = MELODIC.has(p.source) ? '' : 'none';
    loadSampleBtn.style.display = p.source === 'sample' ? '' : 'none';
    renderRowLabel(i);
    autosave();
  };
  head.appendChild(srcSel);
  strip.appendChild(head);

  const noteRow = el('div', 'note-row');
  const noteSel = el('select', 'note-sel');
  for (let m = 24; m <= 96; m++) {
    const o = el('option', '', midiToName(m));
    o.value = m;
    noteSel.appendChild(o);
  }
  noteSel.value = p.note;
  noteSel.style.display = MELODIC.has(p.source) ? '' : 'none';
  noteSel.onchange = () => { p.note = +noteSel.value; autosave(); };
  const loadSampleBtn = el('button', 'sample-btn', 'LOAD SMPL');
  loadSampleBtn.style.display = p.source === 'sample' ? '' : 'none';
  const fileIn = el('input');
  fileIn.type = 'file'; fileIn.accept = 'audio/*'; fileIn.style.display = 'none';
  fileIn.onchange = async () => {
    if (!fileIn.files[0]) return;
    await ensureCtx();
    const dur = await engine.loadSample(i, fileIn.files[0]);
    loadSampleBtn.textContent = 'SMPL ✓ ' + dur.toFixed(1) + 's';
    fileIn.value = '';
  };
  loadSampleBtn.onclick = () => fileIn.click();
  noteRow.append(noteSel, loadSampleBtn, fileIn);
  strip.appendChild(noteRow);

  // drop zone for samples
  strip.addEventListener('dragover', (e) => { e.preventDefault(); strip.classList.add('drop'); });
  strip.addEventListener('dragleave', () => strip.classList.remove('drop'));
  strip.addEventListener('drop', async (e) => {
    e.preventDefault(); strip.classList.remove('drop');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    await ensureCtx();
    await engine.loadSample(i, f);
    p.source = 'sample'; srcSel.value = 'sample';
    noteSel.style.display = 'none'; loadSampleBtn.style.display = '';
    loadSampleBtn.textContent = 'SMPL ✓';
    renderRowLabel(i);
    autosave();
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
  // attack/release knobs work in ms; the engine stores seconds
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
  refs.srcSel = srcSel; refs.noteSel = noteSel; refs.loadSampleBtn = loadSampleBtn;
  refs.applyState = () => {
    srcSel.value = p.source;
    noteSel.value = p.note;
    noteSel.style.display = MELODIC.has(p.source) ? '' : 'none';
    loadSampleBtn.style.display = p.source === 'sample' ? '' : 'none';
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

// ---------------- master strip ----------------
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

// ---------------- sequencer grid ----------------
let gridBtns = [];
function buildSequencer() {
  const wrap = $('#seq');
  wrap.innerHTML = '';
  wrap.appendChild(el('div', 'seq-title', 'STEP SEQUENCER'));
  const grid = el('div', 'seq-grid');
  gridBtns = [];
  for (let ch = 0; ch < CHANNELS; ch++) {
    const label = el('div', 'seq-row-label', '');
    label.id = 'rowlabel-' + ch;
    grid.appendChild(label);
    const row = [];
    for (let s = 0; s < STEPS; s++) {
      const b = el('button', 'step' + (s % 4 === 0 ? ' beat' : ''));
      b.dataset.ch = ch; b.dataset.step = s;
      b.onclick = (e) => {
        const v = toggleStep(project.patterns[project.currentPattern], ch, s);
        paintStep(b, v);
        autosave();
        void e;
      };
      b.oncontextmenu = (e) => {
        e.preventDefault();
        const pat = project.patterns[project.currentPattern];
        pat[ch][s] = pat[ch][s] === 2 ? 0 : 2;
        paintStep(b, pat[ch][s]);
        autosave();
      };
      grid.appendChild(b);
      row.push(b);
    }
    gridBtns.push(row);
  }
  wrap.appendChild(grid);
  const hint = el('div', 'seq-hint', 'click: toggle step · right-click: accent · space: play/stop');
  wrap.appendChild(hint);
  renderGrid();
}

function paintStep(b, v) {
  b.classList.toggle('on', v === 1);
  b.classList.toggle('accent', v === 2);
}

function renderGrid() {
  const pat = project.patterns[project.currentPattern];
  for (let ch = 0; ch < CHANNELS; ch++)
    for (let s = 0; s < STEPS; s++) paintStep(gridBtns[ch][s], pat[ch][s]);
  renderRowLabels();
}

function renderRowLabel(i) {
  const lab = $('#rowlabel-' + i);
  if (lab) lab.textContent = `${i + 1} ${SOURCE_LABELS[project.channels[i].source] || ''}`;
}
function renderRowLabels() {
  for (let i = 0; i < CHANNELS; i++) renderRowLabel(i);
}

// ---------------- transport ----------------
async function ensureCtx() {
  if (!engine.ctx) {
    await engine.init();
    engine.wireBus();
    applyAll();
  }
  if (engine.ctx.state === 'suspended') await engine.ctx.resume();
}

async function togglePlay() {
  await ensureCtx();
  const btn = $('#play-btn');
  if (engine.playing) {
    engine.stop();
    btn.textContent = '▶ PLAY';
    btn.classList.remove('playing');
    clearPlayhead();
  } else {
    engine.play();
    btn.textContent = '⏹ STOP';
    btn.classList.add('playing');
  }
}

function clearPlayhead() {
  for (const row of gridBtns) for (const b of row) b.classList.remove('play');
  $('#now-playing').textContent = '';
}

function rebuildAll() {
  // refresh knobs/buttons from a freshly loaded project
  window._tempoKnob.setValue(project.tempo);
  window._swingKnob.setValue(project.swing);
  for (const k of PATTERN_IDS) window._patBtns[k].classList.toggle('active', k === project.currentPattern);
  window._songToggle.textContent = project.songMode ? 'SONG: ON' : 'SONG: OFF';
  window._songToggle.classList.toggle('active', project.songMode);
  renderSong();
  for (let i = 0; i < CHANNELS; i++) stripRefs[i].applyState();
  masterRefs.applyState();
  renderGrid();
  applyAll();
}

// ---------------- meters ----------------
const peakHold = new Array(CHANNELS).fill(0);
let masterHold = [0, 0];

function meterLoop() {
  requestAnimationFrame(meterLoop);
  if (!engine.ctx) return;
  for (let i = 0; i < CHANNELS; i++) {
    const pk = engine.channelPeak(i);
    peakHold[i] = Math.max(pk, peakHold[i] * 0.985);
    drawVertMeter(stripRefs[i].meterCv, pk, peakHold[i]);
    const gr = Math.min(24, -(engine.channelGR(i) || 0)); // 0..24 dB
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
  for (let i = 0; i < CHANNELS; i++) strips.appendChild(buildStrip(i));
  $('#master-wrap').appendChild(buildMaster());
  buildSequencer();
  const np = el('div', 'now-playing');
  np.id = 'now-playing';
  $('#seq').appendChild(np);

  engine.onStep = (step, pid) => {
    clearPlayhead();
    if (step < 0) return;
    for (const row of gridBtns) row[step].classList.add('play');
    // in song mode the grid shows the current pattern; switch view to follow
    if (project.songMode && pid !== project.currentPattern) selectPattern(pid);
    $('#now-playing').textContent = project.songMode ? `playing pattern ${pid}` : '';
  };

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName || '')) {
      e.preventDefault();
      togglePlay();
    }
  });

  requestAnimationFrame(meterLoop);
}

document.addEventListener('DOMContentLoaded', boot);

// debug / scripting handle (also used by automated verification)
window.__console8 = { engine, get project() { return project; } };
