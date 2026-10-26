#!/usr/bin/env python3
"""Sound design: render the scenes' cue list (cues.json) into one effects track.

The scenes register every cue themselves (api.cue in web/), so a sound always
sits on the frame that causes it. Every effect is synthesized, like the music.

  sfx.py --cues cues.json --duration 56.5 --out sfx.wav
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import soundfile as sf
from scipy import signal

from music import SR, add, bp, env, hp, lp, reverb_ir

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(5)


def T(sec):
    return np.arange(int(sec * SR)) / SR


def sweep_noise(sec, f0, f1, q=0.5):
    """Noise through a band that glides from f0 to f1, with a bell envelope."""
    n = int(sec * SR)
    x = rng.standard_normal(n)
    out = np.zeros(n)
    hop = int(0.02 * SR)
    for i in range(0, n, hop):
        u = i / n
        c = f0 * (f1 / f0) ** u
        seg = bp(x[max(0, i - 4 * hop): i + hop], c * (1 - q), min(c * (1 + q), SR / 2.2))
        out[i:i + hop] = seg[-min(hop, n - i):]
    u = np.arange(n) / n
    return out * np.sin(np.pi * u) ** 1.6


def key():
    t = T(0.05)
    f = 1800 + rng.random() * 1400
    click = hp(rng.standard_normal(t.size), 2500) * np.exp(-t / 0.004)
    body = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.006) * 0.4
    thock = np.sin(2 * np.pi * (240 + rng.random() * 60) * t) * np.exp(-t / 0.012) * 0.5
    return (click * 0.6 + body + thock) * 0.16


def enter():
    t = T(0.12)
    return (hp(rng.standard_normal(t.size), 1500) * np.exp(-t / 0.006) * 0.5
            + np.sin(2 * np.pi * 170 * t) * np.exp(-t / 0.03)) * 0.26


def pop():
    """a woody, marimba-like pop"""
    t = T(0.3)
    f = 880 + rng.random() * 220
    x = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.05) + 0.4 * np.sin(2 * np.pi * f * 3.9 * t) * np.exp(-t / 0.012)
    return x * np.minimum(1, t / 0.001) * 0.16


def tick():
    t = T(0.08)
    return np.sin(2 * np.pi * 2600 * t) * np.exp(-t / 0.012) * 0.12


def blip():
    t = T(0.18)
    return (np.sin(2 * np.pi * 1320 * t) + 0.4 * np.sin(2 * np.pi * 1980 * t)) * env(t.size, 0.002, 0.04) * 0.14


def swish():
    return sweep_noise(0.5, 900, 6000, 0.45) * 0.5


def whoosh():
    x = sweep_noise(0.75, 250, 4200, 0.6) * 0.55
    t = T(0.75)
    rumble = lp(rng.standard_normal(t.size), 180) * np.sin(np.pi * t / 0.75) ** 2 * 0.6
    return x + rumble


def hit():
    """the tile lands: a soft, round thump and a warm shimmer (F major, high)"""
    t = T(3.0)
    f = 44 + 50 * np.exp(-t / 0.05)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.5) * 0.8
    knock = lp(rng.standard_normal(t.size), 1800) * np.exp(-t / 0.02) * 0.35
    shim = sum(np.sin(2 * np.pi * hz * t + i) for i, hz in enumerate((1396.9, 1760.0, 2093.0, 2637.0)))
    shim *= np.minimum(1, t / 0.02) * np.exp(-t / 1.2) * 0.045
    return np.tanh(1.2 * (sub + knock)) * 0.6 + shim


def thud():
    t = T(0.6)
    f = 55 + 70 * np.exp(-t / 0.04)
    return np.tanh(1.5 * (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.18)
                          + hp(rng.standard_normal(t.size), 2000) * np.exp(-t / 0.004) * 0.3)) * 0.55


def chime():
    t = T(1.8)
    x = np.zeros(t.size)
    for f0, d in ((1318.5, 0.0), (1975.5, 0.09)):      # E6 then B6
        tt = np.maximum(0, t - d)
        for k, a in ((1, 1), (2.76, 0.3), (5.4, 0.12)):  # bell-ish partials
            x += np.sin(2 * np.pi * f0 * k * tt) * a * np.exp(-tt / (0.6 / k)) * (t >= d)
    return x * np.minimum(1, t / 0.003) * 0.09


def deny():
    """a soft, low "no": two muted notes falling a third"""
    t = T(0.5)
    x = np.zeros(t.size)
    for f0, d in ((392.0, 0.0), (311.1, 0.13)):
        tt = np.maximum(0, t - d)
        x += np.sin(2 * np.pi * f0 * tt) * np.exp(-tt / 0.09) * (t >= d)
    return lp(x, 2000) * 0.12


def stream():
    """a quick shower of tiny data blips while the file moves"""
    n = int(1.0 * SR)
    x = np.zeros((n, 2))
    for k in range(26):
        at = k / 26 * 0.9 + rng.random() * 0.02
        f = 2000 + rng.random() * 3000
        tt = T(0.04)
        add(x, at, np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.008) * 0.05 * np.sin(np.pi * k / 26), pan=rng.random() * 1.4 - 0.7)
    return x


def skip():
    """the cut: a soft, airy slide, like a page turning"""
    x = sweep_noise(0.55, 2200, 700, 0.5) * 0.32
    return lp(x, 5000)


def fall():
    """the tile falling into place"""
    return sweep_noise(0.5, 3200, 900, 0.4) * 0.22


def click():
    t = T(0.06)
    return (hp(rng.standard_normal(t.size), 3000) * np.exp(-t / 0.0025) * 0.5
            + np.sin(2 * np.pi * 1300 * t) * np.exp(-t / 0.008) * 0.3) * 0.5


def tap():
    t = T(0.12)
    return (lp(rng.standard_normal(t.size), 1200) * np.exp(-t / 0.008) * 0.5
            + np.sin(2 * np.pi * 300 * t) * np.exp(-t / 0.02) * 0.4) * 0.45


def swell():
    """a short reverse swell into a moment"""
    t = T(0.7)
    x = sum(np.sin(2 * np.pi * f * t) for f in (523.3, 659.3, 784.0)) / 3
    return x * (t / 0.7) ** 2.5 * np.clip((0.7 - t) / 0.03, 0, 1) * 0.07


def wake():
    """the phone wakes: two soft notes, a fifth apart"""
    t = T(1.2)
    x = np.zeros(t.size)
    for f0, d in ((659.3, 0.0), (987.8, 0.08)):
        tt = np.maximum(0, t - d)
        x += np.sin(2 * np.pi * f0 * tt) * np.exp(-tt / 0.35) * (t >= d)
    return x * np.minimum(1, t / 0.004) * 0.07


FX = {"key": key, "enter": enter, "pop": pop, "tick": tick, "blip": blip, "swish": swish,
      "whoosh": whoosh, "hit": hit, "thud": thud, "chime": chime, "deny": deny, "stream": stream,
      "skip": skip, "fall": fall, "click": click, "tap": tap, "swell": swell, "wake": wake}
# how much of each effect goes to the reverb
SEND = {"skip": 0.25, "wake": 0.5, "swell": 0.4, "hit": 0.5, "chime": 0.6, "whoosh": 0.3, "swish": 0.3, "pop": 0.25, "thud": 0.3, "blip": 0.3, "tick": 0.3}
# where a whoosh peaks relative to its cue (they are cued ahead of the cut)
PAN = {"whoosh": 0.0, "skip": 0.0, "hit": 0.0}


def build(cues, duration):
    n = int(duration * SR) + SR
    dry = np.zeros((n, 2))
    send = np.zeros((n, 2))
    for c in cues:
        if c["type"] not in FX:          # grid markers for the score, not sounds
            continue
        x = FX[c["type"]]() * c.get("gain", 1)
        if x.ndim == 2:
            dry[int(c["t"] * SR): int(c["t"] * SR) + x.shape[0]] += x[: max(0, n - int(c["t"] * SR))]
            continue
        pan = PAN.get(c["type"], (rng.random() - 0.5) * 0.3)
        add(dry, c["t"], x, pan=pan)
        if c["type"] in SEND:
            add(send, c["t"], x * SEND[c["type"]], pan=pan)
    ir = reverb_ir(2.8, 0.9)
    wet = np.stack([signal.fftconvolve(send[:, ch], ir[:, ch])[:n] for ch in range(2)], axis=1)
    out = (dry + wet * 0.6)[: int(duration * SR)]
    return np.clip(out, -0.98, 0.98)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cues", default=os.path.join(HERE, "cues.json"))
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--out", default=os.path.join(HERE, "sfx.wav"))
    args = ap.parse_args()
    cues = json.load(open(args.cues))
    sf.write(args.out, build(cues, args.duration), SR, subtype="PCM_24")
    print(f"sfx: {len(cues)} cues -> {args.out}")


if __name__ == "__main__":
    main()
