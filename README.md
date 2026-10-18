# Console-8

An 8-channel DAW in the browser: SSL-style channel strips on every channel,
a 16-step sequencer with 4 patterns + song mode, and a tube-warmth stage on
the master bus. Bun + zero npm dependencies; all DSP runs in WebAudio.

Pickup: `git pull` then `bun src/server.ts` → http://127.0.0.1:3035

## Signal flow

Per channel:

```
source → 4-band EQ → compressor → limiter → polarity → pan → fader → mute/solo → master
```

Master bus:

```
mix bus → TUBE stage (drive → asymmetric soft saturation → gentle HF roll-off)
        → dry/wet mix → master limiter → master fader → out
```

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
distortion. Push DRIVE past ~60% for audible saturation.

## Sources & sequencer

Each channel takes one source: Kick, Snare, Clap, Closed Hat, Open Hat
(synthesized drums), Bass, Keys, Lead (synthesized, with a per-channel
note picker), or Sample (load your own via the LOAD button or drag &
drop an audio file onto the strip).

- 16-step grid, 8 channels. Click a step to cycle off → on → accent;
  right-click toggles accent directly.
- 4 patterns (A–D). Song mode chains patterns from the editable song list.
- Tempo 60–200 BPM, swing 0–60%. Lookahead scheduler (25 ms / 120 ms),
  no drift.

## Keys

- `Space` — play / stop

## Project

`SAVE` downloads the project as JSON (patterns, all strip and master
params, tempo, song). Everything autosaves to localStorage. `LOAD`
restores a saved file.

## Tests

`bun test` — 37 tests covering the tube curve math, knob mappings,
pan law, sequencer timing/swing math, and project serialization.
