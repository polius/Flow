/* Flow video — deterministic render engine.
 *
 * Everything on screen is a pure function of the video timestamp t. The capture
 * harness calls window.__render(t) once per frame and screenshots the page; no
 * wall-clock animation is ever used, so every frame is reproducible.
 *
 * Scenes register into window.SCENES (see scenes.js). Each gets its own layer
 * with an inner camera; the engine owns the cuts between layers (a "next
 * track" slide), the ambience wash behind everything (the colour of whatever
 * is playing, as in the app), the beat grid the score and the EQ bars share,
 * and the sound-effect cue list.
 */
(function () {
  const SCENES = (window.SCENES = {});

  // ---- math / easing ------------------------------------------------------
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ramp = (t, a, b) => (b <= a ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a)));
  const outQuint = (t) => 1 - Math.pow(1 - clamp(t), 5);
  const outCubic = (t) => 1 - Math.pow(1 - clamp(t), 3);
  const outExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(t)));
  const inCubic = (t) => Math.pow(clamp(t), 3);
  const inOutCubic = (t) => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  const inOutSine = (t) => -(Math.cos(Math.PI * clamp(t)) - 1) / 2;
  const outBack = (t, s = 1.4) => { t = clamp(t); return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2); };
  // a damped spring settling on 1 — for things that land with a little weight
  const spring = (t, k = 7, z = 5) => (t <= 0 ? 0 : 1 - Math.exp(-z * t) * Math.cos(k * t));

  // seeded noise, so "random" things are identical on every render
  function rnd(i) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  /* fade + rise (+ scale, + a short de-blur) from p = 0..1 */
  function reveal(node, p, o = {}) {
    if (!node) return p;
    const e = (o.ease || outQuint)(p);
    if (p <= 0) { node.style.visibility = "hidden"; return p; }
    node.style.visibility = "visible";
    node.style.opacity = clamp(e * (o.alpha ?? 1)).toFixed(4);
    const dy = (o.dy ?? 30) * (1 - e), dx = (o.dx ?? 0) * (1 - e);
    const sc = lerp(o.scale ?? 1, 1, e);
    const base = o.base || "";
    node.style.transform = `${base} translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) scale(${sc.toFixed(4)})`;
    const bl = (o.blur ?? 0) * (1 - e);
    node.style.filter = bl > 0.3 ? `blur(${bl.toFixed(2)}px)` : "none";
    return p;
  }
  function hide(node) { node.style.visibility = "hidden"; }

  // ---- DOM helpers ----------------------------------------------------------
  const NS = "http://www.w3.org/2000/svg";
  function el(tag, cls, parent, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    if (parent) parent.appendChild(n);
    return n;
  }
  function svg(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  /* centre-anchored box at (x, y); its own transform stays free for reveal() */
  function at(parent, x, y, cls, html) {
    const wrap = el("div", "ctr", parent);
    wrap.style.left = x + "px"; wrap.style.top = y + "px";
    return el("div", cls || "", wrap, html);
  }
  const cache = new WeakMap();
  function setText(node, s) { if (cache.get(node) !== s) { node.textContent = s; cache.set(node, s); } }
  function setHTML(node, s) { if (cache.get(node) !== s) { node.innerHTML = s; cache.set(node, s); } }

  /* kinetic words: split `text` into masked words. Returns the inner spans. */
  function words(parent, text, wordCls) {
    return text.split(" ").map((w, i, all) => {
      const k = el("span", "kt", parent);
      const s = el("span", wordCls || "", k);
      s.textContent = w;
      if (i < all.length - 1) parent.appendChild(document.createTextNode(" "));
      return s;
    });
  }
  /* rise each word out of its mask, staggered, starting at t0 */
  function kin(spans, t, t0, stagger = 0.06, dur = 0.55, out = null) {
    spans.forEach((s, i) => {
      const p = outQuint(ramp(t, t0 + i * stagger, t0 + i * stagger + dur));
      let y = (1 - p) * 120, r = (1 - p) * 3;
      if (out != null) {  // and leave upward
        const q = inCubic(ramp(t, out + i * stagger * 0.5, out + i * stagger * 0.5 + 0.35));
        y -= q * 120;
      }
      s.style.transform = `translateY(${y.toFixed(2)}%) rotate(${r.toFixed(2)}deg)`;
    });
  }

  // ---- fonts ------------------------------------------------------------------
  // measured layouts must wait for real metrics; the harness awaits __ready
  const AFTER_FONTS = [];
  let fontsSettled = false;
  function afterFonts(fn) { AFTER_FONTS.push(fn); }
  function settleFonts() { if (!fontsSettled) { fontsSettled = true; AFTER_FONTS.forEach((fn) => fn()); } }

  // ---- the beat ------------------------------------------------------------------
  // One grid for the score (music.py) and the picture: anchored on the opening
  // hit, so every EQ bar on screen moves with the music you hear.
  const BPM = 86, BEAT = 60 / BPM;
  const GRID = { t0: 0, drop: 1e9 };
  /* the level of one EQ bar (0..1) at absolute time t: kick on 1 and 3, snare
     on 2 and 4, hats between, each bar listening to a different band */
  function eqLevel(t, bar) {
    const n = 0.5 + 0.5 * Math.sin(t * (5.1 + bar * 1.7) + bar * 2.3);
    if (t < GRID.drop) {                      // before the drop: the keys breathe on the beat
      const b = (t - GRID.t0) / BEAT;
      if (b < 0) return 0.3;
      return clamp(0.35 + 0.3 * Math.exp(-(b - Math.floor(b)) * 3) + 0.2 * n, 0.18, 1);
    }
    // the groove, counted from the drop as the score is: kick on 1 and the
    // "and" of 3, snare on 2 and 4, hats on the 16ths
    const b = (t - GRID.drop) / BEAT, bb = Math.floor(b) % 4, ph = b - Math.floor(b);
    const since = (x) => (x < 0 ? 9 : x);
    const k = Math.max(bb === 0 ? Math.exp(-since(ph) * 5) : 0, bb === 2 ? Math.exp(-since(ph - 0.5) * 6) : 0,
                       bb === 1 ? Math.exp(-since(ph + 1) * 5) * 0.4 : 0);
    const sn = bb % 2 === 1 ? Math.exp(-ph * 6) : 0;
    const h = Math.exp(-((ph * 4) % 1) * 5);
    return clamp([0.22 + 0.78 * k + 0.1 * n, 0.25 + 0.65 * sn + 0.15 * h + 0.1 * n, 0.25 + 0.45 * h + 0.25 * n][bar], 0.18, 1);
  }

  const A = { clamp, lerp, ramp, rnd, outQuint, outCubic, outExpo, inCubic, inOutCubic, inOutSine,
              outBack, spring, reveal, hide, el, svg, at, setText, setHTML, words, kin, afterFonts,
              eqLevel, BEAT, GRID };
  window.Toolkit = A;

  // ---- timeline, cues, ambience -------------------------------------------------
  let TL = null;
  const CUES = [];                 // sound effects: { t, type, gain }
  const AMB_KEYS = [];             // { t, a, b } — the two wash colours
  const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const NEUTRAL = ["#e4e1ea", "#ece6dc"];

  function api(scene, layer, cam) {
    const t0 = scene.start;
    return Object.assign({
      tl: TL.d, scene, layer, cam, t0, W: 1920, H: 1080,
      dur: scene.end - scene.start,
      on: (id, label) => TL.byId[id].onsets[label] - t0,
      segStart: (id) => TL.byId[id].start - t0,
      segEnd: (id) => TL.byId[id].end - t0,
      cue: (type, t, gain = 1) => CUES.push({ t: +(t0 + t).toFixed(3), type, gain }),
      /* the background wash takes these colours from t (scene time) */
      ambience: (t, a, b = a) => AMB_KEYS.push({ t: t0 + t, a: hex2rgb(a), b: hex2rgb(b) }),
      /* the beat grid: anchor it (open) / mark the drop (play) */
      grid: (key, t) => { GRID[key] = t0 + t; },
      /* the nearest beat to scene time t, in scene time */
      snap: (t) => GRID.t0 + Math.round((t0 + t - GRID.t0) / BEAT) * BEAT - t0,
    }, A);
  }

  function ambienceAt(t) {
    let a = hex2rgb(NEUTRAL[0]), b = hex2rgb(NEUTRAL[1]);
    for (const k of AMB_KEYS) {
      if (t < k.t) break;
      const p = inOutSine(ramp(t, k.t, k.t + 0.9));
      a = a.map((v, i) => lerp(v, k.a[i], p));
      b = b.map((v, i) => lerp(v, k.b[i], p));
    }
    return [a, b];
  }

  // ---- background ---------------------------------------------------------------
  const rgb = (c, al = 1) => `rgba(${c.map(Math.round).join(",")},${al})`;
  function paintBackground(t) {
    const bg = document.getElementById("bg");
    const [a, b] = ambienceAt(t);
    const w1 = bg.querySelector(".w1"), w2 = bg.querySelector(".w2"), w3 = bg.querySelector(".w3");
    w1.style.background = `radial-gradient(closest-side, ${rgb(a, 0.95)}, ${rgb(a, 0.45)} 45%, ${rgb(a, 0)})`;
    w2.style.background = `radial-gradient(closest-side, ${rgb(b, 0.9)}, ${rgb(b, 0.4)} 45%, ${rgb(b, 0)})`;
    w3.style.background = `radial-gradient(closest-side, ${rgb(a, 0.55)}, ${rgb(a, 0)})`;
    w1.style.transform = `translate(${(-520 + 140 * Math.sin(t * 0.11)).toFixed(1)}px, ${(-700 + 90 * Math.cos(t * 0.09)).toFixed(1)}px)`;
    w2.style.transform = `translate(${(1000 + 120 * Math.sin(t * 0.08 + 2)).toFixed(1)}px, ${(180 + 100 * Math.sin(t * 0.07 + 1)).toFixed(1)}px)`;
    w3.style.transform = `translate(${(700 + 260 * Math.sin(t * 0.05 + 4)).toFixed(1)}px, ${(560 + 60 * Math.cos(t * 0.06)).toFixed(1)}px)`;
    // the grooves: faint concentric rings of a record, turning slowly
    bg.querySelector(".grooves").style.transform = `rotate(${(t * 2.2).toFixed(2)}deg)`;
  }

  // ---- build + render -----------------------------------------------------------
  let built = null;
  const CUT_OUT = 0.42, CUT_IN = 0.62;     // the "next track" slide at every scene change
  const SLIDE = 220;

  function build() {
    const root = document.getElementById("scenes");
    built = [];
    TL.scenes.forEach((scene, idx) => {
      const layer = el("div", "layer", root);
      layer.style.zIndex = 10 + idx;
      const cam = el("div", "cam", layer);
      const render = SCENES[scene.name](cam, api(scene, layer, cam));
      built.push({ scene, layer, render });
      if (idx > 0) CUES.push({ t: +(scene.start - 0.3).toFixed(3), type: "skip", gain: 1 });
    });
    AMB_KEYS.sort((a, b) => a.t - b.t);
    CUES.sort((a, b) => a.t - b.t);
  }

  function render(t) {
    settleFonts();
    paintBackground(t);

    for (let i = 0; i < built.length; i++) {
      const { scene: s, layer, render: r } = built[i];
      const last = i === built.length - 1;
      const outP = last ? 0 : ramp(t, s.end - CUT_OUT, s.end + 0.06);
      const inP = i === 0 ? 1 : ramp(t, s.start - 0.06, s.start + CUT_IN);
      // display, not visibility: a revealed child would show through a hidden parent
      if (outP >= 1 || inP <= 0) { layer.style.display = "none"; continue; }
      layer.style.display = "";
      const eo = inCubic(outP), ei = outQuint(inP);
      layer.style.opacity = ((1 - eo) * ei).toFixed(4);
      const x = -SLIDE * eo + SLIDE * (1 - ei);
      const sc = lerp(1, 0.97, eo) * lerp(0.985, 1, ei);
      layer.style.transform = `translateX(${x.toFixed(2)}px) scale(${sc.toFixed(5)})`;
      const bl = 6 * eo + 5 * (1 - ei);
      layer.style.filter = bl > 0.4 ? `blur(${bl.toFixed(2)}px)` : "none";
      r(t - s.start, t);
    }

    // the film's own playhead, along the bottom edge
    const p = clamp(t / TL.d.video_end);
    document.querySelector("#scrub b").style.width = (p * 100).toFixed(3) + "%";
    const sv = ramp(t, 2.0, 3.0) * (1 - ramp(t, TL.d.video_end - 4.0, TL.d.video_end - 3.0));
    document.getElementById("scrub").style.opacity = (sv * 0.9).toFixed(3);

    const fadeIn = ramp(t, 0, 0.45);
    const fadeOut = 1 - ramp(t, TL.d.video_end - 1.1, TL.d.video_end - 0.05);
    document.getElementById("whiteout").style.opacity = (1 - Math.min(fadeIn, fadeOut)).toFixed(4);
  }

  // ---- capture API --------------------------------------------------------------
  window.__init = function (data) {
    const byId = {};
    data.segments.forEach((s) => (byId[s.id] = s));
    TL = { d: data, byId, scenes: data.scenes };
    const g = document.querySelector("#bg .grooves");
    for (let r = 300; r <= 1500; r += 26) {
      const c = svg("circle", { cx: 0, cy: 0, r, "stroke-width": r % 104 === 0 ? 1.6 : 1 }, g);
      c.setAttribute("opacity", (0.05 + 0.05 * rnd(r)).toFixed(3));
    }
    build();
    window.__ready = Promise.all([
      document.fonts.load('800 132px "Inter"'),
      document.fonts.load('400 20px "Inter"'),
      document.fonts.load('500 26px "JBMono"'),
    ]).then(() => document.fonts.ready).then(() => true);
  };
  window.__render = render;
  // the score reads the beat grid from the same list: where it starts, where it drops
  window.__cues = () => CUES.concat([{ t: +GRID.t0.toFixed(3), type: "beat0", gain: 0 }, { t: +GRID.drop.toFixed(3), type: "groove", gain: 0 }])
    .sort((a, b) => a.t - b.t);
  window.__grid = () => ({ bpm: BPM, t0: GRID.t0, drop: GRID.drop });
  window.__duration = () => (TL ? TL.d.video_end : 0);
  window.__poster = function () {
    document.getElementById("scrub").style.display = "none";   // the film's playhead means nothing on a still
    el("div", "", document.getElementById("stage")).id = "poster-play";
  };
})();
