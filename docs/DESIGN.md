# Flow — Design Document

> **Status:** Approved plan. This document is the single source of truth for implementation.
> A prior design session made and agreed every decision below with the project owner.
> **Do not re-litigate settled decisions.** If something here seems questionable, raise it with
> the user before changing course. Do not implement beyond the current milestone without asking.
> **Apple-level quality (§8.0) is a standing constraint on every change** — it applies in
> every session without the user having to repeat it.

---

## 1. What this is

**Flow** (working title) is a lightweight, self-hosted, Dockerized music player web app —
"like Spotify but for your own files", in the spirit of how Plex manages a media folder.

- The user points it at a folder of music files (mounted volume). The app **scans** it, indexes
  metadata, and streams the audio. **No uploads. Ever.** (Plex model, not Dropbox model.)
- The user **manages metadata in the app**: rename tracks, edit artist/album, build playlists.
  These edits are stored in SQLite as overlays — the audio files themselves are never modified.
- **Single user, local/self-hosted. No login system, no multi-user.** Auth is a future
  iteration — do not add it, and do not build abstractions "for when auth arrives".
- **UI/UX is the top priority.** Apple-like design quality — a standing constraint on every
  change, not a final polish pass. The bar is Apple Music, not Dribbble: interactions, states,
  edge cases, and invisible details are engineered to the same level as the visuals.
  See §8 and §9.

### Non-goals (explicit, agreed — do not add)

- Login / auth / users / permissions
- File uploads or any file mutation (never write to the music folder)
- Ratings, play counts, charts, "top 40" features
- Equalizer, lyrics, Chromecast, mobile apps, social features
- Multi-library support (one folder per instance at MVP)

---

## 2. Reference material context

Three Dribbble-style reference images were reviewed during design (light-theme music player
concepts). Conclusions reached — keep these lessons, do not copy the images:

**Keep from references:**
- Anatomy: left sidebar nav, content canvas, persistent bottom player bar, full-screen
  art-forward "Now Playing" hero view.
- Light, airy, art-first presentation.

**Reject from references (they are filler / fake features):**
- "Upgrade Plan" buttons, user avatars, star ratings, play counts ("240.594.288 plays"),
  charts, decorative equalizer dots, generic pastel gradient cards. These are exactly the
  "AI slop" look the owner explicitly wants to avoid.
- Chrome around the artwork must be near-monochrome. **The album art is the only source of
  color in the UI.**

---

## 3. Tech stack (decided)

| Layer | Choice | Notes |
|---|---|---|
| Backend | **Python 3.13 + FastAPI + uvicorn** | Owner preference; see rationale below |
| Database | **SQLite (WAL mode)** via stdlib `sqlite3` + thin data layer | No SQLAlchemy, no Alembic for MVP — 6 tables. Migrations via `PRAGMA user_version` + versioned SQL scripts. Revisit if schema grows. |
| Metadata parsing | **`mutagen`** | Best-in-class for ID3v1/v2.2/2.3/2.4, Vorbis comments, MP4 atoms, FLAC pictures; handles real-world ugly files |
| File watching | **`watchdog`** | Reflect new/removed/moved files automatically |
| Frontend | **React + Vite + TypeScript** | |
| Frontend state | **Zustand** (player state) + **TanStack Query** (server state) | |
| Styling | CSS custom properties design-token system (see §8) | Not Tailwind — the owner wants a bespoke Apple-like system; Tailwind defaults trend toward the slop look |
| Playback | Native `HTMLAudioElement` | No Web Audio graph at MVP. Gapless is a future nicety, not MVP. |
| Deployment | **Single Docker container, nginx + uvicorn behind `tini`** | See §10 — includes pitfalls that were explicitly worked through |

### Stack rationale (already debated with the owner — do not reopen)

- FastAPI was chosen over Node/TS deliberately. Deciding factors: owner maintains in Python;
  backend surface is tiny (~15 endpoints); `mutagen` beats JS alternatives on real-world tags;
  TS type safety is preserved by generating the API client from OpenAPI.
- Audio playback is 100% client-side; the server only streams bytes with Range headers.
- Scanning is CPU-bound Python but runs as a background job — a non-issue at 10k files.
- nginx was kept over "uvicorn alone" because **seek-correct audio streaming with Range is a
  core UX requirement**, and nginx's `sendfile` + Range implementation is more reliable than
  anything hand-rolled. It also gives gzip/caching for the JS bundle and aggressive artwork
  caching.

### Supported audio formats (MVP)

`mp3`, `flac`, `m4a/aac`, `ogg`. Others (wav, opus, wma…) can be added later; scope is fixed
for MVP.

---

## 4. Product scope

### In scope

1. **Library scan** of one configured folder (`/music` in the container, configurable via env).
   Recursive. Reads tags: title, artist, album artist, album, track no, disc no, year,
   duration, embedded artwork. Falls back to filename parsing when tags are missing.
2. **Background re-scan + filesystem watching** (chokidar semantics via `watchdog`): new,
   removed, and moved files are reflected automatically. Scan progress is visible in the UI
   ("Scanning… 342/1,204") over **SSE**.
3. **Views:** Home, Albums, Artists, Tracks (all songs), Playlists, Search, Now Playing, Settings.
4. **Playlist CRUD:** create, rename, delete, add/remove tracks, reorder (drag & drop).
5. **Track editing:** title, artist, album, track number via a "Get Info" panel + inline
   rename. Stored in SQLite — files untouched.
6. **Favorites** (simple heart flag on tracks).
7. **Player:** play/pause, next/prev, seek, shuffle, repeat (off/all/one), volume
   (persisted to `localStorage`), queue with "play next".
8. **Streaming endpoint** with HTTP Range support (seeking must work on any file size).
9. **Light + dark themes** — see §8.
10. **Keyboard shortcuts** — see §9.7.

### Out of scope

Everything in §1 "Non-goals", plus: true gapless playback, crossfade, transcoding
(server streams original files as-is), WAV/AIFF/Opus formats at MVP.

---

## 5. Data model

SQLite, WAL mode enabled on connect. `path` is the source of truth mapping a row to a file.

