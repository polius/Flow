#!/usr/bin/env python3
"""Generate the score: a warm lo-fi groove arranged to the film.

Synthesized from scratch (no samples, no licensing), so the video never depends
on a music asset. It shares one beat grid with the picture: web/engine.js
anchors it on the opening hit and marks the moment the pointer presses Play,
and cues.json carries both ("beat0", "groove"). The EQ bars on screen are
computed from the same grid, so they move with what you hear. The voice ducks
the score later, in build.py.

  open      vinyl crackle, a Rhodes chord on the hit
  library   Rhodes chords, a soft shaker: waiting for someone to press play
  play ..   the needle drops on the click: kick, snare, swung hats, bass, a vibraphone line
  selfhost  breakdown: drums out, the keys filtered down
  outro     the last chord rings, the vibraphone rolls up

  music.py --timeline timeline.json --cues cues.json --out music.wav
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import soundfile as sf
from scipy import signal

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 48000
BPM = 86
BEAT = 60 / BPM
BAR = 4 * BEAT
SWING = 0.18                       # how late the off-beat 16ths land, in 16ths
PRE = 3.0                          # the held keys before the drop carry the open on their own
END = 2.2                          # the last chord, alone under the end card

# one chord per bar, descending: Fmaj9 – Em7 – Dm9 – Cmaj9; (bass, voicing)
CHORDS = [
    (41, [57, 60, 64, 67]),        # Fmaj9  (A C E G over F)
    (40, [55, 59, 62, 64]),        # Em7    (G B D E over E)
    (38, [53, 57, 60, 64]),        # Dm9    (F A C E over D)
    (36, [55, 59, 62, 64]),        # Cmaj9  (G B D E over C)
]
FINAL = (41, [53, 57, 60, 64, 67, 72])
# the vibraphone line, as (bar-in-4, beat, scale degree MIDI)
MOTIF = [(0, 0.5, 72), (0, 1.5, 74), (0, 2.5, 76), (1, 0.5, 74), (1, 2.0, 71), (2, 0.5, 69),
         (2, 1.5, 72), (2, 3.0, 76), (3, 0.5, 74), (3, 1.5, 71), (3, 2.5, 67)]

rng = np.random.default_rng(23)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def lp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, "low", fs=SR, output="sos"), x)


def hp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(signal.butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def add(buf, start, x, pan=0.0):
    """Mix mono `x` into stereo `buf` at `start` seconds, equal-power pan."""
    i = int(round(start * SR))
    if i >= buf.shape[0] or i + x.size <= 0:
        return
    if i < 0:
        x, i = x[-i:], 0
    x = x[: buf.shape[0] - i]
    a = (pan + 1) * np.pi / 4
    buf[i:i + x.size, 0] += x * np.cos(a)
    buf[i:i + x.size, 1] += x * np.sin(a)


def env(n, a, d, r=None):
    """attack/decay envelope over n samples (exponential decay, linear attack)."""
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) / d)
    if r:
        e *= np.clip((n / SR - t) / r, 0, 1)
    return e


def reverb_ir(seconds=2.4, decay=0.75):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)) * np.exp(-t / decay)[:, None]
    ir[:, 0] = lp(ir[:, 0], 5200); ir[:, 1] = lp(ir[:, 1], 5200)
    ir[: int(0.012 * SR)] = 0                     # pre-delay
    return ir / np.sqrt((ir ** 2).sum(axis=0))


# ---- instruments --------------------------------------------------------------
def rhodes(m, dur, vel=1.0):
    """an electric piano: FM tine + body, a slow tremolo, a soft release"""
    n = int((dur + 1.2) * SR)
    t = np.arange(n) / SR
    f = hz(m) * (1 + 0.0007 * (rng.random() - 0.5))
    idx = 1.6 * np.exp(-t / 0.35) * vel + 0.25
    body = np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * t))
    tine = np.sin(2 * np.pi * f * 7.0 * t) * np.exp(-t / 0.06) * 0.25 * vel
    e = np.minimum(1, t / 0.004) * np.exp(-t / 1.9) * np.clip((dur + 1.2 - t) / 1.0, 0, 1)
    e *= np.where(t < dur, 1, np.exp(-(t - dur) / 0.25))
    trem = 1 + 0.12 * np.sin(2 * np.pi * 4.6 * t)
    return (body + tine) * e * trem * 0.06 * vel


def vibe(m, vel=1.0):
    n = int(2.2 * SR)
    t = np.arange(n) / SR
    f = hz(m)
    x = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * f * 4.0 * t) * np.exp(-t / 0.25)
    x *= np.minimum(1, t / 0.002) * np.exp(-t / 0.9) * (1 + 0.25 * np.sin(2 * np.pi * 5.5 * t))
    return x * 0.07 * vel


def kick():
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 47 + 75 * np.exp(-t / 0.03)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.22)
    click = lp(rng.standard_normal(n), 2500) * np.exp(-t / 0.004) * 0.15
    return lp(np.tanh(1.8 * (x + click)), 3000) * 0.75


def snare():
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    noise = bp(rng.standard_normal(n), 1200, 6500) * np.exp(-t / 0.11)
    body = np.sin(2 * np.pi * 185 * t) * np.exp(-t / 0.05)
    return lp(noise * 0.55 + body * 0.5, 7000) * 0.42


def hat(open_=False):
    n = int((0.22 if open_ else 0.06) * SR)
    x = hp(rng.standard_normal(n), 7000, 4) * env(n, 0.001, 0.08 if open_ else 0.022)
    return lp(x, 11000) * 0.32


def shaker():
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    x = bp(rng.standard_normal(n), 5000, 11000) * np.minimum(1, t / 0.02) * np.exp(-t / 0.035)
    return x * 0.14


def bass_note(m, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m)
    x = np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t) + 0.08 * np.sin(2 * np.pi * 3 * f * t)
    x = np.tanh(1.4 * x) * np.minimum(1, t / 0.006) * np.exp(-t / 1.1) * np.clip((dur - t) / 0.03, 0, 1)
    return lp(x, 900) * 0.34


def crackle(dur):
    """vinyl: a faint hiss and sparse dust clicks"""
    n = int(dur * SR)
    hiss = bp(rng.standard_normal(n), 2500, 9000) * 0.006
    clicks = np.zeros(n)
    for _ in range(int(dur * 9)):
        i = rng.integers(0, n - 200)
        clicks[i: i + 40] += rng.standard_normal(40) * np.exp(-np.arange(40) / 6) * (0.03 + 0.09 * rng.random() ** 3)
    return hiss + lp(clicks, 6000)


# ---- arrangement --------------------------------------------------------------
def build(timeline, cues):
    dur = timeline["video_end"]
    n = int(dur * SR) + SR
    keys = np.zeros((n, 2))       # filtered in the breakdown, ducked by the kick
    bass = np.zeros((n, 2))
    drums = np.zeros((n, 2))
    send = np.zeros((n, 2))       # into the reverb

    starts = {s["name"]: s["start"] for s in timeline["scenes"]}
    b0 = next(c["t"] for c in cues if c["type"] == "beat0")
    drop = next(c["t"] for c in cues if c["type"] == "groove")
    hits = sorted(c["t"] for c in cues if c["type"] == "hit")
    end_hit = hits[-1]
    # two grids on one tempo: held chords from the opening hit, then the groove's
    # bars counted from the drop, so the click on Play is always beat one
    snap = lambda t, g: g + round((t - g) / BEAT) * BEAT
    shake0 = snap(starts["library"], b0)
    brk = snap(starts["selfhost"], drop)
    pre_bars = [b0 + k * BAR for k in range(int((drop - b0) / BAR) + 1) if b0 + k * BAR < drop - 1e-6]
    bars = [drop + k * BAR for k in range(int((end_hit - drop) / BAR) + 1) if drop + k * BAR < end_hit - 0.05]
    swing16 = lambda b, s: b + s * BEAT / 4 + (SWING * BEAT / 4 if s % 2 else 0)

    # keys: held chords until the drop, then comped on the swing
    for k, t in enumerate(pre_bars):
        voice = CHORDS[k % 4][1]
        d = min(BAR, drop - t) * 0.98
        for j, m in enumerate(voice):
            add(keys, t + j * 0.012, rhodes(m, d, 0.8) * PRE, pan=-0.3 + 0.2 * j)
            add(send, t + j * 0.012, rhodes(m, d, 0.8) * 0.3 * PRE, pan=-0.3 + 0.2 * j)
    for k, t in enumerate(bars):
        voice = CHORDS[k % 4][1]
        for at_beat, d, v in ((0, 1.4, 0.9), (1.75, 0.5, 0.6), (2.5, 1.3, 0.75)):
            tt = t + at_beat * BEAT + (SWING * BEAT / 4 if (at_beat * 4) % 2 else 0)
            for j, m in enumerate(voice):
                add(keys, tt + j * 0.01, rhodes(m, d * BEAT, v), pan=-0.3 + 0.2 * j)
                add(send, tt + j * 0.01, rhodes(m, d * BEAT, v) * 0.35, pan=-0.3 + 0.2 * j)
    # the open: one chord before the hit, swelling up
    for j, m in enumerate(CHORDS[3][1]):
        x = rhodes(m, b0 + 0.2, 0.5)
        x *= np.minimum(1, np.arange(x.size) / SR / max(0.1, b0))
        add(keys, 0.05, x * PRE, pan=-0.3 + 0.2 * j)
    # the end: the final chord rings, the vibraphone rolls up
    for j, m in enumerate(FINAL[1]):
        add(keys, end_hit + j * 0.03, rhodes(m, dur - end_hit - 1.0, 0.9) * END, pan=-0.35 + 0.14 * j)
        add(send, end_hit + j * 0.03, rhodes(m, dur - end_hit - 1.0, 0.9) * 0.5 * END)
    for k, m in enumerate([65, 69, 72, 76, 79, 84]):
        v = vibe(m, 0.8 * np.exp(-k / 6)) * END
        add(keys, end_hit + 0.35 + k * BEAT / 3, v, pan=0.35 if k % 2 else -0.35)
        add(send, end_hit + 0.35 + k * BEAT / 3, v * 0.8)

    # bass: from the drop to the breakdown
    for k, t in enumerate(bars):
        if t >= brk - 1e-6:
            break
        root = CHORDS[k % 4][0]
        for at_beat, d, m in ((0, 1.6, root), (1.75, 0.35, root), (2.5, 0.9, root + 7), (3.5, 0.45, root + 12)):
            add(bass, t + at_beat * BEAT + (SWING * BEAT / 4 if (at_beat * 4) % 2 else 0), bass_note(m, d * BEAT))

    # drums: the groove from the drop; a shaker while waiting and in the breakdown
    K, S = kick(), snare()
    kicks = []
    for t in bars:
        for bb in range(4):
            b = t + bb * BEAT
            if b >= brk - 1e-6:
                break
            if bb == 0:
                add(drums, b, K); kicks.append(b)
            if bb == 2:
                add(drums, b + BEAT / 2 + SWING * BEAT / 4, K * 0.75); kicks.append(b + BEAT / 2)
            if bb in (1, 3):
                add(drums, b, S, pan=0.05); add(send, b, S * 0.5)
            for s in range(4):
                v = (0.55, 0.25, 0.4, 0.22)[s] * (0.0 if (s == 2 and bb == 3) else 1.0)
                add(drums, swing16(b, s), hat() * v, pan=0.3)
            if bb == 3:
                add(drums, swing16(b, 2), hat(open_=True) * 0.35, pan=0.3)
    shakes = [shake0 + i * BEAT for i in range(int((drop - shake0) / BEAT) + 1) if shake0 + i * BEAT < drop - 1e-6]
    shakes += [brk + i * BEAT for i in range(int((end_hit - brk) / BEAT) + 1) if brk + i * BEAT < end_hit - 1e-6]
    for b in shakes:
        for s in (0, 2):
            add(drums, swing16(b, s), shaker() * (1.0 if s == 0 else 0.7), pan=0.25)
    # the needle drops on the click
    add(drums, drop - 0.03, crackle(0.2) * 3)

    # the vibraphone line: every other four bars of the groove
    for k, t in enumerate(bars):
        if t >= brk - 1e-6 or (k // 4) % 2 == 0:
            continue
        for barN, bt, m in MOTIF:
            if barN == k % 4:
                tt = t + bt * BEAT + (SWING * BEAT / 4 if bt % 1 else 0)
                v = vibe(m, 0.8)
                add(keys, tt, v, pan=0.3)
                add(send, tt, v * 0.9, pan=-0.3)

    # the breakdown: the keys under a closing low-pass, back open for the end card
    split = int(brk * SR); reopen = int(end_hit * SR)
    for c in range(2):
        filtered = lp(keys[:, c], 900, 2)
        mix = np.zeros(n)
        mix[split:reopen] = 1
        ramp_n = int(0.6 * SR)
        mix[split:split + ramp_n] = np.linspace(0, 1, ramp_n)
        keys[:, c] = keys[:, c] * (1 - mix) + filtered * mix * 1.8

    # sidechain: keys and bass lean back under the kick
    duck = np.ones(n)
    for b in kicks:
        i0 = int(b * SR)
        k = np.arange(min(int(0.3 * SR), n - i0)) / SR
        duck[i0:i0 + k.size] = np.minimum(duck[i0:i0 + k.size], 1 - 0.35 * np.exp(-k / 0.09))
    keys *= duck[:, None]; bass *= duck[:, None]

    ir = reverb_ir(2.6, 0.8)
    wet = np.stack([signal.fftconvolve(send[:, c], ir[:, c])[:n] for c in range(2)], axis=1)
    vinyl = crackle(n / SR)
    out = keys + bass + drums * 0.85 + wet * 0.5
    out[:, 0] += vinyl; out[:, 1] += np.roll(vinyl, 997)
    out = out[: int(dur * SR)]

    # tape warmth + fades, then leave headroom for the voice
    t = np.arange(out.shape[0]) / SR
    out *= np.minimum(1, t / 0.3)[:, None]
    out *= np.clip((dur - t) / 2.2, 0, 1)[:, None]
    out[:, 0] = lp(out[:, 0], 12000); out[:, 1] = lp(out[:, 1], 12000)
    out = np.tanh(out * 1.3) / 1.3
    return out / max(1e-9, np.abs(out).max()) * 0.6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", default=os.path.join(HERE, "timeline.json"))
    ap.add_argument("--cues", default=os.path.join(HERE, "cues.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "music.wav"))
    args = ap.parse_args()
    data = build(json.load(open(args.timeline)), json.load(open(args.cues)))
    sf.write(args.out, data, SR, subtype="PCM_24")
    print(f"music: {args.out}  {data.shape[0] / SR:.1f}s")


if __name__ == "__main__":
    main()
