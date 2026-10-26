# Flow video

The Flow promo: a **~1-minute, 1920×1080, 60 fps MP4** with a neural
voice-over, an original synthesized score, and sound design cued from the
picture.

It is built from scratch: a small **web "video engine"** (HTML/CSS/JS)
rendered deterministically by headless Chromium, one frame at a time. The
pipeline is the one behind the [fsend](https://github.com/polius/fsend),
[VAULT](https://github.com/polius/vault) and
[FileSync](https://github.com/polius/filesync) videos.

Design rules the film follows, so any future edit stays on-model:

- **One idea per shot.** Every screen says one thing, in big type, and the
  narration says the same thing at the same moment.
- **The app's own rules.** A light film, like the app: near-monochrome greys,
  artwork is the only colour, and exactly one accent, the red of the EQ bars on
  whatever is playing (`frontend/src/styles/tokens.css`).
- **Show the product.** The library, album, search and Now Playing scenes are
  a replica of the real app in its light theme (same layout, icons, sizes and strings as
  `frontend/src`), filled with the demo library's artists and albums
  (`backend/app/demo.py`). The demo's covers are flat pastels; the film paints
  each album a cover of its own.
- **The film is a record playing.** Every cut is a "next track" slide, the
  background takes the colours of what is playing (the app's ambience), the
  grooves of a record turn behind everything, and a playhead runs along the
  bottom edge.
- **One beat.** The score and the picture share a beat grid: it starts on the
  opening hit, and the groove drops on the frame the pointer presses Play. The
  EQ bars are computed from the same grid, so they move with what you hear.
- **Only true claims.** Everything said or shown matches the app, the README
  and `SECURITY.md`. Check there before changing a line.
- **Every sound has a cause on screen.** Scenes register their own cues, so
  sound and picture cannot drift apart.

This folder holds **only the source**. Frames, audio, the model weights and the
MP4 itself are all generated and git-ignored. Regenerate with `./make.sh`.

---

## Why not a screen recording

If every pixel is a **pure function of the timestamp**, then

- the same input always produces the same frame (reviews are meaningful),
- we can render at 2× and downsample, so type and thin strokes stay crisp at
  1080p (supersampling),
- timing is driven by the *measured* narration audio, so the visuals stay in
  sync no matter how fast the voice reads.

So the "renderer" is a web page, and the "render farm" is `page.screenshot()`
in a loop.

Scene arc, timed to the narration:

```
open (the tile lands, the note rings)  →  library  →  play (search, Now Playing)  →  sync  →  phone
     →  care (tags, repair)  →  selfhost  →  outro
```

---

## Setup

Needs **Python 3.10+**, **ffmpeg**, and a network connection for the first run.

```sh
cd scripts/explainer
./setup.sh --models        # venv + deps + chromium + Kokoro weights (~340 MB)
```

Everything is installed *inside this folder* (`.venv/`, `models/`).

## Build

```sh
./make.sh                                   # the whole pipeline -> flow-video.mp4
./make.sh --output ~/Desktop/flow.mp4
```

Stages (`build.py` prints them as `[n/7]`):

1. **narration**: `narration.py` synthesizes every line with **Kokoro-82M**
   (local ONNX, voice `af_heart`) and lays out `timeline.json`: scene windows
   plus *word onsets*. Each clip is transcribed back with **faster-whisper**
   (`small.en`, fetched once into `models/whisper/`): its word timestamps place
   the onsets, so a visual lands on the exact word it is spoken, and the
   transcript is printed as `heard:`, so a mispronounced word shows up in the
   build log.
2. **cues**: the page is loaded once and the scenes' sound-effect cues, plus
   the beat grid, are dumped to `cues.json`.
3. **capture**: `capture.py` drives headless Chromium, calling
   `window.__render(t)` and screenshotting every frame at **2×**, across
   parallel workers.
4. **audio**: `sfx.py` renders the cues, `music.py` composes the score, the
   voice ducks the score through a sidechain compressor, and the mix is
   two-pass loudness-normalized.
5. **encode**: lanczos-downscale to 1080p, BT.709 tags, a whisper of grain,
   x264 CRF 17.
6. **captions**: a `.srt` sidecar, one cue per sentence.
7. **mux**.

Useful flags:

```sh
./make.sh --skip-capture          # re-encode / re-mix from frames/ on disk
./make.sh --skip-narration        # reuse audio/ + timeline.json
./make.sh --workers 4 --crf 16 --grain 0
FPS=30 ./make.sh                  # a faster draft (also re-times the narration)
```

To look at stills while iterating on the visuals (fast, 1×, no encode):

```sh
.venv/bin/python capture.py --preview 9.5,17,38      # -> preview/*.png
```

To regenerate the README thumbnail:

```sh
./make.sh --poster 6.2                                # -> assets/video-poster.png
```

---

## Files

| File | Role |
|---|---|
| `narration.py` | the script and pacing. **Start here** to change the wording. |
| `web/engine.js` | the renderer: `render(t)`, scene layers and cameras, the "next track" cuts, the ambience wash and the grooves, the beat grid and the EQ levels, the cue registry |
| `web/scenes.js` | the eight scenes, the app replica, the album covers, the pointer |
| `web/style.css` | palette (the app's light theme), type, the app replica, devices, cards |
| `web/fonts/` | Inter + JetBrains Mono (both OFL), committed for offline builds |
| `capture.py` | http server + Playwright frame loop (`--preview`, `--poster`, `--cues`) |
| `music.py` | the score: 86 BPM lo-fi, Fmaj9–Em7–Dm9–Cmaj9; FM Rhodes, vibraphone, swung drums, bass, vinyl, arranged from the timeline and the beat grid |
| `sfx.py` | the sound design: skip, hit, fall, click, tap, pop, key, enter, tick, blip, swish, swell, wake, chime, deny, stream |
| `build.py` | orchestrates all seven stages |
| `setup.sh` / `make.sh` | one-time setup / one-shot build |

## Customizing

- **Wording and pacing**: edit `LINES` in `narration.py`. `GAP_SAME`,
  `GAP_SCENE` and `GAP_EXTRA` decide how fast the film feels. Adding a line?
  Give it a scene and, if a visual should land on a word, an anchor
  (`{"play": "play"}`); scenes read it with `api.on("<line-id>", "<anchor>")`.
- **Visuals**: `web/scenes.js` and `web/style.css`. A scene moves its camera
  with `camera(cam, t, keys)`, recolours the background with
  `api.ambience(t, a, b)`, puts a moment on the beat with `api.snap(t)`, and
  makes a sound with `api.cue(type, t, gain)`.
- **The app changed?** Update the replica (`topbarHTML()`, `playerHTML()` and
  the scene markup in `scenes.js`, the `.app` rules in `style.css`) so the film
  keeps matching it.

## Notes

- **Rendering cost is fill-rate bound.** Soft light is drawn with radial
  gradients, never `filter: blur()` on large layers. Film grain is added once
  by ffmpeg.
- Hidden scene layers use `display: none`, not `visibility: hidden`: a child
  set to `visibility: visible` by a reveal would otherwise show through.
- `at(parent, x, y, …)` already centres its child; don't add another
  `translate(-50%, -50%)` to it.
- Layout that depends on text size is measured in `afterFonts()`, which runs
  on the first rendered frame, before any transform is applied. Give every
  element its real text before then: an empty line measures as zero height.
- The beat grid is set by the scenes (`api.grid("t0", …)` in the open,
  `api.grid("drop", …)` in play) and reaches `music.py` through `cues.json`
  as the `beat0` and `groove` entries.
- **Do not commit** `frames/`, `preview/`, `audio/`, `captions/`,
  `timeline.json`, `cues.json`, `*.wav`, `*.mp4`, `models/` or `.venv/`.