```sql
CREATE TABLE tracks (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,          -- path relative to library root
  title       TEXT NOT NULL,                 -- tag edit lives here (overlay over tag data)
  artist_id   INTEGER REFERENCES artists(id),
  album_id    INTEGER REFERENCES albums(id),
  album_artist_id INTEGER REFERENCES artists(id),
  track_no    INTEGER,
  disc_no     INTEGER,
  year        INTEGER,
  duration    REAL NOT NULL,                 -- seconds
  format      TEXT NOT NULL,                 -- 'mp3' | 'flac' | 'm4a' | 'ogg'
  bitrate     INTEGER,
  sample_rate INTEGER,
  mtime       REAL NOT NULL,                 -- file mtime at last tag read
  artwork_id  INTEGER REFERENCES artwork(id),
  favorite    INTEGER NOT NULL DEFAULT 0,
  added_at    TEXT NOT NULL
);

CREATE TABLE artists (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE albums (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  artist_id  INTEGER REFERENCES artists(id),
  year       INTEGER,
  artwork_id INTEGER REFERENCES artwork(id)   -- deduped: cover of first track seen
);

CREATE TABLE playlists (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  sort        TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position)
);

CREATE TABLE artwork (
  id   INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,   -- sha1 of image bytes; dedupes covers across tracks
  blob BLOB NOT NULL,
  mime TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- library path, scan state, schema bookkeeping
```

**Critical semantics — user edits survive rescans.** This is the subtle "Plex-like" behavior
and was agreed explicitly:

- `title`/artist/album on `tracks` are **overlays** over tag data.
- On rescan: if a file's `mtime` is **unchanged**, do not re-read tags — keep user edits.
- If `mtime` **changed** (file was actually re-tagged/replaced): re-read tags, then **re-apply
  the user's overlay** where the user had made one. (Track which fields were user-edited —
  either via a `user_edited` bitmask column or by storing originals; implementer's choice,
  document it in code.)
- Removed files: delete rows (and their playlist positions) — with a grace mechanism is fine
  but not required at MVP; simple deletion is acceptable and documented behavior.

---

## 6. Backend API (contract)

All under `/api`. OpenAPI docs at `/api/docs`. TS client for the frontend is **generated from
the OpenAPI schema** (this is how we keep type safety with a Python backend — do not hand-write
types).

```
GET    /api/health                     → liveness (used by Docker HEALTHCHECK)
GET    /api/scan                       → SSE: scan progress events
POST   /api/scan                       → trigger manual rescan
GET    /api/tracks                     → list (filter/sort/paginate; supports ?q= search)
GET    /api/tracks/{id}
PATCH  /api/tracks/{id}                → edit title/artist/album/track_no/favorite
GET    /api/albums                     → list
GET    /api/albums/{id}                → album detail + its tracks
GET    /api/artists
GET    /api/artists/{id}
GET    /api/playlists
GET    /api/playlists/{id}             → playlist detail + ordered tracks
POST   /api/playlists
PATCH  /api/playlists/{id}             → rename, edit description
DELETE /api/playlists/{id}
POST   /api/playlists/{id}/tracks      → add track(s)
DELETE /api/playlists/{id}/tracks/{trackId}
PUT    /api/playlists/{id}/order       → full reorder (array of track ids → positions)
GET    /api/search?q=                  → cross-entity search (tracks, albums, artists, playlists)
GET    /api/stream/{trackId}           → audio with Range support (nginx may serve directly; if
                                          proxied to FastAPI, implement Range manually — no
                                          silent 200-with-full-body responses)
GET    /api/artwork/{artworkId}        → cached, aggressively Cache-Control'd (immutable)
GET    /api/settings                   → library path, scan state, counts
```

Design notes:
- `GET /api/stream/{trackId}` must answer `206 Partial Content` with correct
  `Content-Range`; verify seeking in the browser during the playback milestone.
- Scan runs in a background thread; publish progress over the SSE endpoint; reflect state in
  `settings` so a page reload can show current scan status.
- All list endpoints should be built with large libraries in mind from day one (keyset or
  simple LIMIT/OFFSET pagination + sort params). Frontend virtualizes long lists (§9).

---

## 7. Repo layout

```
/
├── docs/
│   └── DESIGN.md            ← this file
├── backend/
│   ├── app/
│   │   ├── main.py          ← FastAPI app factory, static serving in prod
│   │   ├── db.py            ← connection, WAL, migrations (user_version)
│   │   ├── migrations/      ← 001_init.sql, …
│   │   ├── scanner.py       ← walk, mutagen parsing, overlay logic
│   │   ├── watcher.py       ← watchdog events → targeted reindex
│   │   ├── routers/         ← tracks, albums, artists, playlists, search, stream, scan
│   │   └── schemas.py       ← pydantic models (OpenAPI → TS client)
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── api/             ← generated client + thin wrappers
│   │   ├── stores/          ← zustand: player, queue, ui
│   │   ├── components/      ← player bar, sidebar, track table, get-info panel, …
│   │   ├── views/           ← Home, Albums, Artists, Tracks, Playlists, Search, Settings
│   │   └── styles/          ← tokens.css, base.css, components/
│   ├── index.html
│   └── vite.config.ts
├── nginx/
│   └── default.conf
├── Dockerfile
├── docker-compose.yml
└── README.md
```

Dev mode: `uvicorn --reload` + `vite dev` with proxy (hot reload both ends). Docker dev
fallback (mount-over-image trick) may be documented in README but is not the primary DX.

---

## 8. Design system — the "Apple-like" rules

This is the **top priority** of the project. These rules are the product.

### 8.0 The quality bar — standing constraint for every session

"Apple-level quality" is not a phase or a styling pass; it is the acceptance criterion for
every change, applied in every fresh session without the user repeating it:

1. **Finish means finished.** A feature ships with all of its states designed — hover,
   focus-visible, active, disabled, loading, empty, error — not a happy path with gaps.
2. **Edge cases are designed, not just handled.** Queue end, empty library, 10k rows, long
   titles, missing artwork: each gets a decision, even when the decision is restraint.
3. **Restraint by default.** Every element earns its place; when in doubt, remove. One
   accent; motion only where it communicates (visual rules 1 and 4, below).
