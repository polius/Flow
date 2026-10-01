# Flow — UX & Product Review (senior-level)

> **Date:** 2026-10-01 · **Scope:** product, features, interaction, design system — not bugs.
> **Method:** full click-through of every surface (Home, Tracks, Albums/Artists + details,
> Favorites, Playlists + editor, Search/Spotlight, Organize, Now Playing, queue, phone layouts,
> both themes) against a 2,400-track generated library, plus code review of the moments that
> didn't survive contact.
>
> **How to use this file:** one Part per fresh session. Each work item below is a checkbox —
> tick it when shipped, and add a §-addendum to `docs/DESIGN.md` recording the decision, as the
> contract requires. Exact code references are included so a fresh session doesn't need to
> rediscover them.

---

## The verdict

This is the most disciplined self-hosted music app reviewed against the §8.0 bar. The token
system, the state completeness (hover/focus/disabled/empty/loading), the undo grammar, the
phone ladder, reduced-motion, the honest restraint — most commercial apps never reach this
level.

But it is a **beautiful shell around a fragile listening experience**. The polish is
concentrated on *managing* music; the moments that actually *carry* music — a queue that
survives a refresh, an album header, the end of a playlist at midnight — are where the app is
thinnest. Apple review framing: *the furniture is excellent; the load-bearing walls need
rebuilding.*

Three of the Part-1 issues are not polish items. They are the difference between "a demo of a
music player" and "my music player."

---

## Part 1 — Four cracks in the foundation (fix before anything else)

### 1.1 Playback dies with a page reload, and "Continue listening" was never shipped

The player store deliberately persists only volume/shuffle/repeat
(`frontend/src/stores/player.ts`, `partialize` in the `persist` wrapper: *"queue/position are
session state"*). Refresh the tab — accidental Cmd+R, an OS update, a laptop waking from sleep
with a dropped socket — and the music is simply gone. Meanwhile §13.9 of the contract decided a
**"Continue listening"** Home section (last track + position + queue from localStorage) —
`frontend/src/views/HomeView.tsx` doesn't contain it. The decision was made and never
implemented.

For a web app this is the single largest experience defect. Apple's bar is that state loss is
*never* total — Music.app, Safari, podcasts: everything resumes.

**Do:**
- [x] Persist queue + order + orderPos + position + timestamp (localStorage via the existing
      `persist` middleware, or the §4.0 server queue below).
- [x] Restore silently on load: paused, player bar populated (respect autoplay policies; a
      "Resume?" affordance is acceptable).
- [x] Give Home its promised "Continue listening" section (§13.9).

### 1.2 The queue is silently truncated to whatever the window has loaded

`frontend/src/components/VirtualTrackTable.tsx` → `play(tracks, index)` calls
`playTracks(tracks, index)` where `tracks` = `pages.flatMap(p => p.items)` — the *loaded pages*
of the Tracks infinite query (`PAGE_SIZE = 1000`). Verified in the running app with 2,400
tracks: click the first row on a fresh load, the queue header reads **"15 of 1000."** The other
1,400 tracks were never queued. Whether a track's play-through includes the rest of the library
depends on how far the user happened to have scrolled first. Non-deterministic queue —
indefensible at the scale the virtualization milestone was built for.

**Do:**
- [x] "Play from here" must mean *the whole view*. Either fetch the full filter (see §4.0
      server queue) or fetch remaining pages in the background on play.
- [x] The user must never be able to observe the truncation.

### 1.3 Escape is broken app-wide whenever a button or link has focus

Hit twice in ten minutes of real use: Now Playing refused to close with Esc; the Organize
sheet refused to close with Esc. Root cause: `isTypingTarget()` in
`frontend/src/lib/shortcuts.ts` — the guard designed to stop **Space/arrows** from
double-firing on focused controls — also lists `BUTTON` and `A`, and the **Esc** handlers in
`frontend/src/components/NowPlaying.tsx` and `frontend/src/components/OrganizeSheet.tsx`
consult it. In a pointer UI, *some button has focus almost always* (whatever was last clicked),
so the app's most-trusted dismissal gesture fails at random.

§16.4 documents Esc precedence as a settled, verified behavior — it isn't, and this is exactly
the class of "invisible detail" §8.0 point 5 makes first-class.

**Do:**
- [x] The "must not fire while typing" rule applies to Space and arrows only. Esc always closes
      the topmost surface; only *text-input* focus (mid-edit, where Esc means "cancel the edit")
      defers it.
- [x] Add a regression test: click a button, then press Esc — the frontmost surface must close.

### 1.4 A missing or unreadable file stops playback dead

`frontend/src/stores/player.ts` `error` handler: *"stop cleanly rather than hang"* — sets
`isPlaying: false`. In a self-hosted library, files *do* vanish between scan and play (moved on
the NAS, flaky mount, half-written file). Apple's behavior — and Plex's, the stated model — is
to skip to the next playable track and say so.

**Do:**
- [x] Auto-advance on stream error (bounded skip streak so a dead library doesn't machine-gun
      through the queue), plus one quiet undo-toast-style notice: *"Skipped "X" — file
      unavailable."*
- [x] Surface the scan's error count in Settings (already collected by the scanner, just not
      shown — see 2.8).

