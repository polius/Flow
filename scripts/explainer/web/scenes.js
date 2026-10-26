/* Flow video — the scenes.
 *
 * Every scene is a function (cam, api) -> render(t) where t is seconds since the
 * scene's start (negative while it is cutting in). `cam` is the scene's camera:
 * transform it to push, pan or drift the whole shot. Moments come from the
 * narration via api.on(line, anchor) / api.segStart(line), so a frame is a pure
 * function of t and the visuals track the voice. Sound effects are registered
 * up front with api.cue(type, t) and mixed by sfx.py.
 *
 * The app on screen is a replica of the real one in its light theme (the
 * markup, sizes, icons and strings of frontend/src), filled with the demo
 * library's artists and albums (backend/app/demo.py). The demo's covers are
 * flat pastels; the film paints each album a cover of its own, because a real
 * library has artwork, and artwork is the only colour Flow shows.
 */
(function () {
  const A = window.Toolkit;
  const { clamp, lerp, ramp, rnd, outQuint, outCubic, inCubic, inOutCubic, inOutSine,
          outBack, spring, reveal, el, at, setText, setHTML, words, kin, afterFonts, eqLevel } = A;

  /* ------------------------------------------------------------------ *
   *  icons — the app's own set (frontend/src/components/icons.tsx)
   * ------------------------------------------------------------------ */
  const P = {
    tracks: `<circle cx="7" cy="17.8" r="2.4"/><circle cx="17.6" cy="15.8" r="2.4"/><path d="M9.4 17.8V6.6L20 4.6v11.2"/>`,
    albums: `<rect x="3.5" y="8" width="13.5" height="12.5" rx="2"/><path d="M8 5.2h10.3a2.2 2.2 0 0 1 2.2 2.2v10.1"/>`,
    artists: `<circle cx="12" cy="8.2" r="3.4"/><path d="M5.5 19.8c.6-3.4 3.2-5.2 6.5-5.2s5.9 1.8 6.5 5.2"/>`,
    heart: `<path d="M12 19.6C7.3 15.7 4 12.8 4 9.6 4 7.1 5.9 5.3 8.2 5.3c1.5 0 2.9.75 3.8 2 .9-1.25 2.3-2 3.8-2 2.3 0 4.2 1.8 4.2 4.3 0 3.2-3.3 6.1-8 10Z"/>`,
    heartf: `<path fill="currentColor" d="M12 19.6C7.3 15.7 4 12.8 4 9.6 4 7.1 5.9 5.3 8.2 5.3c1.5 0 2.9.75 3.8 2 .9-1.25 2.3-2 3.8-2 2.3 0 4.2 1.8 4.2 4.3 0 3.2-3.3 6.1-8 10Z"/>`,
    playlists: `<path d="M4 6.5h10.5M4 11.5h10.5M4 16.5h6"/><circle cx="17.4" cy="17" r="2.3"/><path d="M19.7 17V6.5"/>`,
    search: `<circle cx="11" cy="11" r="6.3"/><path d="m15.7 15.7 4.3 4.3"/>`,
    settings: `<path d="M4 8h8.4M17.6 8H20M4 16h4.4M13.6 16H20"/><circle cx="15" cy="8" r="2.2"/><circle cx="11" cy="16" r="2.2"/>`,
    play: `<path d="M8.4 6.1 18.2 12 8.4 17.9Z" fill="currentColor" stroke-width="1.4"/>`,
    pause: `<rect x="7.1" y="5.5" width="3.3" height="13" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.6" y="5.5" width="3.3" height="13" rx="1.2" fill="currentColor" stroke="none"/>`,
    prev: `<rect x="5.6" y="5.8" width="2.4" height="12.4" rx="1.1" fill="currentColor" stroke="none"/><path d="M18.4 6.4 10.5 12l7.9 5.6Z" fill="currentColor" stroke-width="1.3"/>`,
    next: `<rect x="16" y="5.8" width="2.4" height="12.4" rx="1.1" fill="currentColor" stroke="none"/><path d="M5.6 6.4 13.5 12l-7.9 5.6Z" fill="currentColor" stroke-width="1.3"/>`,
    shuffle: `<path d="M3.5 7h2.4c1.1 0 2.1.5 2.8 1.35l6.6 7.8c.7.85 1.7 1.35 2.8 1.35h2.4"/><path d="m17.8 14.8 3.1 3-3.1 3"/><path d="M3.5 18.5h2.4c1.1 0 2.1-.5 2.8-1.35l1.1-1.3"/><path d="M13.4 10.05l1.1-1.3c.7-.85 1.7-1.35 2.8-1.35h2.4"/><path d="m17.8 4.3 3.1 3.1-3.1 3"/>`,
    repeat: `<path d="M17.2 3.8 20.5 7l-3.3 3.2"/><path d="M20.5 7H8.3A4.3 4.3 0 0 0 4 11.3V12"/><path d="M6.8 20.2 3.5 17l3.3-3.2"/><path d="M3.5 17h12.2A4.3 4.3 0 0 0 20 12.7V12"/>`,
    volume: `<path d="M4 9.5h3.2L11.5 6v12l-4.3-3.5H4z"/><path d="M15 9.2a4 4 0 0 1 0 5.6"/><path d="M17.6 6.6a7.6 7.6 0 0 1 0 10.8"/>`,
    more: `<circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none"/>`,
    folder: `<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>`,
    note: `<path d="M9 18V5.5l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>`,
    server: `<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>`,
    queue: `<path d="M4 6h12M4 11h12M4 16h7"/><path d="M15.5 14.5v5l4-2.5z" fill="currentColor"/>`,
    check: `<path d="M5 12.5l4.5 4.5L19 7.5"/>`,
    lock: `<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>`,
    share: `<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M6 11v7.5A2 2 0 0 0 8 20.5h8a2 2 0 0 0 2-2V11"/>`,
    plusbox: `<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/>`,
    copy: `<rect x="9" y="9" width="11.5" height="11.5" rx="2.5"/><path d="M15 9V6a2.5 2.5 0 0 0-2.5-2.5h-6A2.5 2.5 0 0 0 4 6v6a2.5 2.5 0 0 0 2.5 2.5H9"/>`,
    x: `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
    chev: `<path d="M6.5 9.5 12 15l5.5-5.5"/>`,
    plus: `<path d="M12 5.5v13M5.5 12h13"/>`,
    trash: `<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>`,
    moon: `<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>`,
    wrench: `<path d="M14.7 6.3a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3z"/><path d="M14.7 6.3 17 4l3 3-2.3 2.3"/>`,
    github: `<path fill="currentColor" stroke="none" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/>`,
  };
  const icon = (name, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name]}</svg>`;
  const ico = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${P[name]}</svg>`;

  /* the mark: the app icon's eighth note (assets/logo-*.svg) */
  const NOTE = "M247 349.76V104H275C314 105 350 128 362 170C370 196 366 222 352 236C343 246 332 251 320 252C329 236 333 220 333 202C333 182 326 169 314 162C303 156 290 155 275 155V349.76ZM272.98 338.11A64 46 -20 1 1 152.7 381.89A64 46 -20 1 1 272.98 338.11Z";
  const noteSvg = (fill = "#f5f5f7") => `<svg viewBox="0 0 512 512" aria-hidden="true"><path fill="${fill}" d="${NOTE}"/></svg>`;

  /* ------------------------------------------------------------------ *
   *  covers — one painted cover per album, 100x100 SVG
   * ------------------------------------------------------------------ */
  let gid = 0;
  const COVERS = {
    // Velvet Hour — Afterglow: a low sun over a striped sea
    afterglow: () => { const g = "g" + gid++; return `
      <defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb38a"/><stop offset=".6" stop-color="#ff7e6b"/><stop offset="1" stop-color="#c8507a"/></linearGradient></defs>
      <rect width="100" height="100" fill="url(#${g})"/><circle cx="50" cy="60" r="24" fill="#ffe3a8"/>
      <rect y="60" width="100" height="40" fill="#5b3a78"/>
      ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${18 + i * 3}" y="${63 + i * 6}" width="${64 - i * 6}" height="2.2" rx="1.1" fill="#ffd59a" opacity="${0.9 - i * 0.12}"/>`).join("")}`; },
    // Cassette Club — Polaroid Summer: sunbleached stripes
    polaroid: () => `<rect width="100" height="100" fill="#f6e7c4"/>
      ${["#f2a65a", "#ef7b67", "#5bb6b0", "#2f7d8c"].map((c, i) => `<rect x="-20" y="${30 + i * 13}" width="140" height="10" fill="${c}" transform="rotate(-18 50 50)"/>`).join("")}`,
    // The Paper Lanterns — Harbor Lights: lights on dark water
    harbor: () => `<rect width="100" height="100" fill="#1f2c4a"/>
      ${[0, 1, 2, 3, 4].map((i) => `<path d="M0 ${58 + i * 9} Q 25 ${53 + i * 9} 50 ${58 + i * 9} T 100 ${58 + i * 9} V100 H0Z" fill="#2c4170" opacity=".55"/>`).join("")}
      ${[[22, 40], [38, 34], [56, 42], [74, 36], [86, 44]].map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${2.6 + (i % 2)}" fill="#ffc96b"/><rect x="${x - 0.6}" y="${y + 8}" width="1.2" height="${18 + i * 3}" fill="#ffc96b" opacity=".35"/>`).join("")}`,
    // Midnight Harbor — Blue Hour Sessions: rings
    bluehour: () => `<rect width="100" height="100" fill="#20335c"/>
      ${[40, 33, 26, 19, 12, 6].map((r, i) => `<circle cx="50" cy="50" r="${r}" fill="${["#2c4a80", "#3a5f9e", "#4f78b8", "#6f95cf", "#a4c0e6", "#e9eef7"][i]}"/>`).join("")}`,
    // Aurora Fields — Northern Light: curtains of light
    northern: () => { const g = "g" + gid++; return `
      <defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f2a3a"/><stop offset="1" stop-color="#1b1f45"/></linearGradient></defs>
      <rect width="100" height="100" fill="url(#${g})"/>
      <path d="M-5 70 C 20 30, 40 80, 60 35 S 95 40, 105 20 V 60 C 80 75, 60 50, 40 80 S 10 60, -5 90Z" fill="#58e0b0" opacity=".55"/>
      <path d="M-5 55 C 25 25, 45 60, 65 25 S 95 30, 105 5 V 30 C 80 50, 62 40, 42 62 S 10 45, -5 70Z" fill="#a98bf0" opacity=".45"/>
      <rect y="84" width="100" height="16" fill="#0a1424"/>`; },
    // Neon Cartographers — City Grids: a street map
    citygrids: () => `<rect width="100" height="100" fill="#151826"/>
      ${[14, 32, 50, 68, 86].map((v) => `<rect x="${v}" y="0" width="1.4" height="100" fill="#3a4060"/><rect x="0" y="${v}" width="100" height="1.4" fill="#3a4060"/>`).join("")}
      <path d="M14 86 V50 H50 V32 H86" fill="none" stroke="#ff4fa3" stroke-width="3.2" stroke-linejoin="round"/>
      <path d="M14 14 H32 V68 H68 V86" fill="none" stroke="#3fe0f0" stroke-width="3.2" stroke-linejoin="round"/>
      <circle cx="86" cy="32" r="4" fill="#ff4fa3"/><circle cx="68" cy="86" r="4" fill="#3fe0f0"/>`,
    // Marlowe Reyes — Golden Hour: arcs
    golden: () => `<rect width="100" height="100" fill="#f1c45b"/>
      <circle cx="100" cy="100" r="78" fill="#e39a3b"/><circle cx="100" cy="100" r="56" fill="#c2662d"/><circle cx="100" cy="100" r="34" fill="#7a3522"/>
      <circle cx="28" cy="30" r="9" fill="#fff3cf"/>`,
    // The Slow Tide — Beacon: a lighthouse beam
    beacon: () => `<rect width="100" height="100" fill="#1e4c57"/>
      <path d="M48 36 L105 18 V54Z" fill="#f4e6b8" opacity=".55"/><path d="M48 36 L-5 22 V48Z" fill="#f4e6b8" opacity=".25"/>
      <path d="M43 86 L46 40 H50 L53 86Z" fill="#f2efe6"/><rect x="45" y="33" width="6" height="7" rx="1" fill="#ffd36b"/>
      <rect x="44.5" y="52" width="7" height="5" fill="#d9573f"/><rect x="43.7" y="68" width="8.6" height="5" fill="#d9573f"/>
      <rect y="84" width="100" height="16" fill="#123540"/>`,
    // Kite Theory — Paper Planes: folded triangles
    planes: () => `<rect width="100" height="100" fill="#cfe6f7"/>
      <path d="M14 70 L86 34 L52 58Z" fill="#ffffff"/><path d="M52 58 L86 34 L58 78Z" fill="#e5eef6"/><path d="M52 58 L58 78 L48 66Z" fill="#9db7cf"/>
      <path d="M8 82 C 30 78, 34 88, 54 82" fill="none" stroke="#f27d5b" stroke-width="1.6" stroke-dasharray="3 3"/>
      <circle cx="78" cy="18" r="6" fill="#f27d5b"/>`,
    // Odette Blue — Rainy Window: rain
    rainy: () => `<rect width="100" height="100" fill="#8aa3b8"/>
      ${Array.from({ length: 28 }, (_, i) => { const x = rnd(i) * 100, y = rnd(i + 40) * 100; return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="1.2" height="${(8 + rnd(i + 9) * 10).toFixed(1)}" rx=".6" fill="#e7f0f7" opacity=".7"/>`; }).join("")}
      <circle cx="30" cy="70" r="14" fill="#f3d38b" opacity=".85"/><circle cx="62" cy="62" r="9" fill="#f7b79a" opacity=".75"/>`,
    // Fern & Fog — Hollow Pines: hills of pines
    pines: () => `<rect width="100" height="100" fill="#e6e2d3"/>
      <path d="M0 62 L18 40 L32 56 L50 30 L68 52 L82 38 L100 58 V100 H0Z" fill="#9db39a"/>
      <path d="M0 76 L14 60 L28 72 L44 52 L60 70 L78 56 L100 74 V100 H0Z" fill="#4f7a5b"/>
      <path d="M0 90 L20 78 L40 88 L62 76 L84 88 L100 82 V100 H0Z" fill="#2c4a3a"/>
      <circle cx="74" cy="22" r="7" fill="#f4f1e6"/>`,
    // Silver Larch — Static Bloom: soft bloom
    bloom: () => `<rect width="100" height="100" fill="#efd9e6"/>
      ${[0, 1, 2, 3, 4, 5].map((i) => `<ellipse cx="50" cy="50" rx="11" ry="30" fill="#e48ab3" opacity=".42" transform="rotate(${i * 30} 50 50)"/>`).join("")}
      <circle cx="50" cy="50" r="8" fill="#7c3d6a"/>`,
    // Marlowe Reyes — Velvet & Gold: brass on velvet
    velvetgold: () => `<rect width="100" height="100" fill="#4a1f3a"/>
      ${[0, 1, 2, 3].map((i) => `<circle cx="${30 + i * 13}" cy="${36 + (i % 2) * 22}" r="11" fill="none" stroke="#e7b75a" stroke-width="3"/>`).join("")}
      <rect y="80" width="100" height="20" fill="#2d1124"/>`,
    // Cassette Club — Chrome Sunset: a chrome sun sinking into the grid
    chrome: () => { const g = "g" + gid++; return `
      <defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd36e"/><stop offset="1" stop-color="#ff5f8f"/></linearGradient></defs>
      <rect width="100" height="100" fill="#22163d"/><circle cx="50" cy="52" r="26" fill="url(#${g})"/>
      ${[0, 1, 2, 3].map((i) => `<rect x="20" y="${56 + i * 6}" width="60" height="${1.5 + i * 0.6}" fill="#22163d"/>`).join("")}
      <rect y="70" width="100" height="30" fill="#2b1c4f"/>
      ${[0, 1, 2, 3].map((i) => `<rect y="${74 + i * i * 2.5}" width="100" height=".8" fill="#ff5f8f" opacity=".7"/>`).join("")}`; },
    // Velvet Hour — Neon Reverie
    reverie: () => { const g = "g" + gid++; return `
      <defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd1e8"/><stop offset="1" stop-color="#b8a6ff"/></linearGradient></defs>
      <rect width="100" height="100" fill="url(#${g})"/><rect x="22" y="22" width="56" height="56" rx="28" fill="none" stroke="#fff" stroke-width="4"/>
      <rect x="34" y="34" width="32" height="32" rx="16" fill="#ffffff" opacity=".6"/>`; },
  };
  const coverSvg = (k) => `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${COVERS[k]()}</svg>`;

  // the library, as the demo builds it
  const ALBUMS = [
    ["afterglow", "Afterglow", "Velvet Hour", 2024],
    ["beacon", "Beacon", "The Slow Tide", 2023],
    ["bluehour", "Blue Hour Sessions", "Midnight Harbor", 2018],
    ["citygrids", "City Grids", "Neon Cartographers", 2022],
    ["golden", "Golden Hour", "Marlowe Reyes", 2021],
    ["harbor", "Harbor Lights", "The Paper Lanterns", 2020],
    ["pines", "Hollow Pines", "Fern & Fog", 2019],
    ["reverie", "Neon Reverie", "Velvet Hour", 2021],
    ["northern", "Northern Light", "Aurora Fields", 2023],
    ["planes", "Paper Planes", "Kite Theory", 2023],
    ["polaroid", "Polaroid Summer", "Cassette Club", 2019],
    ["rainy", "Rainy Window", "Odette Blue", 2022],
    ["bloom", "Static Bloom", "Silver Larch", 2021],
  ];
  const AFTERGLOW = [
    ["Golden Rule", "3:15"], ["Stay Gold", "4:30"], ["Marmalade", "4:31"], ["Ember & Afterglow", "4:18"],
    ["Waiting Cassettes", "3:38"], ["Humming Canyons", "3:36"], ["The Daylight", "3:10"], ["Halo", "3:47"],
    ["Waking in the Orchard", "3:19"],
  ];
  // the ambience of each cover: two colours lifted from it
  const AMB = { afterglow: ["#ffb08f", "#e08aa6"], bluehour: ["#9fb6e3", "#c8d5ef"], northern: ["#9de6c9", "#c3b2f2"],
                golden: ["#f4cd78", "#e9a76a"], neutral: ["#e3e0ea", "#ebe5da"], beacon: ["#a8cfd2", "#f1e3b8"] };

  /* a soft light, drawn as a gradient (no blur filters) */
  function bloom(parent, x, y, size, color) {
    const b = el("div", "abs", parent);
    Object.assign(b.style, { left: x - size / 2 + "px", top: y - size / 2 + "px", width: size + "px", height: size + "px",
      borderRadius: "50%", background: `radial-gradient(closest-side, ${color}, transparent)` });
    return b;
  }

  /* camera: interpolate between keyframes [t, scale, x, y, dur] with an ease */
  function camera(cam, t, keys, drift = 1) {
    let s = keys[0][1], x = keys[0][2], y = keys[0][3];
    for (let i = 1; i < keys.length; i++) {
      const [t1, s1, x1, y1, d = 0.9] = keys[i];
      const p = inOutCubic(ramp(t, t1, t1 + d));
      s = lerp(s, s1, p); x = lerp(x, x1, p); y = lerp(y, y1, p);
    }
    x += drift * 5 * Math.sin(t * 0.45); y += drift * 3.5 * Math.cos(t * 0.37);
    s *= 1 + 0.004 * drift * Math.sin(t * 0.3);
    cam.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${s.toFixed(5)})`;
  }

  const blink = (t, period = 1.0) => (((t % period) + period) % period < period * 0.55 ? 1 : 0);
  const typed = (text, t, t0, rate) => (t < t0 ? "" : text.slice(0, clamp(Math.floor((t - t0) / rate) + 1, 0, text.length)));
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  /* a position that eases between waypoints [t, x, y] */
  function path(keys) {
    return (t) => {
      if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
      for (let i = 1; i < keys.length; i++) {
        if (t < keys[i][0]) {
          const p = inOutCubic(ramp(t, keys[i - 1][0], keys[i][0]));
          return [lerp(keys[i - 1][1], keys[i][1], p), lerp(keys[i - 1][2], keys[i][2], p)];
        }
      }
      const k = keys[keys.length - 1];
      return [k[1], k[2]];
    };
  }

  /* the pointer, with a press and a ripple on each click */
  const POINTER = `<svg viewBox="0 0 24 24" width="44" height="44" style="overflow:visible"><path d="M5 2.5l14.5 8-6.4 1.7-3.2 6.6z"
    fill="#1d1d1f" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  function pointer(parent) {
    const n = el("div", "cursor", parent, POINTER);
    const rip = el("div", "ripple", parent);
    n.style.transformOrigin = "9px 4px";
    return function (t, [x, y], clicks, alpha = 1) {
      let press = 0, rp = -1;
      for (const c of clicks) {
        if (t > c - 0.08 && t < c + 0.18) press = Math.max(press, Math.sin(Math.PI * ramp(t, c - 0.08, c + 0.18)));
        if (t >= c && t < c + 0.55) rp = ramp(t, c, c + 0.55);
      }
      n.style.opacity = alpha.toFixed(3);
      n.style.transform = `translate(${(x - 9).toFixed(1)}px, ${(y - 4).toFixed(1)}px) scale(${(1 - 0.16 * press).toFixed(3)})`;
      if (rp >= 0) {
        rip.style.opacity = ((1 - rp) * 0.8 * alpha).toFixed(3);
        rip.style.left = x + "px"; rip.style.top = y + "px";
        rip.style.transform = `scale(${(0.3 + 0.9 * outCubic(rp)).toFixed(3)})`;
      } else rip.style.opacity = 0;
    };
  }
  /* a finger tap (phone): a soft disc that presses and fades */
  function tapper(parent) {
    const n = el("div", "tap", parent);
    return function (t, [x, y], at) {
      const p = ramp(t, at - 0.25, at + 0.45);
      if (p <= 0 || p >= 1) { n.style.opacity = 0; return; }
      n.style.left = x + "px"; n.style.top = y + "px";
      const press = Math.sin(Math.PI * ramp(t, at - 0.1, at + 0.15));
      n.style.opacity = (Math.sin(Math.PI * p) * 0.95).toFixed(3);
      n.style.transform = `scale(${(1 - 0.18 * press).toFixed(3)})`;
    };
  }

  /* the step captions beside the app: numbered, because they are a sequence */
  function stepCaptions(layer, items) {
    const box = el("div", "steps", layer);
    return items.map(([n, title, sub]) => {
      const s = el("div", "step", box);
      el("div", "n", s, n);
      const tt = el("div", "t", s);
      const ws = words(tt, title);
      const ss = el("div", "s", s, sub);
      return { s, ws, ss };
    });
  }
  function playSteps(steps, t, starts) {
    steps.forEach((st, i) => {
      kin(st.ws, t, starts[i], 0.06, 0.55);
      reveal(st.ss, ramp(t, starts[i] + 0.25, starts[i] + 0.75), { dy: 14 });
      reveal(st.s.querySelector(".n"), ramp(t, starts[i] - 0.05, starts[i] + 0.4), { dy: 0, dx: -16 });
      const next = starts[i + 1];
      st.s.style.opacity = next == null ? 1 : lerp(1, 0.3, ramp(t, next - 0.1, next + 0.35)).toFixed(3);
    });
  }

  /* the red EQ: three bars that move with the score */
  function eqBars(parent, cls = "eqb") {
    const n = el("div", cls, parent, "<i></i><i></i><i></i>");
    const bars = [...n.children];
    return { node: n, set(T, amt = 1) {
      bars.forEach((b, i) => { b.style.transform = `scaleY(${lerp(0.45, 0.4 + 0.6 * eqLevel(T, i), amt).toFixed(3)})`; });
    } };
  }

  /* the lockup: tile + note + "Flow" + EQ */
  function lockup(parent, size) {
    const n = el("div", "lockup", parent);
    n.style.fontSize = size + "px";
    n.innerHTML = `<div class="tile">${noteSvg()}</div><div class="word">${"Flow".split("").map((c) => `<span>${c}</span>`).join("")}</div>`;
    const tile = n.querySelector(".tile"), note = tile.querySelector("svg"), word = n.querySelector(".word");
    const letters = [...n.querySelectorAll(".word span")];
    const eq = eqBars(n);
    eq.node.style.fontSize = (size * 0.36) + "px";
    eq.node.style.marginLeft = (-size * 0.06) + "px";
    eq.node.style.alignSelf = "flex-end";
    eq.node.style.marginBottom = (size * 0.13) + "px";
    let shift = 0;
    afterFonts(() => {
      const r = n.getBoundingClientRect(), m = tile.getBoundingClientRect();
      shift = (r.left + r.width / 2) - (m.left + m.width / 2);
    });
    return {
      node: n, tile,
      /* drop 0..1 lands the tile, ring 0..1 lifts the note, k reveals letters, centre 1 = tile alone in the middle */
      set(T, drop, ring, k, centre, eqAmt) {
        const sc = drop <= 0 ? 0 : spring(drop * 1.25, 9, 5.5);
        tile.style.transform = `translateX(${(shift * centre).toFixed(1)}px) scale(${sc.toFixed(4)})`;
        tile.style.opacity = clamp(drop * 4).toFixed(3);
        const ny = 60 * (1 - outBack(ring, 2.2));
        note.style.transform = `translateY(${ny.toFixed(2)}%) rotate(${(-14 * (1 - outCubic(ring))).toFixed(2)}deg)`;
        note.style.opacity = clamp(ring * 3).toFixed(3);
        letters.forEach((s, i) => {
          const p = outQuint(clamp(k - i));
          s.style.opacity = p.toFixed(3);
          s.style.transform = `translateX(${(-50 * (1 - p)).toFixed(1)}px)`;
        });
        word.style.transform = `translateX(${(shift * centre).toFixed(1)}px)`;
        eq.node.style.transform = `translateX(${(shift * centre).toFixed(1)}px)`;
        eq.node.style.opacity = clamp(eqAmt * 1.5).toFixed(3);
        eq.set(T, eqAmt);
      },
    };
  }

  /* ====================================================================== *
   *  the app, in a browser window
   * ====================================================================== */
  function topbarHTML(on) {
    const nav = [["tracks", "Tracks"], ["albums", "Albums"], ["artists", "Artists"], ["heart", "Favorites"], ["playlists", "Playlists"]]
      .map(([i, l]) => `<span class="${l === on ? "on" : ""}">${icon(i)}${l}</span>`).join("");
    return `<div class="topbar"><div class="brand"><div class="bt">${noteSvg()}</div><span class="bw"><b>Flow</b><small>v1.6.0</small></span></div>
      <div class="search">${icon("search")}<span>Albums, artists, songs…</span></div>
      <div class="nav">${nav}<span class="sep"></span><span>${icon("settings")}Settings</span></div></div>`;
  }
  function playerHTML() {
    return `<div class="player"><div class="meta"><div class="pa"></div><div><div class="pt">Nothing playing</div><div class="ps"></div></div></div>
      <div class="center"><div class="tr">${icon("shuffle")}${icon("prev")}<div class="pp">${icon("play")}</div>${icon("next")}${icon("repeat")}</div>
      <div class="prog"><span class="t0">0:00</span><div class="bar"><b></b><u></u></div><span class="t1">0:00</span></div></div>
      <div class="vol">${icon("volume")}<div class="bar"><b style="width:100%"></b><u style="left:100%"></u></div></div></div>`;
  }
  function browser(parent, { x, y, w, h, zoom = 1 }) {
    const win = el("div", "win", parent);
    Object.assign(win.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
    win.innerHTML = `<div class="chrome"><i></i><i></i><i></i><div class="url">${ico("lock")}music.example.com</div></div><div class="vp"><div class="app"></div></div>`;
    const vp = win.querySelector(".vp"), app = win.querySelector(".app");
    app.style.zoom = zoom;
    app.style.width = (w / zoom) + "px";
    app.style.height = ((h - 52) / zoom) + "px";
    return { win, vp, app, $: (s) => app.querySelector(s), $$: (s) => [...app.querySelectorAll(s)] };
  }
  /* the player bar, driven: song index into a list, elapsed seconds, playing */
  function playerCtl(B, list, cov, artist) {
    const pa = B.$(".player .pa"), pt = B.$(".player .pt"), ps = B.$(".player .ps"), pp = B.$(".player .pp");
    const t0 = B.$(".player .t0"), t1 = B.$(".player .t1"), fill = B.$(".player .prog b"), knob = B.$(".player .prog u");
    pa.innerHTML = coverSvg(cov);
    const secs = (s) => { const [m, x] = s.split(":"); return +m * 60 + +x; };
    return function (idx, el2, playing) {
      if (idx < 0) { setText(pt, "Nothing playing"); setText(ps, ""); pa.style.opacity = 0; fill.style.width = "0%"; knob.style.left = "0%"; setText(t0, "0:00"); setText(t1, "0:00"); setHTML(pp, icon("play")); return; }
      pa.style.opacity = 1;
      setText(pt, list[idx][0]); setText(ps, artist);
      const d = secs(list[idx][1]);
      const f = clamp(el2 / d) * 100;
      fill.style.width = f.toFixed(2) + "%"; knob.style.left = f.toFixed(2) + "%";
      setText(t0, mmss(el2)); setText(t1, list[idx][1]);
      setHTML(pp, icon(playing ? "pause" : "play"));
    };
  }

  /* ====================================================================== *
   *  OPEN — the tile lands, the note rings, the name and the promise
   * ====================================================================== */
  function open(cam, api) {
    api.ambience(0, ...AMB.neutral);
    const halo = bloom(cam, 960, 470, 1300, "rgba(255,255,255,0.9)");
    const wrap = at(cam, 960, 500, "");
    const lk = lockup(wrap, 190);
    const l1 = at(cam, 960, 660, "headline");
    const l2 = at(cam, 960, 758, "headline soft");
    const w1 = words(l1, "Your own music,");
    const w2 = words(l2, "streamed from your own server.");

    const D0 = 0.35, HIT = 0.95, RING = HIT + 0.08, K0 = 1.5, KR = 0.08;
    api.grid("t0", HIT);
    api.cue("fall", D0 + 0.1, 0.6);
    api.cue("hit", HIT, 1);
    for (let i = 0; i < 4; i++) api.cue("tick", K0 + i * KR, 0.4);
    const s2 = api.segStart("open2");

    return function (t, T) {
      camera(cam, t, [[0, 1.06, 0, 0], [HIT, 1.0, 0, 0, 5]]);
      const drop = ramp(t, D0, D0 + 0.75);
      const ring = ramp(t, RING, RING + 0.55);
      const k = t < K0 ? 0 : (t - K0) / KR * 0.55;
      const centre = 1 - outQuint(ramp(t, K0 - 0.1, K0 + 0.65));
      lk.set(T, drop, ring, k, centre, ramp(t, K0 + 0.4, K0 + 0.9));
      const punch = t > HIT ? Math.exp(-(t - HIT) * 7) * 0.05 : 0;
      const lift = outQuint(ramp(t, s2 - 0.4, s2 + 0.6));
      wrap.style.transform = `translateY(${(-150 * lift).toFixed(1)}px) scale(${(1 + punch - 0.28 * lift).toFixed(4)})`;
      halo.style.opacity = (0.5 + 0.5 * (t > HIT ? Math.exp(-(t - HIT) * 1.5) : ramp(t, 0.2, HIT))).toFixed(3);
      kin(w1, t, s2 - 0.05, 0.07, 0.6);
      kin(w2, t, api.on("open2", "server") - 0.45, 0.07, 0.6);
    };
  }

  /* ====================================================================== *
   *  LIBRARY — a folder of files becomes a library
   * ====================================================================== */
  function library(cam, api) {
    const layer = api.layer;
    api.ambience(0, ...AMB.neutral);
    const h1 = at(layer, 960, 128, "headline");
    const h2 = at(layer, 960, 128, "headline");
    const hw1 = words(h1, "Put your songs in a folder.");
    const hw2 = words(h2, "Your library builds itself.");
    h1.style.fontSize = h2.style.fontSize = "72px";

    // the folder: any structure, any of the four formats
    const F = el("div", "finder", cam);
    Object.assign(F.style, { left: "110px", top: "250px", width: "600px", height: "700px" });
    const FILES = [
      [0, "dir", "Velvet Hour", ""], [1, "dir", "2024 - Afterglow", ""], [2, "f", "01 Golden Rule.flac", "FLAC"],
      [2, "f", "02 Stay Gold.flac", "FLAC"], [0, "dir", "Midnight Harbor", ""], [1, "f", "Blue Hour.mp3", "MP3"],
      [1, "f", "Smoke Rings.mp3", "MP3"], [0, "dir", "Downloads", ""], [1, "f", "Harbor Lights.m4a", "M4A"],
      [1, "f", "Aurora.ogg", "OGG"], [0, "f", "Night Drive.mp3", "MP3"], [0, "f", "Lighthouse.flac", "FLAC"],
      [0, "f", "Golden Hour.m4a", "M4A"], [0, "f", "Paper Planes - Fold.ogg", "OGG"],
    ];
    F.innerHTML = `<div class="chrome"><i></i><i></i><i></i><b>${ico("folder").replace("<svg", '<svg width="20" height="20" fill="none" stroke="#6e6e73" stroke-width="1.6"')}music</b></div>
      <div class="list">${FILES.map(([d, k, n, x]) => `<div class="ln ${k}" style="padding-left:${10 + d * 26}px">${k === "dir" ? ico("folder") : ico("note")}<span>${n}</span>${x ? `<span class="x">${x}</span>` : ""}</div>`).join("")}</div>`;
    const lines = [...F.querySelectorAll(".ln")];

    // the app: the Albums page, filling in
    const B = browser(cam, { x: 790, y: 236, w: 1030, h: 730, zoom: 1.0 });
    const SHOWN = ALBUMS.slice(0, 10);
    B.app.innerHTML = `${topbarHTML("Albums")}<div class="page"><div class="ph1">Albums</div><div class="phs">0 albums</div>
      <div class="grid">${SHOWN.map(([k, n, a, y]) => `<div class="card"><div class="art"><div class="cv">${coverSvg(k)}</div></div><div class="ct">${n}</div><div class="cs">${a} · ${y}</div></div>`).join("")}</div></div>`;
    const cards = B.$$(".card"), count = B.$(".phs");

    // chips: one file per album flies from the folder into its card
    const chips = SHOWN.map(([k, n]) => at(cam, 0, 0, "chipf", `${ico("note")}<span>${n}</span>`));

    const s1 = api.segStart("library1"), s2 = api.segStart("library2");
    const L0 = s1 - 0.1, LR = 0.075;
    const FLY0 = api.on("library2", "tags") - 0.2, FR = 0.16, FD = 0.75;
    const BUILD = api.on("library2", "builds");
    lines.forEach((_, i) => api.cue("tick", L0 + 0.2 + i * LR, 0.22));
    SHOWN.forEach((_, i) => { api.cue("swish", FLY0 + i * FR, 0.18); api.cue("pop", FLY0 + i * FR + FD, 0.35); });

    // where each card sits on stage, measured once
    const pos = [], fpos = [];
    afterFonts(() => {
      const c = cam.getBoundingClientRect();
      lines.forEach((ln, i) => { if (FILES[i][1] === "f") { const r = ln.querySelector("span").getBoundingClientRect(); fpos.push([r.left - c.left + r.width / 2, r.top - c.top + r.height / 2]); } });
      cards.forEach((cd) => { const r = cd.querySelector(".art").getBoundingClientRect(); pos.push([r.left - c.left + r.width / 2, r.top - c.top + r.height / 2]); });
    });
    const src = (i) => fpos[(i * 3) % fpos.length] || [400, 500];

    return function (t) {
      camera(cam, t, [[0, 1.0, 0, 18], [FLY0, 1.0, 0, 0, 2.5]]);
      kin(hw1, t, s1 - 0.15, 0.06, 0.55, s2 - 0.55);
      kin(hw2, t, s2 - 0.1, 0.06, 0.55);
      reveal(F, ramp(t, -0.2, 0.5), { dy: 50 });
      reveal(B.win, ramp(t, 0.0, 0.7), { dy: 60 });
      lines.forEach((ln, i) => reveal(ln, ramp(t, L0 + i * LR, L0 + i * LR + 0.4), { dy: 0, dx: -18 }));
      // the folder recedes once its files have gone
      F.style.opacity = lerp(1, 0.55, ramp(t, FLY0 + 0.4, FLY0 + 2.2)).toFixed(3);
      let landed = 0;
      SHOWN.forEach((_, i) => {
        const a = FLY0 + i * FR, b = a + FD;
        const p = ramp(t, a, b), e = inOutCubic(p);
        const [sx, sy] = src(i), [tx, ty] = pos[i] || [1200, 600];
        const x = lerp(sx, tx, e), y = lerp(sy, ty, e) - 120 * Math.sin(Math.PI * e);
        const ch = chips[i];
        ch.parentElement.style.left = x.toFixed(1) + "px"; ch.parentElement.style.top = y.toFixed(1) + "px";
        ch.style.opacity = (ramp(t, a - 0.05, a + 0.12) * (1 - ramp(t, b - 0.12, b))).toFixed(3);
        ch.style.transform = `scale(${lerp(1, 0.55, e).toFixed(3)})`;
        const c = ramp(t, b - 0.1, b + 0.45);
        const cv = cards[i].querySelector(".cv");
        cv.style.opacity = c.toFixed(3);
        cv.style.transform = `scale(${(c <= 0 ? 0.6 : lerp(0.6, 1, spring(c, 8, 5))).toFixed(4)})`;
        cards[i].querySelector(".ct").style.opacity = ramp(t, b + 0.05, b + 0.4).toFixed(3);
        cards[i].querySelector(".cs").style.opacity = ramp(t, b + 0.1, b + 0.45).toFixed(3);
        if (t >= b) landed++;
      });
      const total = Math.round(landed === SHOWN.length ? lerp(10, 36, inOutSine(ramp(t, BUILD - 0.2, BUILD + 0.8))) : landed);
      setText(count, `${total} album${total === 1 ? "" : "s"}`);
    };
  }

  /* ====================================================================== *
   *  PLAY — press play (the beat drops), search as you type, Now Playing
   * ====================================================================== */
  const SUGGEST = [
    ["Songs", [["afterglow", "Golden Rule", "Velvet Hour"], ["afterglow", "Stay Gold", "Velvet Hour"], ["golden", "Honey Slow", "Marlowe Reyes"]]],
    ["Albums", [["golden", "Golden Hour", "Marlowe Reyes"], ["velvetgold", "Velvet & Gold", "Marlowe Reyes"]]],
  ];
  function play(cam, api) {
    const layer = api.layer;
    const steps = stepCaptions(layer, [
      ["01", "Press play.", "In any browser."],
      ["02", "Search.", "Everything, as you type."],
      ["03", "Now Playing.", "And what’s up next."],
    ]);
    const B = browser(cam, { x: 820, y: 70, w: 1010, h: 940, zoom: 1.0 });
    B.app.innerHTML = `${topbarHTML("Albums")}
      <div class="hero"><div class="art">${coverSvg("afterglow")}</div><div><div class="kind">Album</div><h1>Afterglow</h1>
        <div class="meta">Velvet Hour · 2024 · 9 songs · 34 min</div>
        <div class="acts"><div class="pill dark go">${icon("play")}Play</div><div class="pill">${icon("shuffle")}Shuffle</div><div class="pill more">${icon("more")}</div></div></div></div>
      <div class="thead"><span>#</span><span>TITLE</span><span style="text-align:right">TIME</span><span></span></div>
      <div class="rows">${AFTERGLOW.map(([n, d], i) => `<div class="row"><div class="no"><em class="nn">${i + 1}</em><div class="eq"><i></i><i></i><i></i></div></div><div>${n}</div><div class="tm">${d}</div><div class="hv">${i === 1 ? icon("heartf") : ""}</div></div>`).join("")}</div>
      ${playerHTML()}
      <div class="npv"><div class="npbg"></div><div class="npclose">${icon("chev")}</div>
        <div class="npmain"><div class="npart">${coverSvg("afterglow")}</div><h2>Golden Rule</h2><div class="npa">Velvet Hour</div><div class="npal">Afterglow</div>
          <div class="npfrom">Playing from Afterglow</div>
          <div class="nptr">${icon("shuffle")}${icon("prev")}<div class="pp">${icon("pause")}</div>${icon("next")}${icon("repeat")}</div>
          <div class="npprog"><span class="n0">0:00</span><div class="bar"><b></b><u></u></div><span>3:15</span></div>
          <div class="npbtns"><span class="c">${icon("heart")}</span><span>${icon("playlists")}Add to Playlist</span><span>${icon("moon")}Sleep Timer</span></div></div>
        <div class="npq"><div class="qh"><b>Queue</b><span class="qb">${icon("plus")}Add</span><span class="qb">${icon("trash")}Clear</span><span class="qn">1 of 9</span></div>
          <div class="qs">Playing from Afterglow</div>
          ${AFTERGLOW.map(([n, d], i) => `<div class="qr${i === 0 ? " on" : ""}"><div class="qa">${coverSvg("afterglow")}${i === 0 ? '<div class="eq"><i></i><i></i><i></i></div>' : ""}</div><div><div class="qt">${n}</div><div class="qm">Velvet Hour</div></div><div class="qd">${d}</div></div>`).join("")}
        </div></div>`;
    const hero = B.$(".hero");
    const amb = el("div", "abs", hero);
    Object.assign(amb.style, { left: 0, right: 0, top: "-40px", height: "330px", zIndex: -1,
      background: "linear-gradient(180deg, rgba(255,176,143,0.32), rgba(245,245,247,0) 100%)" });
    hero.style.zIndex = 0;
    const rows = B.$$(".row"), go = B.$(".go");
    const player = playerCtl(B, AFTERGLOW, "afterglow", "Velvet Hour");
    const cur = pointer(cam);

    // the search field and its suggestions (TopBar.tsx: Songs, Albums, then "See all results")
    const search = B.$(".search"), stext = search.querySelector("span");
    search.style.position = "relative";
    search.style.overflow = "visible";
    const panel = el("div", "suggest", search);
    panel.innerHTML = SUGGEST.map(([g, items]) => `<div class="sg"><span class="sgl">${g}</span>${items.map(([k, n, m]) =>
      `<div class="si"><div class="sa">${coverSvg(k)}</div><span class="sn">${n}</span><span class="sm">${m}</span><span class="sp">${icon("play")}</span></div>`).join("")}</div>`).join("")
      + `<div class="sall">See all results for “gold”</div>`;
    const sitems = [...panel.querySelectorAll(".si")];

    // Now Playing, over the whole app
    const npv = B.$(".npv"), n0 = B.$(".npv .n0"), nfill = B.$(".npv .npprog b"), nknob = B.$(".npv .npprog u");
    const qeq = [...B.$(".npv .qr.on .eq").children];

    const s1 = api.segStart("play1"), s2 = api.segStart("play2"), s3 = api.segStart("play3");
    const GO = api.snap(api.on("play1", "play") + 0.12);
    api.grid("drop", GO);
    api.cue("click", GO, 1);
    const SCLICK = api.on("play2", "search") - 0.3, Q = "gold", TY = SCLICK + 0.35, RATE = 0.11;
    const SHOW = TY + RATE * 1.5;
    const ACT = api.on("play2", "type") + 0.3;             // the keyboard cursor lands on a suggestion
    const CCLICK = api.on("play3", "now") - 0.35;            // the player bar's cover opens Now Playing
    api.cue("click", SCLICK, 0.6);
    for (let i = 0; i < Q.length; i++) api.cue("key", TY + i * RATE, 0.4);
    api.cue("pop", SHOW + 0.05, 0.35);
    api.cue("click", CCLICK, 0.6);
    api.cue("swish", CCLICK + 0.05, 0.35);
    api.ambience(-0.2, ...AMB.afterglow);

    let goP = [1110, 365], sP = [1080, 220], cP = [860, 980];
    afterFonts(() => {
      const c = cam.getBoundingClientRect();
      const mid = (n, fx = 0.5, fy = 0.5) => { const r = n.getBoundingClientRect(); return [r.left - c.left + r.width * fx, r.top - c.top + r.height * fy]; };
      goP = mid(go, 0.42, 0.55); sP = mid(search, 0.45, 0.6); cP = mid(B.$(".player .pa"), 0.55, 0.6);
    });
    return function (t, T) {
      camera(cam, t, [[0, 1.0, 0, 0], [GO - 0.9, 1.05, -40, -22, 1.0], [SCLICK - 0.5, 1.13, -30, 190, 1.0], [CCLICK - 1.05, 1.0, 0, -10, 0.85]]);
      reveal(B.win, ramp(t, -0.3, 0.45), { dy: 60, scale: 0.98 });
      playSteps(steps, t, [s1 - 0.25, s2 - 0.2, s3 - 0.1]);

      const pos = path([[-0.2, 1240, 760], [GO - 0.05, goP[0], goP[1]], [SCLICK - 0.55, goP[0], goP[1]], [SCLICK, sP[0], sP[1]],
        [SCLICK + 0.7, sP[0] + 560, sP[1] + 90], [CCLICK - 0.75, sP[0] + 560, sP[1] + 90], [CCLICK, cP[0], cP[1]],
        [CCLICK + 0.8, cP[0] + 90, cP[1] + 40]])(t);
      cur(t, pos, [GO, SCLICK, CCLICK], ramp(t, -0.2, 0.2) * (1 - ramp(t, CCLICK + 0.2, CCLICK + 0.5)));
      const press = t > GO - 0.06 && t < GO + 0.2 ? Math.sin(Math.PI * ramp(t, GO - 0.06, GO + 0.2)) : 0;
      go.style.transform = `scale(${(1 - 0.04 * press).toFixed(4)})`;

      // what is playing: Golden Rule, from the click, in real time
      const el2 = t >= GO ? t - GO : 0;
      player(t >= GO ? 0 : -1, el2, t >= GO);
      rows.forEach((r, i) => {
        const on = t >= GO && i === 0;
        r.classList.toggle("on", on);
        r.querySelector(".nn").style.opacity = on ? 0 : 1;
        const eq = r.querySelector(".eq");
        eq.style.opacity = on ? 1 : 0;
        if (on) [...eq.children].forEach((b, j) => { b.style.transform = `scaleY(${eqLevel(T, j).toFixed(3)})`; });
      });

      // search: focus, type, suggestions; they close as Now Playing opens
      search.classList.toggle("focus", t >= SCLICK && t < CCLICK);
      const q = typed(Q, t, TY, RATE);
      setHTML(stext, t < SCLICK ? "Albums, artists, songs…"
        : `<em style="font-style:normal;color:var(--a-ink)">${q}</em>${blink(t - SCLICK, 1.0) && t < ACT ? '<i class="caret"></i>' : ""}`);
      const sp = ramp(t, SHOW, SHOW + 0.3) * (1 - ramp(t, CCLICK - 0.25, CCLICK));
      panel.style.opacity = sp.toFixed(3);
      panel.style.transform = `translateY(${(-8 * (1 - outCubic(sp))).toFixed(1)}px)`;
      panel.style.visibility = sp > 0 ? "visible" : "hidden";
      sitems.forEach((it, i) => {
        it.style.opacity = ramp(t, SHOW + 0.04 * i, SHOW + 0.04 * i + 0.25).toFixed(3);
        it.classList.toggle("act", t >= ACT && i === 0);
      });

      // Now Playing slides up from the player bar
      const np = outQuint(ramp(t, CCLICK + 0.05, CCLICK + 0.6));
      npv.style.visibility = np > 0 ? "visible" : "hidden";
      npv.style.transform = `translateY(${((1 - np) * 100).toFixed(2)}%)`;
      const f = clamp(el2 / 195) * 100;
      nfill.style.width = f.toFixed(2) + "%"; nknob.style.left = f.toFixed(2) + "%";
      setText(n0, mmss(el2));
      qeq.forEach((b, j) => { b.style.transform = `scaleY(${eqLevel(T, j).toFixed(3)})`; });
    };
  }

  /* ====================================================================== *
   *  SYNC — saved on your server; any browser picks up where you left off
   * ====================================================================== */
  function nowPlayingLaptop(parent) {
    const n = el("div", "abs", parent);
    Object.assign(n.style, { inset: 0 });
    n.innerHTML = `<div style="position:absolute;inset:0;background:linear-gradient(180deg,#f3e5f1,#f5f5f7)"></div>
      <div style="position:absolute;left:70px;top:60px;width:330px;height:330px;border-radius:14px;overflow:hidden;box-shadow:0 26px 50px -18px rgba(0,0,0,.45)">${coverSvg("northern")}</div>
      <div style="position:absolute;left:450px;top:120px;width:360px">
        <div style="font-size:13px;font-weight:600;letter-spacing:.08em;color:var(--a-muted)">NOW PLAYING</div>
        <div style="font-size:34px;font-weight:800;letter-spacing:-.025em;margin-top:8px">Aurora</div>
        <div style="font-size:18px;color:var(--a-2);margin-top:4px">Aurora Fields · Northern Light</div>
        <div class="lp" style="margin-top:36px;height:5px;border-radius:3px;background:rgba(0,0,0,.12);position:relative"><b style="position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:#1d1d1f"></b></div>
        <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--a-muted);margin-top:8px;font-variant-numeric:tabular-nums"><span class="lt0">1:12</span><span>6:04</span></div>
        <div style="display:flex;align-items:center;gap:22px;margin-top:20px;color:#1d1d1f">${icon("heart")}<span class="lh" style="display:none">${icon("heartf")}</span>
          <span style="display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;border:1px solid var(--a-border);border-radius:999px;padding:7px 14px">${icon("playlists")}Late night</span></div>
      </div>`;
    return n;
  }
  function sync(cam, api) {
    api.ambience(0, ...AMB.northern);
    // the laptop
    const L = el("div", "laptop", cam);
    Object.assign(L.style, { left: "90px", top: "340px", width: "800px", height: "520px" });
    L.innerHTML = `<div class="lid" style="width:800px;height:510px"><div class="scr"><div class="app" style="width:830px;height:518px;zoom:0.93"></div></div></div>
      <div class="base" style="left:-50px;top:510px;width:900px"></div>`;
    const lapp = L.querySelector(".app");
    lapp.style.position = "absolute";
    const np = nowPlayingLaptop(lapp);
    const lfill = np.querySelector(".lp b"), lt0 = np.querySelector(".lt0"), lh = np.querySelector(".lh");
    const lheart = lh.previousElementSibling;
    // the phone
    const PH = el("div", "phone", cam);
    Object.assign(PH.style, { left: "1440px", top: "250px", width: "350px", height: "720px" });
    PH.innerHTML = `<div class="scr"><div class="island"></div><div class="papp"><div class="ptop"><div class="bt">${noteSvg()}</div><div class="ps">${icon("search")}Search</div></div>
      <div class="np"><div class="big">${coverSvg("northern")}</div><h3>Aurora</h3><p>Aurora Fields</p>
      <div class="bar"><b></b><u></u></div><div class="tms"><span class="pt0">1:12</span><span>6:04</span></div>
      <div class="tr">${icon("prev")}<div class="pp">${icon("pause")}</div>${icon("next")}</div></div></div>
      <div class="sleep" style="position:absolute;inset:0;background:#0b0b0c"></div></div>`;
    const pfill = PH.querySelector(".np .bar b"), pknob = PH.querySelector(".np .bar u"), pt0 = PH.querySelector(".pt0"), sleep = PH.querySelector(".sleep");
    // the server
    const LK = el("div", "abs", cam);
    LK.innerHTML = `<svg width="1920" height="1080" style="position:absolute;left:0;top:0;overflow:visible"><path class="la" d="M 905 610 H 1110" fill="none" stroke="#1d1d1f" stroke-width="2.5" stroke-dasharray="2 12" stroke-linecap="round"/><path class="lb" d="M 1250 610 H 1420" fill="none" stroke="#1d1d1f" stroke-width="2.5" stroke-dasharray="2 12" stroke-linecap="round"/></svg>`;
    const la = LK.querySelector(".la"), lb = LK.querySelector(".lb");
    const pulse = at(cam, 0, 0, "", "");
    Object.assign(pulse.style, { width: "18px", height: "18px", borderRadius: "50%", background: "#1d1d1f", boxShadow: "0 0 0 6px rgba(29,29,31,0.12)" });
    const SV = at(cam, 1180, 625, "server", `<div class="box">${ico("server")}</div><div class="mlabel">your server</div>`);
    // the three things that are saved
    const CH = [["heartf", "Favorites"], ["playlists", "Playlists"], ["queue", "Queue"]].map(([i, l]) => at(cam, 0, 0, "chipx", `${ico(i)}${l}`));

    const s1 = api.segStart("sync1"), s2 = api.segStart("sync2");
    const HEART = api.on("sync1", "fav") - 0.05;
    const C = [api.on("sync1", "fav"), api.on("sync1", "lists"), api.on("sync1", "queue")];
    const WAKE = api.on("sync2", "browser") - 0.1;
    const h1 = at(cam, 960, 140, "headline");
    h1.style.fontSize = "68px";
    const hw1 = words(h1, "Saved on your server.");
    const h2 = at(cam, 960, 140, "headline");
    h2.style.fontSize = "68px";
    const hw2 = words(h2, "Picks up where you left off.");
    api.cue("pop", HEART, 0.6);
    C.forEach((c) => api.cue("swish", c + 0.05, 0.3));
    api.cue("wake", WAKE, 0.6);
    const tap = tapper(cam);

    // song position: 72 s at scene start, ticking in real time; the phone continues from the same moment
    const posAt = (t) => 72 + t;
    return function (t) {
      camera(cam, t, [[0, 1.0, 0, 0]]);
      reveal(L, ramp(t, -0.2, 0.5), { dy: 50 });
      LK.style.opacity = ramp(t, 0.4, 1.0).toFixed(3);
      la.setAttribute("stroke-dashoffset", (-t * 30).toFixed(1));
      lb.setAttribute("stroke-dashoffset", (-t * 30).toFixed(1));
      const pp = ramp(t, WAKE - 0.55, WAKE - 0.05);
      pulse.parentElement.style.left = lerp(1250, 1425, inOutSine(pp)).toFixed(1) + "px";
      pulse.parentElement.style.top = "610px";
      pulse.style.opacity = (Math.sin(Math.PI * pp)).toFixed(3);
      reveal(PH, ramp(t, 0.1, 0.8), { dy: 60 });
      reveal(SV, ramp(t, 0.3, 0.9), { dy: 30, scale: 0.9 });
      kin(hw1, t, s1 + 0.2, 0.06, 0.55, s2 - 0.45);
      kin(hw2, t, s2 + 0.05, 0.06, 0.55);
      // the laptop plays; the heart fills; the laptop goes to sleep as the phone wakes
      const pos = posAt(t);
      const LEFT = WAKE - 0.3;                                   // where the laptop was left
      const lpos = Math.min(pos, posAt(LEFT));
      lfill.style.width = (lpos / 364 * 100).toFixed(2) + "%";
      setText(lt0, mmss(lpos));
      lheart.style.display = t >= HEART ? "none" : "";
      const hb = ramp(t, HEART, HEART + 0.4);
      lh.style.transform = `scale(${(t < HEART ? 1 : spring(hb * 1.4, 12, 5)).toFixed(3)})`;
      lh.style.display = t >= HEART ? "inline-block" : "none";
      L.querySelector(".scr").style.filter = `brightness(${lerp(1, 0.5, ramp(t, LEFT, LEFT + 0.6)).toFixed(3)})`;
      // chips: laptop -> server
      CH.forEach((ch, i) => {
        const a = C[i], p = inOutCubic(ramp(t, a, a + 0.8));
        const sx = 600 + i * 70, sy = 640 - i * 70, tx = 1180, ty = 590;
        const x = lerp(sx, tx, p), y = lerp(sy, ty, p) - 150 * Math.sin(Math.PI * p);
        ch.parentElement.style.left = x.toFixed(1) + "px"; ch.parentElement.style.top = y.toFixed(1) + "px";
        ch.style.opacity = (ramp(t, a - 0.1, a + 0.15) * (1 - ramp(t, a + 0.65, a + 0.85))).toFixed(3);
        ch.style.transform = `scale(${lerp(1, 0.5, ramp(p, 0.5, 1)).toFixed(3)})`;
      });
      const ping = Math.max(...C.map((c) => (t > c + 0.8 ? Math.exp(-(t - c - 0.8) * 6) : 0)));
      SV.querySelector(".box").style.transform = `scale(${(1 + 0.06 * ping).toFixed(4)})`;
      // the phone: dark until it is picked up, then the same song at the same second
      tap(t, [1615, 760], WAKE);
      sleep.style.opacity = (1 - ramp(t, WAKE, WAKE + 0.35)).toFixed(3);
      const ppos = posAt(LEFT) + Math.max(0, t - WAKE - 0.3);
      pfill.style.width = (ppos / 364 * 100).toFixed(2) + "%"; pknob.style.left = (ppos / 364 * 100).toFixed(2) + "%";
      setText(pt0, mmss(ppos));
    };
  }

  /* ====================================================================== *
   *  PHONE — add it to the Home Screen; it opens like an app
   * ====================================================================== */
  function phone(cam, api) {
    api.ambience(0, ...AMB.bluehour);
    const PH = el("div", "phone", cam);
    Object.assign(PH.style, { left: "1080px", top: "120px", width: "420px", height: "860px" });
    PH.innerHTML = `<div class="scr"><div class="island"></div>
      <div class="web" style="position:absolute;inset:0;background:var(--a-canvas)"><div class="papp" style="font-size:15px"><div class="ptop"><div class="bt">${noteSvg()}</div><div class="ps">${icon("search")}Albums, artists…</div></div>
        <div style="padding:22px 20px;display:grid;grid-template-columns:1fr 1fr;gap:18px">${ALBUMS.slice(0, 6).map(([k, n, a]) => `<div><div style="aspect-ratio:1;border-radius:10px;overflow:hidden">${coverSvg(k)}</div><div style="font-size:14px;font-weight:600;margin-top:7px">${n}</div><div style="font-size:12px;color:var(--a-muted)">${a}</div></div>`).join("")}</div></div>
        <div class="scrim" style="position:absolute;inset:0;background:rgba(0,0,0,0.28)"></div><div class="sheet"><div class="hd"><div class="bt">${noteSvg("#1c1c1e")}</div><div><b>Flow</b><small>music.example.com</small></div></div>
          <div class="op"><span>Copy</span>${ico("copy")}</div><div class="op"><span>Add to Favorites</span>${ico("heart")}</div><div class="op add"><span>Add to Home Screen</span>${ico("plusbox")}</div></div></div>
      <div class="home" style="background:linear-gradient(160deg,#7d8fc9 0%,#b59ad6 50%,#f0b4a8 100%)">
        <div class="apps">${Array.from({ length: 15 }, (_, i) => `<div class="ap"><i style="background:rgba(255,255,255,${(0.28 + 0.2 * rnd(i)).toFixed(2)})"></i><span>&nbsp;</span></div>`).join("")}
          <div class="ap flow"><i>${noteSvg("#1c1c1e")}</i><span>Flow</span></div></div>
        <div class="dock"><i></i><i></i><i></i><i></i></div></div>
      <div class="opened" style="position:absolute;inset:0;background:var(--a-canvas)"><div class="papp"><div class="ptop" style="height:70px"></div>
        <div class="np" style="top:70px"><div class="big">${coverSvg("bluehour")}</div><h3>Blue Hour</h3><p>Midnight Harbor</p>
        <div class="bar"><b style="width:18%"></b><u style="left:18%"></u></div><div class="tms"><span>1:02</span><span>5:41</span></div>
        <div class="tr">${icon("prev")}<div class="pp">${icon("pause")}</div>${icon("next")}</div></div></div></div>
    </div>`;
    const scrim = PH.querySelector(".scrim");
    const sheet = PH.querySelector(".sheet"), add = PH.querySelector(".add"), home = PH.querySelector(".home");
    const flowIcon = PH.querySelector(".ap.flow"), opened = PH.querySelector(".opened");
    const tap = tapper(cam);
    const hl = at(cam, 560, 430, "headline");
    hl.style.fontSize = "76px";
    const hw = words(hl, "On your phone,");
    const sl = at(cam, 560, 530, "headline soft");
    sl.style.fontSize = "76px";
    const sw = words(sl, "like an app.");

    let addP = [1350, 820], iconP = [1420, 700];
    afterFonts(() => {
      const c = cam.getBoundingClientRect(), a = add.getBoundingClientRect(), f = flowIcon.querySelector("i").getBoundingClientRect();
      addP = [a.left - c.left + a.width * 0.35, a.top - c.top + a.height / 2];
      iconP = [f.left - c.left + f.width / 2, f.top - c.top + f.height / 2];
      opened.style.transformOrigin = `${(f.left - PH.querySelector(".scr").getBoundingClientRect().left + f.width / 2).toFixed(0)}px ${(f.top - PH.querySelector(".scr").getBoundingClientRect().top + f.height / 2).toFixed(0)}px`;
    });
    const s1 = api.segStart("phone1");
    const SHEET = s1 - 0.2, ADD = api.on("phone1", "home") + 0.15, HOME = ADD + 0.45, OPEN = api.on("phone1", "app") - 0.15;
    api.cue("swish", SHEET, 0.3);
    api.cue("tap", ADD, 0.8);
    api.cue("pop", HOME + 0.3, 0.6);
    api.cue("tap", OPEN, 0.8);
    api.cue("swell", OPEN + 0.05, 0.4);

    return function (t) {
      camera(cam, t, [[0, 1.0, 0, 0]]);
      reveal(PH, ramp(t, -0.2, 0.5), { dy: 60 });
      kin(hw, t, s1 - 0.1, 0.07, 0.55);
      kin(sw, t, api.on("phone1", "app") - 0.4, 0.07, 0.55);
      const sp = outQuint(ramp(t, SHEET, SHEET + 0.5));
      sheet.style.transform = `translateY(${((1 - sp) * 110).toFixed(1)}%)`;
      scrim.style.opacity = sp.toFixed(3);
      add.classList.toggle("hi", t > ADD - 0.1 && t < HOME);
      // the home screen, and the new icon landing on it
      const hp = ramp(t, HOME, HOME + 0.35);
      home.style.opacity = hp.toFixed(3);
      const ip = ramp(t, HOME + 0.25, HOME + 0.75);
      flowIcon.style.opacity = clamp(ip * 3).toFixed(3);
      flowIcon.style.transform = `scale(${(ip <= 0 ? 0 : spring(ip * 1.2, 10, 5)).toFixed(4)})`;
      // tap it: the app opens from the icon
      const op = outQuint(ramp(t, OPEN + 0.05, OPEN + 0.6));
      opened.style.opacity = clamp(op * 2).toFixed(3);
      opened.style.transform = `scale(${lerp(0.2, 1, op).toFixed(4)})`;
      opened.style.borderRadius = lerp(40, 0, op).toFixed(1) + "px";
      tap(t, addP, ADD);
      tap(t, iconP, OPEN);
    };
  }

  /* ====================================================================== *
   *  CARE — Organize fixes messy tags in bulk; unplayable songs repaired
   * ====================================================================== */
  // the Organize grid (views/OrganizeView.tsx): three songs with no album
  const ORG = [
    ["Night Drive", "Cassette Club", "", "Synthwave", 1],
    ["Rooftop Tape", "Cassette Club", "Polaroid Summer", "Synthwave", 0],
    ["Turquoise", "Cassette Club", "", "Synthwave", 1],
    ["Analog Love", "Cassette Club", "Polaroid Summer", "Synthwave", 0],
    ["Out of Order", "Cassette Club", "", "Synthwave", 1],
    ["Golden Rule", "Velvet Hour", "Afterglow", "Dream Pop", 0],
  ];
  const SET = "Chrome Sunset";
  function care(cam, api) {
    api.ambience(0, "#f3dc8f", "#9fd6cf");
    const h1 = at(cam, 960, 130, "headline");
    h1.style.fontSize = "72px";
    const hw1 = words(h1, "Tidy up in bulk.");
    const h2 = at(cam, 960, 150, "headline");
    h2.style.fontSize = "72px";
    const hw2 = words(h2, "Repaired automatically.");

    // Organize, as a sheet over the app
    const OW = 1240, OZ = 1.32;
    const O = el("div", "orgwin", cam);
    Object.assign(O.style, { left: (960 - OW / 2) + "px", top: "230px", width: OW + "px", height: "690px" });
    const app = el("div", "app", O);
    Object.assign(app.style, { zoom: OZ, width: (OW / OZ) + "px", height: (690 / OZ) + "px", position: "absolute" });
    app.innerHTML = `<div class="org">
      <div class="orgh"><b>Organize</b><div class="search">${icon("search")}<span>Filter songs…</span></div><span class="orgx">Done</span></div>
      <div class="orgstrip"><span class="ol">Needs attention</span><span class="op p1"><em>3</em> songs have no album</span><span class="op"><em>2</em> albums hold a single song</span><span class="oclean">Nothing needs attention — every track is grouped.</span></div>
      <div class="og"><div class="ogh"><span class="ck"></span><span>Title</span><span>Artist</span><span>Album</span><span>Genre</span></div>
        ${ORG.map(([t, a, al, g, bad]) => `<div class="ogr${bad ? " bad" : ""}"><span class="ck">${icon("check")}</span><span>${t}</span><span>${a}</span><span class="al">${al || "—"}</span><span>${g}</span></div>`).join("")}</div>
      <div class="orgbar"><span class="oc">3 selected</span><i></i><span class="oa sa">Set Album…</span><span class="oa">Set Artist…</span><span class="oa">Set Album Artist…</span><span class="oa">Set Genre…</span><i></i><span class="oq">Clear</span>
        <div class="orgpop"><div class="opi"><span class="opv"></span></div><div class="ops"><span class="sw2">${coverSvg("chrome")}</span><span>Chrome Sunset</span><small>Cassette Club</small></div><div class="opb">Apply</div></div></div>
      <div class="undo">Set album to “${SET}” · 3 songs<b>Undo</b></div>
    </div>`;
    const $ = (q) => app.querySelector(q), $$ = (q) => [...app.querySelectorAll(q)];
    const rows = $$(".ogr"), bad = rows.filter((r) => r.classList.contains("bad")), good = rows.filter((r) => !r.classList.contains("bad"));
    const p1 = $(".p1"), clean = $(".oclean"), strip = $(".orgstrip"), bar = $(".orgbar"), pop = $(".orgpop"), opv = $(".opv"), undo = $(".undo");
    const hck = $(".ogh .ck"), setA = $(".sa"), apply = $(".opb"), ops = $(".ops");
    const foot = at(cam, 960, 970, "url2", `Edits live in Flow<b>·</b>your music files are never changed`);
    foot.style.fontFamily = "var(--font)"; foot.style.fontSize = "24px";

    // the repair: a rip a browser refuses, rebuilt into a copy that plays
    const RP = at(cam, 960, 470, "fileb card2", `<div class="fi">${ico("note")}</div><div><div class="nm">City of Glass (radio rip).mp3</div><div class="mt rmt">Can’t play in this browser</div></div>`);
    const rst = el("div", "st", RP, `<span class="rsi">${ico("wrench")}</span><span class="rs">Repairing…</span>`);
    RP.style.zoom = 1.3;
    const reqb = eqBars(RP);
    reqb.node.style.fontSize = "26px";
    reqb.node.style.marginLeft = "14px";
    const wv = el("div", "wave", cam);
    Object.assign(wv.style, { left: "540px", top: "600px", width: "840px", height: "220px" });
    const WN = 64, wb = [];
    for (let i = 0; i < WN; i++) wb.push(el("i", "", wv));
    const rmt = RP.querySelector(".rmt"), rs = RP.querySelector(".rs"), rsi = RP.querySelector(".rsi");
    const cur = pointer(cam);

    const s1 = api.segStart("care1"), s2 = api.segStart("care2");
    const PILL = api.on("care1", "finds") + 0.1;           // the pill filters the grid to the three songs
    const SEL = api.on("care1", "fix") - 0.25;             // select them all
    const SETC = SEL + 0.55, TY = SETC + 0.3, RATE = 0.045;
    const APPLY = Math.max(TY + SET.length * RATE + 0.35, api.on("care1", "once") + 0.1);
    const SWAP = s2 - 0.55;
    const FIX0 = api.on("care2", "repaired") - 0.5, FIX1 = FIX0 + 0.7;
    api.cue("click", PILL, 0.6);
    api.cue("click", SEL, 0.6);
    api.cue("click", SETC, 0.5);
    for (let i = 0; i < SET.length; i++) api.cue("key", TY + i * RATE + (rnd(i) - 0.5) * 0.01, 0.28);
    api.cue("click", APPLY, 0.7);
    [0, 1, 2].forEach((i) => api.cue("pop", APPLY + 0.15 + i * 0.1, 0.3));
    api.cue("deny", s2 + 0.15, 0.5);
    api.cue("stream", FIX0, 0.5);
    api.cue("chime", FIX1, 0.8);

    let P = { pill: [700, 360], ck: [420, 450], set: [700, 880], apply: [900, 800] };
    afterFonts(() => {
      const c = cam.getBoundingClientRect();
      const mid = (n, fx = 0.5, fy = 0.5) => { const r = n.getBoundingClientRect(); return [r.left - c.left + r.width * fx, r.top - c.top + r.height * fy]; };
      bar.style.visibility = "visible"; pop.style.visibility = "visible"; bar.style.transform = "translate(-50%, 0)";
      P = { pill: mid(p1, 0.5, 0.6), ck: mid(hck, 0.6, 0.6), set: mid(setA, 0.45, 0.6), apply: mid(apply, 0.5, 0.6) };
      bar.style.visibility = ""; pop.style.visibility = ""; bar.style.transform = "";
    });
    // the filter: rows that aren't missing an album fold away
    const ROWH = 44;

    return function (t, T) {
      camera(cam, t, [[0, 1.0, 0, 0]]);
      kin(hw1, t, s1 - 0.1, 0.06, 0.55, SWAP);
      kin(hw2, t, s2 - 0.05, 0.06, 0.55);
      const out = ramp(t, SWAP - 0.25, SWAP + 0.3);
      reveal(O, ramp(t, -0.2, 0.5), { dy: 50, alpha: 1 - out, base: `translateY(${(-60 * inCubic(out)).toFixed(1)}px)` });
      O.style.display = out >= 1 ? "none" : "";
      reveal(foot, ramp(t, APPLY + 0.6, APPLY + 1.0), { dy: 12, alpha: 1 - out });

      const pos = path([[0.3, 1500, 900], [PILL - 0.05, P.pill[0], P.pill[1]], [SEL - 0.05, P.ck[0], P.ck[1]],
        [SETC - 0.05, P.set[0], P.set[1]], [APPLY - 0.05, P.apply[0], P.apply[1]], [APPLY + 0.8, P.apply[0] + 160, P.apply[1] + 60]])(t);
      cur(t, pos, [PILL, SEL, SETC, APPLY], ramp(t, 0.3, 0.6) * (1 - ramp(t, APPLY + 0.4, APPLY + 0.8)) * (1 - out));

      // the pill: on, then gone once the album is set
      const fl = inOutCubic(ramp(t, PILL + 0.05, PILL + 0.45));
      p1.classList.toggle("on", t >= PILL && t < APPLY + 0.5);
      const gone = ramp(t, APPLY + 0.45, APPLY + 0.8);
      p1.style.opacity = (1 - gone).toFixed(3);
      p1.style.maxWidth = (lerp(300, 0, gone)).toFixed(1) + "px";
      p1.style.marginRight = lerp(8, 0, gone).toFixed(1) + "px";
      p1.style.padding = gone >= 1 ? "0" : "";
      good.forEach((r) => { r.style.height = (ROWH * (1 - fl)).toFixed(1) + "px"; r.style.opacity = (1 - fl).toFixed(3); });
      // selection
      const sel = ramp(t, SEL, SEL + 0.25);
      hck.classList.toggle("on", sel > 0.5 && t < APPLY + 0.5);
      bad.forEach((r, i) => r.classList.toggle("sel", t >= SEL + i * 0.06 && t < APPLY + 0.5));
      const bp = outQuint(ramp(t, SEL + 0.1, SEL + 0.45)) * (1 - ramp(t, APPLY + 0.15, APPLY + 0.35));
      bar.style.visibility = bp > 0 ? "visible" : "hidden";
      bar.style.opacity = bp.toFixed(3);
      bar.style.transform = `translate(-50%, ${(24 * (1 - bp)).toFixed(1)}px)`;
      setA.classList.toggle("hot", t >= SETC - 0.05 && t < APPLY + 0.3);
      const pp = outCubic(ramp(t, SETC + 0.05, SETC + 0.25)) * (1 - ramp(t, APPLY + 0.1, APPLY + 0.3));
      pop.style.visibility = pp > 0 ? "visible" : "hidden";
      pop.style.opacity = pp.toFixed(3);
      setHTML(opv, typed(SET, t, TY, RATE) + (t < APPLY && blink(t) ? '<i class="caret"></i>' : ""));
      ops.style.opacity = ramp(t, TY + 4 * RATE, TY + 4 * RATE + 0.15).toFixed(3);
      apply.classList.toggle("hot", t >= APPLY - 0.08 && t < APPLY + 0.15);
      // the album lands on each song
      bad.forEach((r, i) => {
        const a = r.querySelector(".al"), at0 = APPLY + 0.15 + i * 0.1;
        setText(a, t >= at0 ? SET : "—");
        r.classList.toggle("bad", t < at0);
        r.classList.toggle("fixed", t >= at0 && t < at0 + 0.9);
      });
      clean.style.opacity = ramp(t, APPLY + 0.8, APPLY + 1.1).toFixed(3);
      clean.style.display = t >= APPLY + 0.75 ? "" : "none";
      strip.querySelectorAll(".op").forEach((o, i) => { if (i > 0) o.style.display = t >= APPLY + 0.75 ? "none" : ""; });
      const up = outQuint(ramp(t, APPLY + 0.4, APPLY + 0.8));
      undo.style.visibility = up > 0 ? "visible" : "hidden";
      undo.style.opacity = up.toFixed(3);
      undo.style.transform = `translate(-50%, ${(20 * (1 - up)).toFixed(1)}px)`;

      // the repair
      reveal(RP, ramp(t, SWAP + 0.35, SWAP + 0.85), { dy: 50 });
      const fix = inOutCubic(ramp(t, FIX0, FIX1));
      setText(rs, t < FIX0 ? "Can’t play" : t < FIX1 ? "Repairing…" : "Repaired");
      setHTML(rsi, t < FIX0 ? ico("x") : t < FIX1 ? ico("wrench") : ico("check"));
      setText(rmt, t < FIX1 ? "Can’t play in this browser" : "Plays everywhere · original kept");
      reqb.node.style.display = t >= FIX1 ? "flex" : "none";
      reqb.set(T, 1);
      wv.style.opacity = ramp(t, SWAP + 0.5, SWAP + 1.0).toFixed(3);
      wb.forEach((b, i) => {
        const healthy = 24 + 170 * (0.35 + 0.65 * rnd(i * 2.3)) * (0.6 + 0.4 * Math.sin(i * 0.5 + 1));
        const broken = i % 7 === 3 || i % 11 === 5 ? healthy * 0.9 : 6;          // mostly flat, a few stray spikes
        const h = lerp(broken, healthy, clamp(fix * 1.4 - (i / WN) * 0.4));
        const pulse = t >= FIX1 ? 1 + 0.12 * (eqLevel(T, i % 3) - 0.5) : 1;
        b.style.height = (h * pulse).toFixed(1) + "px";
        b.style.opacity = lerp(0.35, 1, fix).toFixed(3);
      });
    };
  }

  /* ====================================================================== *
   *  SELF-HOST — free, open source, one command
   * ====================================================================== */
  function selfhost(cam, api) {
    api.ambience(0, ...AMB.golden);
    const l1 = at(cam, 470, 430, "headline");
    l1.style.fontSize = "70px";
    const w1 = words(l1, "Free and open source.");
    const l2 = at(cam, 470, 520, "headline soft");
    l2.style.fontSize = "70px";
    const w2 = words(l2, "One command to try it.");
    const meta = at(cam, 470, 610, "url2", `MIT License<b>·</b>github.com/polius/Flow`);
    meta.style.fontSize = "24px";

    const TM = el("div", "term", cam);
    Object.assign(TM.style, { left: "940px", top: "300px", width: "900px", height: "450px" });
    TM.innerHTML = `<div class="tb"><i></i><i></i><i></i><div class="ttl">you@server — zsh</div></div><div class="body"></div>`;
    const body = TM.querySelector(".body");
    const CMD = "docker run --rm -e DEMO=true \\\n    -p 8080:8080 poliuscorp/flow";
    const OUT = [
      ["d", "Demo library generated: 36 albums, 330 tracks"],
      ["d", "Scan finished: 330 new/changed, 0 errors"],
      ["d", "Application startup complete."],
      ["ok", "→ open http://localhost:8080"],
    ];
    const s1 = api.segStart("self1"), s2 = api.segStart("self2");
    const TY = s1 + 0.35, RATE = 0.028;
    const RUN = TY + CMD.length * RATE + 0.15;
    for (let i = 0; i < CMD.length; i += 2) api.cue("key", TY + i * RATE, 0.26);
    api.cue("enter", RUN, 0.7);
    OUT.forEach((_, i) => api.cue("tick", RUN + 0.35 + i * 0.28, 0.3));

    return function (t) {
      camera(cam, t, [[0, 1.0, 0, 0]]);
      kin(w1, t, s1 - 0.1, 0.06, 0.55);
      kin(w2, t, s2 - 0.05, 0.06, 0.55);
      reveal(meta, ramp(t, s2 + 0.4, s2 + 0.9), { dy: 14 });
      reveal(TM, ramp(t, -0.1, 0.6), { dy: 60 });
      const typedCmd = typed(CMD, t, TY, RATE);
      let html = `<div class="ln"><span class="p">$ </span>${typedCmd.replace("\n", "</div><div class=\"ln\">")}${t < RUN ? (blink(t, 0.9) ? '<span class="caret"></span>' : "") : ""}</div>`;
      OUT.forEach(([c, s], i) => { if (t >= RUN + 0.35 + i * 0.28) html += `<div class="ln ${c}">${s}</div>`; });
      setHTML(body, html);
    };
  }

  /* ====================================================================== *
   *  OUTRO — the name, the promise, where to get it
   * ====================================================================== */
  function outro(cam, api) {
    api.ambience(0, ...AMB.neutral);
    const wrap = at(cam, 960, 430, "");
    const lk = lockup(wrap, 170);
    const tag = at(cam, 960, 640, "headline");
    tag.style.fontSize = "64px";
    const tw = words(tag, "Your music, on your own server.");
    const pill = at(cam, 960, 770, "try", `${ico("github").replace("<svg", '<svg width="32" height="32"')}<span>github.com/polius/Flow</span>`);
    const foot = at(cam, 960, 870, "url2", `docker run -e DEMO=true poliuscorp/flow<b>·</b>MIT`);
    foot.style.fontSize = "22px";
    const HIT = api.segStart("outro1") - 0.15;
    api.cue("hit", HIT, 0.8);
    const s2 = api.segStart("outro2");
    return function (t, T) {
      camera(cam, t, [[0, 1.04, 0, 0], [HIT, 1.0, 0, 0, 4]]);
      lk.set(T, ramp(t, HIT - 0.55, HIT + 0.2), ramp(t, HIT - 0.1, HIT + 0.45), (t - HIT - 0.1) / 0.07 * 0.55, 0, ramp(t, HIT + 0.3, HIT + 0.8));
      kin(tw, t, s2 - 0.1, 0.06, 0.6);
      reveal(pill, ramp(t, s2 + 0.5, s2 + 1.0), { dy: 24, scale: 0.96 });
      reveal(foot, ramp(t, s2 + 0.8, s2 + 1.3), { dy: 14 });
    };
  }

  Object.assign(window.SCENES, { open, library, play, sync, phone, care, selfhost, outro });
})();