4. **Consistency beats invention.** Reuse existing patterns and tokens (`tokens.css` is the
   single source). Invent only when no pattern fits, and record the pattern in this document
   when it generalizes.
5. **Invisible details are still details.** Keyboard access, a11y semantics, both themes,
   reduced motion, tabular numerals, focus rings, text truncation.
6. **Verify in the running app before calling it done.** Click through the real flow, check
   light and dark, confirm the build is green. Screenshots over assumptions.

The visual rules, agreed with the owner:

1. **Artwork is the only color.** All chrome (sidebars, tables, controls) is near-monochrome
   greys; exactly **one accent color**. No gradients on UI surfaces. No pastel cards.
2. **Typography carries the design.** Tight SF-style type scale with clear hierarchy
   (large titles, secondary metadata in smaller size/reduced contrast). Consider
   `-apple-system`/system font stack; no decorative fonts.
3. **Disciplined density + whitespace.** Dense-but-comfortable tables (like macOS Music app),
   generous whitespace in hero moments. No wall of rounded cards.
4. **Motion only where it communicates**: play state changes, view transitions, queue drawer.
   Subtle and short (150–250ms ease-out). No springy/floaty decoration.
5. **Translucent player bar** (backdrop-blur) over content. Now Playing uses blurred-artwork
   ambient background.
6. **Light + dark themes**: one token system (`tokens.css` custom properties), not two
   stylesheets. Default follows `prefers-color-scheme`; manual override persisted to
   `localStorage`. Dark mode gets its own tuned grey ramp — **not** an inversion of light.
7. **Hover-revealed actions**: play/queue/more appear on row hover. No permanent
   action-button clutter.
8. **Empty states matter**: "Your library is empty — here's how to point Flow at your music
   folder" must look designed, not like a broken list.

---

## 9. UI structure

### 9.1 App shell
- **Left sidebar** (icon + label, collapsible): Home, Albums, Artists, Tracks, Playlists,
  Settings. A library-status indicator lives here ("Scanning 34/1204…" while active).
- **Top bar** (persistent): the search field — the single search input in the app. Typing
  navigates to `/search?q=…` (debounced ~200 ms); `Cmd/Ctrl+F` focuses it from anywhere.
- **Main canvas**: content per view.
- **Bottom player bar** (persistent, translucent): artwork thumb, title/artist, transport
  controls, scrubber with buffered-range indication, volume slider (persisted).

### 9.2 Views
- **Home**: recently added albums, quick access to playlists, continue listening. Calm, not
  a dashboard of widgets.
- **Albums / Artists**: cover grids (hover → play button overlay).
- **Tracks**: virtualized table — title, artist, album, duration, favorite heart. At 10k+
  tracks this must stay smooth (windowing, e.g. `@tanstack/react-virtual`).
- **Playlists**: list + detail view with drag-to-reorder, remove tracks.
- **Search**: results grouped by entity type. The field lives in the top bar (§9.1);
  this view is the results page for `/search?q=…`.
- **Now Playing**: full-screen takeover — large art, blurred-art ambient background, queue
  drawer on the right. `Esc` closes. (This is the strongest idea from the reference images.)

### 9.3 Editing UX (the Apple way)
- Double-click a track title to rename inline.
- Right-side **"Get Info" panel** for full edits — not stacked modal dialogs.
- Playlist reorder via drag & drop; queue supports "play next" from any context menu.

### 9.4 Player behavior
- Native `HTMLAudioElement`; no server-side transcode.
- Shuffle, repeat off/all/one; queue manipulation (play next, remove from queue,
  click-to-jump from the drawer — §17.7).
- Volume persisted to `localStorage`.
- Continue playing through view changes (SPA — player state lives in a Zustand store outside
  the view lifecycle).

### 9.5 Keyboard shortcuts (big part of the "Apple feel" — cheap and required)
- `Space` play/pause · `←/→` seek ±10s · `↑/↓` volume
- `Cmd/Ctrl+F` focus search · `Esc` close Now Playing / panels
- Document them in Settings.

### 9.6 Scan UX (Plex-like, not a settings afterthought)
- First run with empty library → designed empty state with instructions.
- During scan: status indicator in sidebar + progress on Home/Settings ("Scanning… 342/1,204").
- SSE-driven; page reload shows current state from `settings`.

---

## 10. Docker / deployment (decided, with pitfalls already worked through)

**Single container, single port (8080), three-stage build:**

```
Stage 1  node:22-alpine        → npm ci && vite build (frontend dist)
Stage 2  python:3.13-slim      → pip install backend deps + cleanup pass
                                  (strip tests/, *.pyc, strip *.so — trick borrowed from
                                   github.com/polius/Wally)
Stage 3  python:3.13-slim      → runtime: uvicorn app + built frontend + nginx
```

**Non-negotiable runtime requirements** (these fix real bugs found when reviewing Wally's
Dockerfile — do not regress them):

1. **`tini` as ENTRYPOINT** (or docker `--init`), with a start script using `wait -n` so the
   container exits when *either* uvicorn or nginx dies. The Wally anti-pattern
   `sh -c "uvicorn … & nginx …"` as CMD must **not** be copied: `sh` as PID 1 doesn't forward
   SIGTERM (every `docker stop` hard-kills mid-scan), and if uvicorn crashes the container
   keeps serving nginx with a dead API.
2. **`HEALTHCHECK`** hitting `/api/health`.
3. **Run as non-root user.**
4. **Alpine/musl was considered and is viable** (our deps are pure Python) but Debian-slim
   was chosen for predictability at ~40MB extra cost. Owner OK'd this.
5. Nginx: serves frontend + `/api` proxy, handles `sendfile`/Range for audio streaming,
   gzips static assets, long-cache artwork (`immutable`).

**`docker-compose.yml`:** mounts `./music:/music` (configurable), named volume for the SQLite
file, `restart: unless-stopped`, healthcheck, port 8080.

**Sizing expectation:** ~150–200MB final image. "Lightweight" is a stated product goal —
keep it honest.

---

## 11. Milestones (build in this order; each ends with something verifiable)

