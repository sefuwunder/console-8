# Console-8

An 8-track tape machine in the browser: Portastudio-style multitrack recording
through SSL-style channel strips on every track and a tube-warmth stage on the
master bus. Bun + zero npm dependencies; all DSP runs in WebAudio.

Pickup: `git pull` then `bun src/server.ts` → http://127.0.0.1:3035

## Signal flow

Per track:

```
tape clip → 4-band EQ → compressor → limiter → polarity → pan → fader → mute/solo → master
```

Master bus:

```
mix bus → TUBE stage (drive → asymmetric soft saturation → gentle HF roll-off)
        → dry/wet mix → master limiter → master fader → out
```

## Tape workflow

1. **ARM** a track (red button in the strip head). Choose its record input:
   **Mic** or **File** (File-input tracks can't record from the mic).
2. Press **⏺ REC** — needs at least one armed Mic track. Existing clips keep
   playing underneath (overdub). Press **▶ PLAY** mid-take to punch out,
   **⏺ REC** mid-playback to punch in.
3. **⏹ STOP** writes each take as a clip at the punch-in point.
4. **⏮ RTZ** returns the tape to zero. Click a lane to move the playhead.
5. Drag an audio file onto a lane (or a strip) to import it as a clip at the
   drop point. **MON** lets you hear the mic through the strip (default off —
   watch for feedback with speakers).
6. **VARISPEED** (0.50x–1.50x, center detent at 1.00x) pitch-shifts playback
   like real tape. Double-click the knob to reset.
7. **BOUNCE** renders the full mix offline (clips + strips + tube) to a
   16-bit WAV download.

The counter reads `mm:ss`. The reels spin while the tape rolls (red while
recording).

## Channel strip

- **EQ** — 4 bands in the SSL channel tradition: HF (high shelf),
  HMF (peaking, freq + Q), LMF (peaking, freq + Q), LF (low shelf).
  `EQ IN` bypasses by zeroing band gains.
- **Dynamics** — compressor (threshold, ratio, attack, release, knee,
  makeup gain) with a live gain-reduction meter, followed by a fast
  limiter (ceiling + release).
- **Pan** (equal-power law), **Ø** polarity invert, **fader**, **M**ute,
  **S**olo, post-fader peak meter with peak-hold.

## Tube warmth

The master bus splits into a dry path and a tube path: drive gain →
`tanh`-family asymmetric soft saturation (even harmonics from the
asymmetry) at 4x oversampling → gentle 16.5 kHz roll-off → dry/wet mix.
Default is subtle by design: felt as glue and warmth, not heard as
distortion.

## Projects

- **SAVE** downloads the full project as JSON, clips included (audio is
  stored as base64 16-bit WAV inside the file).
- **Autosave** (localStorage) keeps settings + clip layout only — **audio is
  not restored from autosave** (quota). Clips without audio render hatched
  as `NO AUDIO` on the timeline.

## Notes

- Microphone recording needs mic permission; if denied or unavailable the
  transport refuses to record with a message — never a hang. Monitoring is
  off by default to avoid feedback.
- Recording uses MediaRecorder on the live mic stream; punch timing follows
  the transport clock within normal browser latency.
- Keyboard: `Space` = play/stop toggle.