---

## Part 2 — The product: where it stops short of "perfect"

Ordered by impact on daily listening.

### 2.1 Header actions are incomplete — and the one-path "Add to Playlist" is a workflow dead-end

Album detail offers exactly one action: Play (no Shuffle beside it). Artist detail offers
*zero* actions on 500 songs. And per §23, the only route to any playlist is opening that
playlist → Add Tracks → search. Building a playlist from an album you're looking at means
re-finding it by typing. §23 framed this as centralization; in practice it's a tax on the most
common curation gesture. Apple's answer, everywhere, is a consistent header trio:
**Play · Shuffle · …**, where "…" carries Add to Playlist / Play Next.

**Do:**
- [x] Album detail: Play + Shuffle + "…" menu (Add to Playlist, Play Next).
- [x] Artist detail: Play + Shuffle + "…" on the whole catalog (and per-album via the cards).
- [x] Restore per-track "Add to Playlist" reachability (row menu / drag-to-queue). Recovery,
      not friction, is the HIG pattern the undo grammar already proves.

### 2.2 The data model will crack on real libraries

One artist per track, no genre, no composer, no multi-value anything. Real libraries are full
of "Artist A & Artist B," "feat. X," compilations, and genres people browse by. §1 rules out
ratings and social — it does not rule out *genres* or *credited artists*, and their absence is
the first thing a large real library punishes.

**Do (schema migration; Organize becomes the editing surface):**
- [x] tracks↔artists join table with roles (main / featured / composer).
- [x] tracks↔genres join table (parsed from tags at scan; genre browsing section or filter).
- [x] Compilation handling via album-artist semantics surfaced in Organize (§22's
      `mixed_album_artist` review item is the seed).

### 2.3 Volume normalization

Nothing else changes how the app *feels* as much as Sound Check-style level matching (EBU R128
/ ReplayGain computed at scan time, applied client-side via GainNode — a one-node Web Audio
graph; a deliberate exception to the "no Web Audio" stack decision worth making explicitly).
Album-to-album volume whiplash is the number-one complaint about library players.

**Do:**
- [x] Scan-time loudness analysis (store the gain value on the track row).
- [x] Apply client-side; toggle in Settings ("Sound Check"), persisted like volume.

### 2.4 Albums and Artists have no sort, no view options

Tracks/Favorites have a full sort grammar (`SortMenu`); Albums is frozen at the backend
default. Apple Music's Albums page has a sort menu and it is used.

**Do:**
- [x] Albums: sort (Title / Artist / Year / Recently added) in the URL, same grammar as Tracks.
- [x] Artists: sort; consider year section-headers or a letter index at scale. *(sort + direction
      shipped; letter index considered and deferred — §30.6.)*