1. **Skeleton** — repo structure, migrations, FastAPI base, Dockerfile + compose, empty React
   shell served through nginx.
   ✅ *`docker compose up` serves a real (if empty) app; `/api/health` green.*
2. **Scanner** — folder walk, mutagen parsing, artwork extraction + dedup, rescan-safe
   overlay upserts, scan API + SSE progress, watchdog watcher.
   ✅ *Point at a real folder; library populates and survives a rescan with edits intact.*
3. **Library UI + playback** — Albums/Artists/Tracks views, streaming endpoint with Range
   verified in-browser, working bottom player bar.
   ✅ *Can browse and play music end-to-end.*
4. **Playlists + editing** — playlist CRUD, drag-reorder, Get Info panel, inline rename,
   favorites, search.
5. **Now Playing + polish** — full-screen player, queue drawer, keyboard shortcuts, empty/
   loading states, motion pass, theme toggle completion.
6. **Hardening** — virtualized lists at 10k+ tracks, edge-case tags/corrupt files (skip +
   log, never crash the scan), README, final image size check.

**Start implementation at Milestone 1.** Do not jump ahead to build UI before the scanner
contract exists, and do not polish before functionality is verified.

---

## 12. Guardrails for the implementing session

- This doc is the contract. If you believe a decision is wrong, **ask the user first**.
- Never write to the music folder. Ever.
- No auth scaffolding, no uploads, no ratings/play-counts/charts (§1, §2).
- No decorative UI chrome: no pastel gradient cards, no fake data, no equalizer dots (§2, §8).
- The owner's priorities, in order: **UI/UX first**, simplicity, lightweight footprint.
- Keep diffs and scope tight to the current milestone; commit at meaningful checkpoints.

---

## 13. Addendum — recorded decisions from implementation review (2026-09-28)

Settled with the owner immediately before Milestone 1. Same contract status as the rest of
this document.

1. **Streaming:** `/api/stream` resolves the track in FastAPI and answers with an
   `X-Accel-Redirect`; nginx serves the bytes from an `internal` location (alias to the
   library root) with native sendfile/Range. Dev (no nginx) uses a FastAPI Range-streaming
   fallback behind the Vite proxy. Redirect paths must be URL-encoded.
2. **Track-edit semantics:** per-track find-or-create. Editing artist/album re-groups that
   track only; empty albums/artists are pruned. No "apply to album" affordance at MVP.
3. **Artwork:** embedded art first; fallback to `cover.jpg` / `folder.jpg` / `front.png` in
   the track's directory when a track has none. Artwork blobs stored as original bytes —
   no re-encode, no Pillow.
4. **Router:** react-router v7. Zustand / TanStack Query roles unchanged.
5. **Network:** container binds `0.0.0.0:8080` — LAN access intended; the no-auth trade-off
   is accepted.
6. **Watcher:** `PollingObserver` inside Docker (inotify does not propagate through bind
   mounts, especially from macOS hosts). Manual rescan always available. Auto-watch itself
   is not in question — only the observer backend.
7. **Move preservation:** moved files keep their `mtime`; the scanner matches same
   size+mtime+duration at a new path and updates `path` in place so user edits survive.
   A move must never look like delete+add.
8. **Generated TS client:** `openapi-typescript` + `openapi-fetch`. uvicorn runs a single
   worker (SSE and scanner-thread assumptions depend on it).
9. **"Continue listening"** (Home) = last track + position + queue restored from
   `localStorage`. No server-side play statistics (respects §1).
10. **Playlist cards** render a 2×2 mosaic of their tracks' artwork (monochrome placeholder
    when empty). No synthetic playlist colors; no greeting/identity UI anywhere.
11. **Media Session API** integration approved as an M5 nicety (OS media keys, lock screen).

Design-language additions carried over from the reference images (§2):
- **Keep:** the "current track as dark pill" row treatment in track lists — monochrome
  inversion, no accent color.
- **Keep:** blurred-artwork ambience on the album detail view, not only Now Playing — same
  token system, same restraint.

## 14. Addendum — decisions recorded during Milestone 2 (2026-09-29)

1. **Broken-mount guard (refines §5 "simple deletion is acceptable"):** when a scan's walk
   finds 0 files while the index holds tracks, removals are skipped and the scan is marked
   with an error. A wrong/missing bind mount must never mass-delete the library.
   Deliberately emptying the library is done by resetting the data volume, not by emptying
   the folder. Verified against a real container.
2. **Watcher strategy (refines §7 "targeted reindex"):** debounced watch events trigger a
   full *reconcile* scan instead of a strictly targeted reindex. At the target scale
   (10k files) an mtime-skip reconcile is fast, and it guarantees one code path for overlay,
   move, and removal semantics — no divergence between manual and watch scans.
3. **Startup auto-scan:** on boot, an empty index next to a non-empty library folder
   triggers a scan automatically (first-run UX, Plex-like). Later restarts rely on the
   watcher; the Rescan button in Settings always remains available.

## 15. Addendum — decisions recorded during Milestone 4 (2026-09-29)

1. **Inline rename vs §9.3 "double-click":** row double-click is play/pause, so the
   title text itself is **click-to-edit** (a focused click on the words — not the row).
   Enter commits, Esc cancels; in multiline fields (playlist description) Shift+Enter
   inserts a newline. Empty/unchanged commits are no-ops. Settled — the single-click
   target is deliberate, not a deviation to fix.
2. **PATCH /api/tracks/{id} field semantics:** a field absent from the JSON body never
   touches the column; an explicit `null` clears it (track number); `0` normalizes to
   null; empty artist/album strings clear the reference. `favorite` is a plain flag
   outside the `user_edited` overlay — rescans never touch it (§5).
3. **Playlist reorder:** the PUT is a full-replace with a multiset match (duplicate
   entries of one track are legal). The client applies the move optimistically; the
   server response is the source of truth. Removals recompact positions.
4. **Playlist mosaics (§13.10):** first four tracks' artwork ids in playlist order.
   Because artwork dedups by sha1 (§5), tracks sharing a cover collapse to one tile —
   correct behavior, not a bug.
5. **Search (§9.2):** the top bar's field is the single search input. The query lives in
   the URL (`/search?q=…`), debounced ~200 ms, and typing from any view navigates to the
   search route. ⌘F/Ctrl+F focuses the top-bar field (route-based results, no overlay).
   Group results are capped (20/group); "Show all" links into the filtered
   list views (`/tracks?q=…`), which all support `?q=`.
6. **Context menus are drill-down** ("Add to Playlist…" swaps content in place) —
   no nested hover menus, per §8.7's restraint.
7. **What M5 inherits:** Esc already closes menus/Get Info/inline edits (local
   handlers); global shortcuts (Space, arrows) do **not** exist yet. Volume is
   persisted; there is **no manual theme override yet** (tokens respond only to
   `prefers-color-scheme`). Now Playing full-screen and the queue drawer are not
   started. Media Session API remains an approved M5 nicety (§13.11).

### Dev environment notes (browser verification recipe)

- Local `./music` is empty; the Docker container on :8080 holds a stale 4-track
  library from a removed mount. Don't trust it for visual work — run dev mode.
- Dev: `uvicorn app.main:app --port 8000` from `backend/` with
  `FLOW_MUSIC_DIR` / `FLOW_DATA_DIR` pointed at scratch dirs, plus `npm run dev`
  from `frontend/`. Ports 5173/5174 are typically occupied by other projects —
  Vite auto-increments (5175). Kill stale uvicorns on :8000 from old sessions.