### 2.5 Home is a room without furniture

Today: a stats line and "Recently added." No continue listening, no recently played, no
shuffle-everything escape hatch. An empty room is not minimal — it's unfinished.

**Do:**
- [x] Three modules: Continue listening (1.1), Recently added, a "Shuffle all" card.
- [x] If Home stays this thin after that, cut the route and land on Albums. *(resolved: Home
      keeps its place — it now has Continue listening, Shuffle all, Recently added, Playlists.)*

### 2.6 Gapless playback

Deferred as a "future nicety" — agreed, but for live/electronic albums the 100–200ms
HTMLAudioElement gap is audible and is the one playback defect that can't be styled away.

**Do:**
- [x] Dual-element pre-roll (or `HTMLAudioElement` + Web Audio scheduling) when the listening
      experience is otherwise solid. Schedule after P0/P1.

### 2.7 The tab, the icon, the install

No favicon, no `document.title` reflection of the playing track, no PWA manifest. A web app
people keep open for hours should read *"Artist — Track"* in the tab and be installable to a
home screen (which, with Media Session — already implemented — behaves like an app on iPad).

**Do:**
- [x] Favicon + apple-touch-icon.
- [x] `document.title` follows the playing track; reverts when idle.
- [x] PWA manifest (name, icons, `display: standalone`, theme-color for both ramps).

### 2.8 Settings is too quiet about the machine

The scan is the app's most complex real event; its failure modes (skipped files, mount-guard
trips) are invisible. The scanner already counts errors (§11.6, §14.1) — the UI just never
shows them.

**Do:**
- [x] "Last scan: N files skipped — view" disclosure listing path + reason.
- [x] Mount-guard trip gets its own visible, calm explanation state.

---

## Part 3 — The design system: a candid critique

### 3.1 The accent color is the weakest Apple-like decision in the app

A mid red (`--accent: #d64541`, light) appears in: active nav pills, playing-row equalizer
bars, swipe-reveal actions, links, sort checkmarks, the Organize count. Two problems:

1. Red is *alarm*-coded — red heart-outline hover, red active states read as errors waiting to
   happen.
2. It **fights the artwork** — the one source of color rule §8.1 protects. A blue-teal cover
   next to red-accented chrome breaks the rule by way of the chrome.

The most Apple resolution is the one §24 already discovered for rows: *the system needs almost
no accent at all.* Reserve the accent for one moment of true state — the playing bars — and let
inversion, fills, and weight carry everything else. Monochrome chrome + colored art is the
strongest version of this design language; a permanent red is a watermark on it.

**Do:**
- [ ] Decide the accent's future explicitly with the owner (drop it / reduce to the playing
      bars). Record the outcome as a DESIGN.md addendum either way.

### 3.2 Typography: the hierarchy is right, the sizes are one notch shy

13px body (`--text-body`) for primary row titles in an airy canvas reads as *dense*; §8.3 asks
for density only in tables, not hero moments. Music.app's track titles sit a step larger with
12–13px metadata doing the quieting. (Tabular numerals: already correct.)

**Do:**
- [ ] Raise primary text one step; let secondary metadata carry the hierarchy.

### 3.3 Motion and ambience: the strongest visual work — protect it

The blurred-art ambience with the mask dissolve on album detail, the quiet `--bg-active`
playing row, the play/pause crossfade, the §27 lift-and-part drag grammar — this is the level.
Nothing to fix; everything to protect from future accretion.

### 3.4 Details that fell short of the bar

- [ ] **Scrubbing doesn't preview.** `Scrubber` (`frontend/src/components/transport.tsx`) seeks
      on release only; Music seeks *live* under the thumb. `timeupdate`-driven position (4Hz)
      also steps rather than glides — an rAF position loop is the professional version.
- [ ] **The volume icon is decoration.** Not a button, no mute. Click-to-mute is expected
      muscle memory.