- A scratch library can be generated from `backend/tests/audio_fixtures.py`
  (add a real-PNG cover generator — fixture art bytes don't render in `<img>`).
  The scanner auto-scans on boot (§14.3), so no manual trigger is needed.
- Artwork responses are `Cache-Control: immutable` (§6). When a dev session
  reuses a port with a **different data dir**, artwork ids recur with different
  bytes and the browser serves stale images from its disk cache — hard-reload
  or verify in a fresh browser context. Not a bug: ids are stable within one
  library, which is the production case.

## 16. Addendum — decisions recorded during Milestone 5 (2026-09-29)

1. **Ambience shipped here (completes §13):** the blurred-artwork ambience on
   album detail was agreed in §13 but had not actually been implemented; M5
   introduced one shared `Ambience` component + `--ambience-*` tokens used by
   both album detail and Now Playing. No artwork → no ambience (monochrome,
   §8.1). The dissolve before the track list is a CSS **mask on the artwork
   layer**, not painted chrome — §8's "no gradients" governs UI surfaces, and
   the wash itself is artwork-derived color.
2. **`playNext` insert semantics (fix):** the M3 implementation rebuilt the
   whole order (reshuffling it when shuffle was on), so a "Play Next" track was
   not guaranteed to play next. It now inserts into the existing order right
   after the current position; duplicates remain legal (§14-adjacent multiset
   reasoning), and the rest of a shuffled order is preserved.
3. **Shortcut guard:** Space/arrows yield whenever focus sits in an
   interactive control — `input`, `textarea`, `select`, `button`, `a`,
   `contenteditable` (which covers inline rename, §15.1) — so native
   activation (Space on a focused button, arrows on a slider) is preserved and
   nothing double-fires. Volume steps are 5%; seek is ±10s (§9.5).
4. **Esc precedence:** context menus → Get Info → Now Playing. Now Playing
   listens in the capture phase and defers when `contextMenuOpen` or
   `getInfoTrackId` is set in the ui store; while an inline edit is focused,
   the shortcut guard defers everything. Local Esc handlers (§15.7) are
   untouched.
5. **Theme mechanics (§8.6):** the resolved theme is always written to
   `data-theme` on `<html>` (`light`/`dark`); `tokens.css`'s dark block is now
   attribute-driven — **same tuned values, unchanged**. The ui store persists
   `themeMode` (`system|light|dark`) in the `flow.ui` localStorage entry, and
   `index.html` carries a matching boot snippet so the first paint already has
   the right ramp.
6. **Loading states:** a shared `LoadingState` skeleton (quiet inset blocks,
   slow opacity pulse) renders while server state is in flight — a loading
   list must never read as "empty library", and the empty state no longer
   flashes on Home/lists. The pulse stops under `prefers-reduced-motion`,
   which also disables all transitions/animations (§8.4).
7. **Media Session (§13.11):** metadata (title/artist/album/artwork),
   play/pause/previous/next action handlers, and `playbackState` updates. No
   position state — not in the approved scope.
8. **Now Playing shape:** a takeover overlay mounted in the app shell (like
   Get Info), not a route — playback lives outside the view lifecycle anyway.
   Entry point: the player-bar artwork thumb. The queue drawer hides below
   940px. Queue rows are not click-to-jump — queue manipulation is play-next
   and remove (§9.4), nothing more. (Superseded by §17.7: the full-list queue
   made the rows click-to-jump.)

## 17. Addendum — decisions recorded during Milestone 6 (2026-09-29)

1. **Virtualization shipped here (completes §9.2):** the Tracks view windows
   rows with `@tanstack/react-virtual` and feeds them from an infinite query
   (pages of 1,000 behind the window) — the M3 first-1000 cap and its
   truncation notice are gone; the promise came due and was paid. The queue
   drawer windows too: a full-library queue holds ~10k rows and previously
   rendered every one of them, images included. Album/artist/playlist detail
   tables stay plain on purpose: their endpoints return unpaginated payloads
   at curated scale, and windowing drag-to-reorder adds risk for no real
   case. Row markup lives in one shared `TrackRow` so both paths render
   identically.
2. **Shell scroller fact (layout contract):** the app's scroll element is
   the WINDOW — the shell grid row grows with content and `.shell__canvas`
   never scrolls internally. The Tracks windowing is built on
   `useWindowVirtualizer` for this reason; anyone who later makes the canvas
   the scroller must revisit this.
3. **Corrupt files (§11.6):** `parse_audio` guards its entire body (mutagen
   can raise while decoding malformed frames, not only while opening), and
   duration/bitrate are coerced finite so NaN can't reach the NOT NULL
   column. `tests/test_corrupt_files.py` pins: zero-byte/truncated/garbage
   and wrong-extension files, unreadable files and unreadable sidecar
   covers, broken symlinks, garbage tags (NULs, emoji/CJK, non-numeric
   frames, 100KB titles) — skip + log, errors counted, scan stays idle, and
   the §14.1 mount guard stays silent around bad files.
4. **Base image switch (supersedes §10.4):** the owner directed Alpine. The
   slim-based image measured 235MB (slim base alone ~202MB by
   `docker image ls`) against the §10 ~150–200MB budget; the original
   "~40MB premium" estimate was off by ~135MB. Alpine lands at ~99MB. All
   runtime deps ship musl wheels (pydantic-core included), so no compiler;
   `bash` stays in the runtime for the §10.1 start script's `wait -n`.
5. **Final image size:** ~99MB (`docker image ls`), ~23MB compressed
   (`docker save`); pip removed from the runtime venv. The budget is met
   with margin — no further shaving attempted.
6. **Dev library generator (§15 note satisfied):**
   `backend/scripts/dev_library.py` generates a ~10k-track scratch library
   with real renderable PNG covers (stdlib zlib/struct), committed as a dev
   utility.
7. **Full-list queue (§9.2, §9.4):** the drawer's "Now playing"/"Up next"
   split dropped each track from view the moment it finished — the list kept
   shrinking while the user watched it, with no sense of the whole. The
   drawer now renders the entire queue as one continuous list in play order
   (the store's `order` remains the truth): played rows stay in place,
   dimmed to half strength; the playing row carries the drawer's single
   accent moment — three pulsing accent bars over a scrimmed artwork,
   frozen while paused, static under `prefers-reduced-motion`; the head
   shows position ("12 of 48") instead of a shrinking "up next" count.
   Rows are click-to-jump, backwards included (supersedes §16.8): any row
   starts playback from there via `playAt(orderIndex)`; the playing row
   toggles playback; hovering it swaps the bars for a play/pause glyph,
   the same reveal grammar as the library rows (§8.7). Remove stays
   hover-revealed on non-playing rows. The drawer centers on the playing
   row when opened (or when the queue is replaced) and follows it only
   when it scrolls out of view — never yanking the list mid-read.

## 18. Addendum — shell change: sidebar retired (2026-09-30)

Owner decision: with a fixed, small set of sections (Home, Albums, Artists,
Tracks, Playlists, Settings) a left sidebar spends permanent horizontal space
on wayfinding that six icons can carry. **Supersedes §9.1's sidebar:**

1. **Top bar** now carries all chrome in one full-width row: brand (left),
   the global scan-status pill (inheriting the sidebar's §9.6 role, next to
   the brand), the search field (centered in the free space, still the single
   search input, §15.5), and the section nav (right) — icon-only NavLinks
   with `aria-label` + tooltip, a hairline group break before Settings, and
   the established active-nav language: accent icon on a quiet `--bg-active`
   pill (§8.1 — the accent's one chrome appearance).
2. **The collapse state is gone** (`sidebarCollapsed` removed from the ui
   store; `Sidebar.tsx` / `sidebar.css` / `IconPanel` / `--sidebar-width*` /
   `--bg-sidebar` all removed).
3. **The canvas takes the whole window**: the `.view` 1480px max-width cap is
   removed — grids and tables expand with the window, which was the point of
   the change. The album-detail ambience anchors to the view's edges (now the
   canvas edges), so its dissolves remain correct.
4. Narrow windows shed gracefully: the brand wordmark hides below 760px, the
   scan pill collapses to its spinner below 640px; the nav is never hidden.
   (Superseded below 640px by §19: on phones the nav collapses into an
   overflow sheet.)
5. **Follow-up (same day):** Home was removed from the nav — the brand
   lockup is the home affordance. It was upgraded to carry that role
   properly: a 32px toolbar target with hover/press fills (the nav items'
   grammar), a larger 28px mark that inverts with the theme, a "Home"
   tooltip, and a dedicated `--text-brand` wordmark size (16px, one step
   above body copy). `IconHome` left the icon set with it.

## 19. Addendum — top bar nav on phones (2026-09-30)

Owner decision: below the 640px phone breakpoint, the icon-only section nav
is replaced by a single overflow button — six 32px targets plus separator
leave the search field ~140px at iPhone widths and the row would truncate.
Supersedes §18.4's "the nav is never hidden" below 640px; desktop is
untouched.

1. **The button** reuses the nav items' 32px toolbar grammar with a
   hamburger glyph (new `IconMenu`), swapping to ✕ while open. It carries
   `aria-haspopup="menu"`, `aria-expanded`, and `aria-controls`.
2. **The sheet** is a small pull-down panel anchored to the bar's right
   edge, using the context menu's surface language (§15.6): elevated panel,
   hairline border, `--radius-m`, 150ms scale-in from the button with
   transform-origin top right (§8.4 — motion that communicates where it
   came from). Rows are icon + label at 40px height — a touch target, not
   the desktop's 32px hover row.
3. **Active state** is the established active-nav language, unchanged:
   accent icon on a quiet `--bg-active` pill (§8.1, §18.1). A hairline
   separator keeps Settings grouped off, mirroring the desktop break.
4. **Closing:** item activation, outside pointerdown (the button itself is
   exempt so its toggle can't double-fire), Esc, route change, or crossing
   back to desktop (matchMedia — plus a CSS guard so it can never paint
   there). While open it registers as a context menu in the ui store, so
   Esc precedence (§15.7, §16.4) and the shortcut guard (§16.3) treat it
   like any menu.
5. **Breakpoint rationale:** 640px is the bar's established phone
   breakpoint, and it is honest here: above it the icon row never truncates
   (measured floor ~473px), below it the menu-button layout fits down to
   320px (~300px floor).

## 20. Addendum — phone mini player bar (2026-09-30)

Owner decision: below the 640px phone breakpoint the player bar becomes the
iOS mini-player — the desktop 3-column grid (meta · transport+scrubber ·
volume) has a ~642px floor and overlapped at phone widths. Desktop is
untouched; the breakpoint matches the top bar's (§19).

1. **One row, 62px:** artwork · title/artist · prev/play/next. The
   `--player-height` token drops to 62px on phones, so the canvas padding
   and any other consumer follows the bar automatically.
2. **The scrubber is the bar's top edge** — a full-width hairline
   straddling the border-top, Apple Music mini-player style. The seek hit
   box is 24px tall; the visible track is a 3px background-image layer
   centered in it (the Scrubber's fill moved to the background-image
   longhand so CSS can size the layer independently of the hit box; the
   override out-specifies the base `.range` rule so it never depends on
   CSS import order). Time labels are hidden — they live in Now Playing.
3. **Shed, not lost:** shuffle, repeat, and volume leave the mini bar (a
   `secondary` flag marks the mode switches); all three remain first-class
   in Now Playing, which the artwork thumb opens (§9.2, §16.8). Volume on
   a phone is hardware keys.
4. **Touch targets:** transport buttons get real 36/38px boxes on phones
   (the icons alone are ~17px).
5. The row carries a 4px top inset so the seek box pinned above it never
   collides with the artwork's tap target.

## 21. Addendum — phone sweep of the whole app (2026-09-30)

Follow-up to §19/§20: with the top bar and player bar phone-ready, the rest
of the app was reviewed at 375×812 (and 320×568 worst case) in both themes.
Findings and fixes — all ≤640px unless noted; desktop is untouched:

1. **View insets:** 40px side padding is desktop chrome — 16px on phones
   (24px top). The ambient banner offsets by the same padding so it stays
   anchored to the canvas edges.
2. **Cover grids** (Albums, Artists, Home, Search): 2-up on phones like iOS
   Music. A `minmax(132px, 1fr)` floor keeps two columns down to 320px;
   3-up from ~500px; desktop's 168px floor resumes above the breakpoint.
3. **Detail headers** (album, playlist): the side-by-side header squeezed
   its text column to ~100px, wrapping the meta line over six lines. They
   stack on phones — the fixed 220px artwork fits down to 320px.
4. **Track rows shed the artist/album columns** on phones: at 375px those
   columns truncated to one or two characters ("T.. A A"). The title
   carries the row, the grids are re-templated per variant, and the row
   still fits at 320px.
5. **Touch reachability (`@media (hover: none)`):** the hover-revealed
   grammar (§8.7) has no hover on touch, so the row's play glyph (in the
   number's slot), heart, ··· menu, playlist remove, album-card play, and
   the queue row's toggle + remove reveal for good. Desktop hover behavior
   is unchanged; quiet colors carry the hierarchy the reveal provided.
6. **Settings values** shrink (`min-width: 0`) and wrap with
   `overflow-wrap: anywhere` — a long library path wraps inside its card
   instead of bleeding past it.

Verified in the running app at 320/375/641/700/1200, light + dark: Home,
Albums, album detail, Artists, artist detail, Tracks, Search, Settings,
Now Playing (already phone-shaped), Get Info (`min(380px, 92vw)` fits),
the row context menu, the nav sheet (§19), and the mini player bar (§20).
Known scope note: playlist drag-to-reorder remains a pointer-first
interaction (§9.3); reorder on touch was not re-designed in this pass.

## 22. Addendum — Organize view: mass curation (2026-09-30)

Owner decision: a mass-editing surface over the library's SQLite metadata,
to reconcile what the scanner grouped literally after scans (suffix-variant
albums, loose tracks, typos). **Files stay read-only — this is curation of
overlays, not a tag editor.** §1's non-goal is untouched; every edit lands
through the same overlay path as Get Info (§15.2) and survives rescans.

1. **Placement & name:** new nav section "Organize" (`/organize`, §18
   grammar — one more 32px icon target; the §19 phone sheet inherits the
   entry). Not a mode over Tracks: the view has its own information
   architecture (review strip, filter, bulk bar).
2. **Fields:** Title, Artist, Album, Track № — exactly the overlay fields
   (`Edited` bits). **Album Artist is intentionally absent**: it follows
   tags on rescan (§13.2); letting users edit it would need a new overlay
   bit and scanner semantics. The mixed-album-artist review item surfaces
   the cases where that future extension would help.
3. **Shared apply path:** PATCH /api/tracks/{id} and the bulk endpoints all
   resolve fields through `app.apply.apply_field_changes` — one
   implementation, so the editors cannot diverge (the `entities.py`
   philosophy). Wire semantics per §15.2 (absent = untouched; explicit null
   clears the number; empty artist/album strings clear the reference; 0 →
   null; empty title rejected).
4. **`POST /api/tracks/bulk`:** one transaction, all-or-nothing (a 422
   among 10k rows writes nothing). Selection is explicit `track_ids` or the
   GET /api/tracks filter contract minus pagination (`q`, `artist_id`,
   `album_id`, `review`) minus `except_ids` — a filter-wide apply touches
   exactly what the grid showed. `favorite` is not a bulk field.
5. **Review filters** (whitelisted `review=` param, also on GET
   /api/tracks): `no_album`, `single_track_albums`, `mixed_album_artist`,
   `missing_track_no` — deterministic SQL only, no fuzzy matching. Mixed
   state arises when an album overlay pins tracks to one album row while a
   re-tagged file re-derives album artist on rescan (grouping keys on
   title + album artist). `suffix_collisions` normalizes titles (strip
   bracketed variant segments, punctuation, case) and only flags groups
   where members share an artist — same-titled albums by different artists
   are legitimate.
6. **Undo (one generation, server-side):** the last bulk apply stores each
   touched track's previous values in `settings` (`bulk_undo`, names for
   artist/album — an emptied entity's row is pruned and find-or-create
   recreates it on undo). `POST /api/tracks/bulk/undo` re-applies them
   through the shared path and re-sets the overlay bits (the restored
   value is one the user chose). Undo consumes the slot; no redo.
   `undo_available` rides on GET /api/review/summary. ⌘Z in the view and
   the header's "Undo last apply" both hit it.
7. **Grid grammar:** no playback here (rows organize; playback lives in
   Tracks/Albums/Now Playing) — row click toggles selection, cells
   click-to-edit (§15.1), Enter commits in place (the plan's "moves down"
   is dropped: the next row may not be mounted in a virtualized window),
   Tab crosses cells, Esc cancels. Checkbox column: click toggles,
   Shift-click ranges over the loaded rows, ⌘A selects all matching
   (server-side via the filter contract), the header checkbox is
   tri-state. Keyboard cursor: arrows/PageUp/PageDown/Home/End move,
   Space toggles, Enter edits the title.
8. **Confirm sheet:** every bulk apply confirms (the app's only
   mass-mutation moment). The consequence line is exactly honest: album
   removal is computable (albums prune when their last track moves);
   artists are claimed only as "left with no tracks" — they can survive
   via album references (§13.2), and per-track album-artist data isn't in
   the payload. Filter-wide selections get the generic line.
9. **Phones (§21/§22):** the grid re-templates to art + title/meta, cells
   are not editable, selection/bulk are unavailable, and a tap opens Get
   Info — the designed refusal; mass editing needs a wider screen. The
   review strip and filter stay usable.
10. **`sort=curate`:** album blocks contiguous (title, then album artist —
    two artists may each own "Album 01", §13.2), track order within, loose
    tracks last. `TRACK_SELECT` gains the album-artist join (`aar`).
11. **Search nuance (§15.5):** the view's filter field is a table filter
    (like the Add Tracks picker's), scoped to the grid and carried in the
    URL — not a second global search.
12. **Scroller correction (revises §17.2):** since §18, `.shell__canvas`
    is the app's scroll container; a window virtualizer never sees its
    scroll. VirtualTrackTable was still window-virtualized against the
    window and rendered a frozen first window with blank space below it
    (a live §18 regression, caught while building the Organize grid); it
    now binds `useVirtualizer` to the canvas — the pattern the queue
    drawer already used. OrganizeGrid does the same.
13. **Divergences from the approved plan, recorded:** undo moved
    client-side → server-side (filter-wide applies touch tracks the
    client never loaded, so a client diff would lie); cell edits
    commit-per-cell instead of a draft buffer (Finder semantics; the
    buffer only paid off for undo, which the server now owns); suffix
    collisions got their own popover (group → album pills → filter) rather
    than a bare count.

## 23. Addendum — Tracks/queue simplification (2026-09-30)

Owner decision set: Tracks becomes a pure listening surface; the per-row
"···" menu is removed outright; editing centralizes in Organize; the queue
panel becomes where a queue is built. Supersedes parts of §9.3, §15.1,
§16.8, §21.5, and §22.1 as noted.

1. **Rows are playback-only (supersedes §15.1):** clicking a row — the
   title included — plays that track. The old select-on-click /
   double-click-to-play / click-title-to-rename grammar is gone, as is the
   dead-end selection highlight. Activation is **idempotent**: clicking the
   current track's row does nothing, so a habitual double-click cannot
   flash play→pause; toggling stays with the play glyph, Space, and the
   player bar. Inline rename left the library rows — it lives in the
   Organize cells and Get Info. §9.3's "queue supports play next from any
   context menu" is superseded by §23.5.
2. **The "···" menu is gone** (component deleted). Row actions are now:
   play (row click / glyph), favorite (heart), playlist-remove (playlist
   variant only). The row context menu items were re-homed, not all kept:
   **Get Info** → Organize (§23.3); **Add to Playlist** → the playlist's
   own Add Tracks dialog — the ONE path for getting a track into a
   playlist is now "open the playlist → Add Tracks", a deliberate
   centralization the owner chose over a per-row affordance; **Play
   Next** → the queue panel's Add button (§23.5). No right-click menus
   were added (explicitly out of scope). §21.5's touch reveal loses its
   "···" item; heart/remove reveal on touch unchanged.
3. **Get Info is Organize-only.** Desktop: a hover-revealed ⓘ cell on each
   Organize row (§8.7 grammar; the grid gains a trailing 30px column).
   Phones: unchanged — a tap on the compact row opens it (§22.9). The
   panel itself is unchanged; it is the phone's only editing surface.
4. **Organize moved out of the nav (supersedes §22.1's placement):** the
   Tracks view header carries a right-aligned Organize pill button
   (`/organize` stays a real route; URL filters and deep links
   unaffected). The pill shows the "needs attention" count (sum of the
   review summary) — the task launches from where the mess is visible.
   Nothing needs attention → the pill is just "Organize".
5. **Queue building (supersedes the "Play Next" row action):** the queue
   panel header gains **Add**, opening the shared library picker in
   "Add to Queue" mode — `AddTracksDialog` is now one component with two
   targets (playlist / queue), search + multi-select shared. Added tracks
   **append to the end of the play order** (chosen over insert-after-
   current; click-to-jump already gives "play that one next" by
   composition). A new `addToQueue` store action does the append; no
   playback side effect.
6. **Idle Now Playing (two zones, always):** the takeover renders the
   stage + queue layout even with nothing playing — the stage shows a
   quiet idle block (placeholder tile, "Nothing Playing", hint) and the
   queue's empty state carries its own Add button. A queue can be built,
   then started by clicking a row (`playAt`). Store convention:
   `orderPos = -1` means "queue built, nothing loaded" —
   `useCurrentTrack` returns null, the queue head shows "N tracks"
   instead of a position, and no row renders as current. Playing anywhere
   in the library still replaces the queue, as before.
7. **Narrow windows (supersedes §16.8's hidden drawer):** below 940px the
   queue no longer disappears — it slides up over the stage as a sheet
   behind a queue button in the takeover's top-right corner (34px, the
   close button's grammar, mirrored side). The sheet's header gains a
   back chevron; Esc closes the sheet before the takeover. 150–250ms
   ease-out translateY, disabled by the global reduced-motion override.
   Below 640px (phones, §19/§20) this is THE queue surface — designed in
   this pass, not deferred. The Add Tracks dialog becomes a full-screen
   sheet on phones (it is now the only path into playlists).
8. **Nav order (§18 grammar):** Tracks, Albums, Artists, Playlists,
   separator, Settings — frequency-of-use order, owner's call. The phone
   nav sheet (§19) inherits it.
9. **Global shortcuts defer while the library picker is open** (`pickerOpen`
   in the ui store, checked by `useGlobalShortcuts` and Now Playing's Esc
   precedence, joining `contextMenuOpen`/`getInfoTrackId`).