- [ ] **The Add Tracks picker caps at 200** (`RESULT_LIMIT` in
      `frontend/src/components/AddTracksDialog.tsx`) and "Select all" selects only those 200 —
      silently — while the header advertises "LIBRARY — 2400 TRACKS." Track 201+ is reachable
      only by guessing search terms. Paginate / load-more, or select-all server-side by filter.
- [ ] **Modals don't manage focus.** Get Info, Now Playing, and Organize declare
      `aria-modal="true"` but don't move focus in, trap Tab, or restore it on close; only
      `AddTracksDialog` focuses its field. Background content stays live to screen readers and
      Tab.
- [ ] **Tables aren't keyboard-navigable as tables.** Track rows are `role="row"` with inner
      tabbable buttons only — no arrow-key cursor, no Enter-to-play. The Organize grid *does*
      implement Finder-style cursors; the listening tables should inherit that grammar.
- [ ] **"Nothing playing" bar is ambiguous in dark mode** — the play button stays fully
      saturated while disabled and the empty scrubber track nearly disappears. A treatment that
      actually dims would resolve it.
- [ ] **Queue drawer's "N of 1000"** currently advertises the truncation (1.2); after the queue
      fix it becomes an honest, useful signal.

---

## Part 4 — The one structural change worth making

### 4.0 Make the queue a first-class, server-truth object

`POST /api/queue {filter | track_ids, start}` — "play this view" enqueues the *whole* filter
(fixes 1.2 for good), the queue survives reloads (fixes 1.1 for good), and it opens the obvious
futures without new architecture: continuing the same queue from another browser on the LAN
(the no-auth, single-user, multi-screen household is the exact deployment), queue-aware Media
Session, and eventually resume after container restarts. The client store remains the source of
*UI* truth; the server becomes the source of *truth* truth. A weekend of backend for a
permanent upgrade to the app's spine.

### 4.1 Two strategic notes on settled decisions

- **Revisit the "no play counts" non-goal narrowly.** The exclusion of charts/ratings is
  right. But "recently played / continue listening" is private, count-free, and the difference
  between an app you *manage* and an app that *knows you*. §13.9 already conceded the concept
  via localStorage — a server `played_at` timestamp (no counts shown) completes it honestly.
- **The no-auth stance is fine on the LAN it was designed for.** If the README is ever read by
  someone port-forwarding, a one-line warning (or opt-in bearer token) is the responsible
  amount of friction. Not a product change; a guardrail on the contract.

### 4.2 Future candidates (not commitments)

- Smart playlists (rule-based, SQLite-cheap) — lasting value without violating §1.
- ReplayGain per-album vs per-track modes.
- Multiple library roots (explicit non-goal at MVP; revisit only if the schema work in 2.2
  lands).

---

## Priority order

**P0 — the walls (Part 1):** queue persistence + restore; full-filter queues; Esc fix;
auto-skip on stream error.

**P1 — the experience (Part 2 top):** header action sets (Play/Shuffle/…), Add-to-Playlist
reachability, Albums/Artists sort, Home earns or loses its place, live scrubbing.

**P2 — the system (Parts 2–3):** normalization scan, genres/multi-artist migration,
Add-Tracks pagination + select-all-by-filter, modal focus management, keyboard tables.

**P3 — the shine (Parts 2–3 tail):** PWA manifest/icons/title, Settings scan disclosures,
gapless, type-scale step, accent re-think.

---

## Closing note for the implementing sessions

The design document is unusually good, and the strongest thing about the project is that every
addendum ends with *verified in the running app*. Several fixes above (Esc, continue-listening,
queue truth) are deviations from settled decisions — decisions §12 says not to re-litigate.
They should be re-litigated, because the contract was written feature-first and these surfaces
are experience-first. The Esc bug and the 1000-track queue both survived the verification
process because verification tests features in isolation, not a person listening.

Add one more standing verification to every session's exit checklist:

> *Reload mid-song · press Esc immediately after clicking a button · play a 2,400-track library
> end to end.*

Then this app stops being an excellent player-shaped object and becomes the thing it set out
to be.
