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
   pill (§8.1 — the accent's one chrome appearance). (The icon-only rule is
   superseded above 940px by §28: wide windows label the sections.)
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

## 24. Addendum — playing row: quiet highlight, not the dark pill (2026-10-01)

Owner decision: the full-inversion "dark pill" (§13's keep — near-black on
the light canvas, near-white in dark) was too much contrast for an airy UI.
Supersedes §13's "current track as dark pill" keep-note:

1. **The current row in every track list** (Tracks/album/artist/playlist
   variants, and the Organize grid) now uses the queue drawer's quiet
   grammar (§17.7): a soft `--bg-active` fill in both themes, text colors
   unchanged. One token, one look, both themes.
2. **The playing marker is the accent bars** (§17.7's `.eq`, moved to
   `controls.css` as shared grammar): they replace the row number in the
   index slot, frozen while paused; hover swaps them for the play/pause
   glyph — the same reveal grammar as every row (§8.7). On touch
   (`hover: none`) the glyph is always revealed, so the bars stay hidden
   there. Organize has no playback (§22.7): its playing row carries only
   the fill; selection shares it, the checkbox column disambiguates.
3. **All inversion-support rules removed**: the pill legibility overrides
   for heart/remove buttons, inline-edit inputs, the insertion line, and
   the Organize checkbox/ⓘ recolors — the quiet fill needs none of them.



## 25. Addendum — playlist removal: swipe to reveal, undo to recover (2026-10-01)

Owner request: the playlist row's remove button had no confirmation — one
accidental tap deleted a curated track — and no real touch story (the
§21.5 always-visible minus was noise; the row needed a gesture).

Decision: **no confirmation dialog.** Per-track removal is frequent and
low-stakes — the exact profile Apple's HIG resolves with recovery, not
friction. A dialog would tax every intended removal to guard the rare
accident. Three pieces instead:

1. **Undo toast (§25, both platforms):** removal acts at once, then a quiet
   pill above the player bar — `Removed "<title>"` + Undo — lives five
   seconds (`role="status"`, held while hovered/focused). One notice at a
   time: a new removal replaces it, so undo is single-generation, the same
   convention as Organize's bulk undo (§22.6). Undo = add the track back +
   `PUT /order`, inserting at the position snapshotted before removal
   **clamped into the list as it is when Undo is pressed** — so reorders
   made after the removal survive. A failed DELETE throws and skips the
   toast; the mutation's invalidate resyncs the optimistic row.
2. **Swipe left to reveal (§25, touch):** playlist rows drag horizontally
   to reveal an 84px accent Remove action behind the content — iOS Mail's
   partial-swipe grammar. **The gesture never deletes by itself:** release
   past half-reveal (or a leftward flick ≥0.4px/ms) snaps the action open;
   the tap on it commits. Rubber-banding resists 25% past both ends;
   `touch-action: pan-y` keeps vertical scrolling native; the swipe cancels
   the long-press menu and swallows its trailing click; the transform is
   written imperatively during the gesture (state only marks the phase
   edges). One row open at a time, per table; tapping a revealed row closes
   it without playing.
3. **Long-press menu gains "Remove from Playlist"** (danger item, last,
   playlist context only — the request carries the closure): the
   always-reachable path for touch, per §21.5's original reasoning.
   Right-click on desktop shows the same item.

Consequences: the inline minus is **desktop-only again** (the §21.5 touch
reveal is superseded) — on `hover: none` the slot and the head's column
fold away, and at phone widths the 30px goes to the title. The row markup
gains a `trackrowwrap` wrapper (presentation role, overflow clip) that
hosts the action behind the sliding content; non-playlist rows keep the
bare markup the virtual table positions.

## 26. Addendum — undo everywhere + drag polish (2026-10-01)

Follow-up to §25: the recovery grammar extends to the app's remaining
removals, and playlist drag-to-reorder sheds its browser-default look.

1. **Queue removal undo:** the ✕ button and the touch swipe-commit both
   route through one `removeWithUndo` — the toast's undo re-inserts the
   track at its former queue index and play-order slot (`restoreToQueue`
   in the player store), clamped into whatever the list looks like now.
   The playing row stays anchored (§9.4) and untouched.
2. **`removeFromQueue` pointer fix:** removing a row queued BEFORE the
   current one recompacted queue indexes but recomputed `orderPos` with
   the stale current index — `indexOf` missed, `orderPos` fell to -1, and
   the player forgot what was playing (next() restarted the current
   track). The current index now rides the recompact, as the undo path
   mirrors it.
3. **Favorite removal undo:** centralized in `useToggleFavorite` (the one
   choke point behind every row heart, the action menu, and Get Info) —
   un-favoriting shows the toast; favoriting is a gain and stays quiet.
   The undo rides the same toggle path (extracted `applyFavorite`), so
   the optimistic patch and the server call can't diverge.
4. **Toast copy now carries the surface:** `Removed "<title>" from the
   queue / from Favorites / from this playlist`.
5. **Playlist drag image (§26):** the browser's default drag ghost is a
   raw snapshot of the row — hover chrome, grid columns and all. It is
   replaced by a quiet pill (`buildDragChip`): grip glyph + title, the
   app's elevated chrome in both themes, photographed via setDragImage at
   dragstart and disposed at dragend (and on unmount).
6. **Drag feedback cleanup:** while a drag is live the dragged row reads
   as an empty slot — transparent background (no hover fill, no playing
   fill bleeding through), content dimmed to 0.4 — and hover fills on the
   rows beneath the pointer are suppressed (`tracktable--dragging`). The
   insertion line stays the single placement cue.
7. **Toast layer fix (§26):** the §25 toast sat with the player's layer —
   below drawers and modals — but the queue lives inside the Now Playing
   takeover (a fullscreen modal), so a queue removal fired a toast no one
   could see. The pill now floats at `modal + 5`: above the takeover,
   below only the drag ghost (`modal + 10`).

## 27. Addendum — playlist reorder adopts the queue's drag grammar (2026-10-01)

Owner report: dragging a track up or down in a playlist highlighted only a
2px border — "not professional at all." Correct verdict, and the fix isn't
polish on that grammar, it's replacement: the playlist now uses the §9.4
rev 2 press-and-drag grammar the queue already ships, per Apple HIG — a
dragged item lifts and the list parts to make room; a line is a diagram of
a placement, a gap IS the placement.

1. **Lift (mouse):** press-and-move past 5px lifts the row into a floating
   ghost — the row itself, cloned at lift, elevated (double soft shadow,
   hairline edge, 1.02 scale), locked to the list's left edge and clamped
   to the table's extent. The old static drag chip (§26.5) and its
   `setDragImage` plumbing are deleted: a floating row follows the pointer
   at 60fps; a photographed bitmap can't.
2. **The gap is the cue:** the grabbed row's origin reads as empty
   (`opacity: 0`) and its slot travels to the tentative position — rows
   between part by one row height (`translateY` on the wrapper, 150ms
   ease-out). The `dropbefore/dropafter` inset lines are gone. Hover fills
   and hit-testing are suppressed table-wide while a drag is live
   (`tracktable--dragging`), so nothing flickers under the ghost.
3. **Settle:** release flies the ghost the last few pixels onto the slot
   (200ms, shadow shrinking) while the optimistic reorder commits; Escape
   springs it home and commits nothing. Pointer capture on the table
   retargets the release, so a committed drag can't leave a click that
   plays the row.
4. **Auto-scroll:** dragging into a 56px band at the shell canvas's rim
   scrolls the view at a ramped speed — a 500-track playlist is reorderable
   end to end without leaving the list.
5. **Touch unchanged, deliberately:** rows keep §25's swipe-to-remove and
   long-press menu. A touch-lift timer would starve the menu (350ms lift
   vs 480ms menu), and Apple answers this exact conflict with Edit-mode
   grips the design doesn't have. If touch reorder arrives, it needs that
   grip — not a timer race.

## 28. Addendum — top bar nav: labels on wide windows, 44pt touch targets (2026-10-01)

Owner request: the top-right icons should carry their text on non-small
devices, icons alone when narrower, the phone overflow sheet when small —
to Apple's standards. The ladder was two-thirds built already: the phone
sheet is §19, the icon row is §18. This adds the top tier and repairs the
touch story under all of them.

1. **Labeled nav (≥ 940px):** each library section wears its text beside
   the icon — HIG: label a control when space allows. The label rides the
   item's color (secondary at rest, primary on hover, accent when active),
   so the active-nav language (§8.1) extends to the text with no new
   states. The breakpoint is measured, not chosen: the labeled row is
   524px, brand 93px, bar chrome 72px, so the floor is 929px — the
   narrowest window where the search field still sits at its natural 240px
   flex basis. 940 gives 11px of slack and aligns with the queue-sheet
   boundary (§23.7): below it the search would be the first thing
   squeezed, and it never is. Measured at 940: search 251px, zero
   overflow; at 939 the icon row returns and the search gets 557px. During
   a scan the pill (§9.6) sheds its text first, so the labeled row itself
   never shrinks.
2. **Settings stays icon-only at every tier**, after the hairline break:
   a utility, not a section — the macOS toolbar-item-group grammar §18
   adopted. Its 32px geometry is untouched by the labels; only sections
   grow (`topbar__nav-item--labeled`).
3. **No tooltip beside a label:** when the row is labeled, the `title`
   attribute drops (a JS mirror of the CSS breakpoint — a "Tracks" tooltip
   hovering beside the word "Tracks" is noise, and HIG says don't restate
   the visible). `aria-label` stays: identical to the visible text, it
   adds nothing for assistive tech and keeps the DOM robust if the tiers
   ever move.
4. **Touch targets — HIG's 44×44pt floor:** on coarse pointers
   (`hover: none` + `pointer: coarse`) the 32px controls keep their visual
   geometry for the eye and extend their hit area with a 6px invisible
   slop instead — 44px overall, zero layout change. Where neighbours'
   slops overlap, the painted-on-top item wins, matching the visual
   order. This retires a width-only tier switch that handed an iPad in
   landscape the desktop's 32px targets. Verified end to end: a click 5px
   above a row's box lands on the row. The sheet's rows go 40px → 44px
   (supersedes §19's 40px "touch target").
5. **The search pill is a `<label>` now:** its whole surface — padding
   strips included — focuses the field. The strips used to be dead zones
   on every device: clicks on the pill's soft edges did nothing.
6. **Breakpoints live in one place now** (tokens.css, as a comment —
   media queries can't read custom properties): 640 phone, 760 wordmark,
   940 labeled nav / queue sheet; touch capability sizes targets
   independently of width. The JS constants (`PHONE_BP`, `LABELED_BP`,
   `NARROW_BP`, `SHEET_BP`) mirror it.

Verified in the running app at 320/375/700/939/940/1280, light + dark: no
overflow at any width, labels never wrap, the active pill carries icon and
text together, sheet rows at 44px, search ≥ 240px wherever labels show.

---

## 29. Addendum — Part 1 foundations: playback survives a reload, whole-view queues, Esc, stream errors (2026-10-01)

Implements Part 1 of `docs/UX-REVIEW.md` — the four cracks in the
foundation. Three of these revise settled decisions; §12 asks for the
owner's sign-off on deviations, and the review (which the owner handed to
this session as the work order) is that sign-off: the contract was written
feature-first, and these surfaces are experience-first.

1. **The queue is durable session state (supersedes the player store's
   "queue/position are session state" rule; completes §13.9).** Queue +
   play order restore on load; the playhead (orderPos + position +
   timestamp) restores with them. Two localStorage keys, written at
   different cadences: `flow.player.queue` (the big one) only when the
   queue/order changes — debounced 400 ms — and `flow.player.playhead`
   (tiny) throttled to one write per 3 s while playing, flushed on
   `pagehide`/`visibilitychange`. The hand-rolled writer deliberately
   bypasses the `persist` middleware: it re-serializes on *every* store
   update, and position updates 4×/s — stringifying a full-library queue
   at that cadence is not acceptable. Restores are always **paused** with
   the audio element untouched (no autoplay, no surprise sound, no wasted
   prefetch); the first press of play loads the restored track at the
   saved position (`currentTime` set before metadata = the spec's default
   playback start position). Preferences (volume/shuffle/repeat) keep
   riding the middleware unchanged. Quota failures and corrupt snapshots
   degrade to the old behavior (fresh session) — never to a broken one.
2. **"Continue listening" ships on Home (§13.9, promised and never
   built).** One quiet row — artwork, title, "Paused at … · N tracks up
   next" — activating it resumes the restored session. Subscribed from its
   own component so the 4 Hz playhead doesn't re-render the view.
3. **"Play from here" means the whole view (fixes the 1,000-row queue).**
   The paged views (Tracks, Favorites) now resolve the **entire filter**
   before queueing — the remaining pages are fetched on play (a few local
   round trips; imperceptible at library scale) — and the row menu's
   "Play" resolves the same full list via a `contextLoader`, so no entry
   point can queue a scroll-depth truncation. If the fetch fails, the
   loaded pages still play. §4.0 (server-truth queue) remains the
   permanent architecture; this is the client-side honest version of it.
4. **Esc precedence, corrected (supersedes §16.3/§16.4's guard).** The
   old "typing target" guard listed buttons and links, so Esc failed
   app-wide whenever any control held focus — in a pointer UI, almost
   always. The rule is now two predicates (`lib/shortcuts.ts`):
   **Space/arrows** yield to any focused interactive control (unchanged
   §16.3 behavior); **Esc** defers only to text mid-edit (`input` with a
   text type, `textarea`, `contenteditable` — where Esc means "cancel the
   edit"; range/checkbox/button-ish inputs don't defer). Esc always closes
   the topmost surface otherwise. The Organize sheet now also yields to
   the Now Playing takeover (DOM-later = topmost) and queue drags, and Get
   Info defers while its draft fields hold focus — one grammar app-wide.
5. **Stream errors skip, they don't stop (supersedes "stop cleanly rather
   than hang").** A failed load (missing file, flaky mount, half-written
   file) auto-advances to the next track with one quiet notice —
   "Skipped "X" — file unavailable." — reusing the undo-toast pill without
   an Undo button (`UndoNotice.undo` is now optional). The skip streak is
   bounded (5 consecutive errors without a successful start → playback
   stops with a calm "several files were unavailable" notice); any manual
   interaction or successful start resets it. Stale error events (the
   element already moved on) are ignored by comparing against the engine's
   own record of the requested URL — `audio.currentSrc` is absolute and
   unsettled during failed loads and must not be trusted.
6. **Frontend tests exist now.** vitest + Testing Library (jsdom), run via
   `npm test`. First suite pins the Esc grammar: button-focused Esc closes
   Now Playing and the Organize sheet; text-focused Esc defers (Get Info
   draft survives). The review's standing verification is honored in the
   exit checklist below.
7. **The scan error count in Settings (1.4's second bullet) needed no
   change:** `scan.errors` has surfaced on the Last-scan row since M2
   ("· N errors"); verified live with a corrupt file (watcher reconcile →
   "1 error"). The path+reason disclosure and the mount-guard state remain
   §2.8 (Part 2/3) work.

Verified in the running app against a generated 2,400-track library (the
review's scale): fresh load + first-row click → queue header reads
"N of 2400"; reload mid-queue → player bar populated, paused, full queue
and shuffled order restored, Continue listening resumes and advances;
Esc-after-button-click closes both Now Playing and the Organize sheet;
Space in the search field types instead of toggling; a corrupted next
track is skipped with the promised notice and playback continues; Settings
shows the scan's error count. Regression suite green (`npm test`),
`tsc --noEmit` and `vite build` clean.

## 30. Addendum — Part 2, the product: header actions, media intelligence, gapless, install (2026-10-01)

Implements Part 2 of `docs/UX-REVIEW.md` (§2.1–§2.8, all boxes ticked).
Three items revise settled decisions explicitly; the review is the owner's
work order for each.

1. **Header actions are the Apple trio — Play · Shuffle · … (new §9.2
   rule).** Album detail and artist detail share one `CollectionActions`
   component (§2.1's grammar can't drift between them); the "…" carries
   exactly Play Next and Add to Playlist. Shuffle means shuffle *on* — it
   sets the store's shuffle (the player bar toggle reflects it honestly)
   and starts at a random index. Per-album actions ride the cover cards
   (`AlbumCard` gains a hover "…" beside the play glyph; touch sees both
   always, same reveal grammar as the row play). `playNextMany` inserts a
   collection into the live queue with the exact playNext grammar, N at a
   time — guaranteed next, shuffle plan otherwise untouched.

2. **"Add to Playlist" is now two-way (extends §23).** The Add Tracks
   picker stays "inside a playlist, find me songs"; the new
   Add-to-Playlist destination dialog is "looking at music, file it
   somewhere" — opened from the row menu (per-track reachability restored)
   and from every collection menu. It lists playlists (art + honest
   count) plus **New Playlist**, which creates and immediately adds in one
   gesture. Registered like every modal: Esc closes, the shortcut guard
   defers, `pickerOpen` is shared.

3. **Media intelligence schema (migration 005; extends §5).** Three
   additions, all overlay-consistent:
   - `tracks.gain_db REAL` — the Sound Check offset in dB (§30.4).
   - `track_artists (track_id, artist_id, role, position)` — credited
     artists with roles `main | featured | composer`. `tracks.artist_id`
     remains the single display artist; the join table is tag-derived and
     rebuilt on every upsert, except the *primary* credit, which follows
     the (overlay-aware) artist column. Editing an artist through the
     apply path maintains the credit rows, so counts never go stale.
   - `track_genres` + `genres` — multi-genre, always tag-derived, pruned
     like every other derived entity.
   Parsing (`tags.py`): repeated tag values are full main credits; the
   "feat." inside one string demotes its tail to `featured`; "&" stays one
   artist (Simon & Garfunkel is a single credit). Genres split on ";" and
   "/" and strip ID3v2.3 "(17)" refs, deduped case-insensitively.
   **Artists are credited:** `/api/artists` counts and artist detail
   include every credited appearance, so a featured artist with no lead
   credits is browsable with an honest count. `?artist_id=` filters match
   credits too. The Organize bulk editor and Get Info gain **Album
   Artist** (`Edited.ALBUM_ARTIST = 16`): setting it pins the track
   overlay AND moves the album row, so compilation resolution is one
   gesture; undo restores per-track former names.

4. **Sound Check (§2.3) — the deliberate, recorded Web Audio exception.**
   §3's "no Web Audio at MVP" is revised exactly as the review proposed:
   a `MediaElementSource → GainNode → destination` chain per element,
   created lazily inside the first user-gesture play (autoplay policies),
   resumed on every play; a context that can't start just leaves unity
   gain — the feature degrades, playback doesn't. Scan-time analysis
   (`app/loudness.py`): a post-reconcile **analyze phase** on the scan's
   own SSE stream — the index is already correct while gains fill in
   behind it. Sources in order: the file's ReplayGain tag (fast, exact),
   else ffmpeg `ebur128` integrated LUFS with gain = (−14 LUFS − I),
   clamped to [−24, +6] dB. **ffmpeg joins the runtime image** (the
   §10.4-stack's first binary dep); without it the phase no-ops and
   tracks play at unity. The phase ends by re-publishing idle — a stuck
   "Analyzing…" state is a regression pinned in tests. Settings gains a
   **Sound Check** toggle (`role="switch"`, persisted in the player
   store's `partialize` next to volume); a track without a measurement
   plays at its own level — the honest fallback.

5. **Gapless playback (§2.6) — dual-element pre-roll, revising "out of
   scope".** Two elements, one `audio` binding. Within 10 s of the end the
   next track preloads into the standby element (gain-matched, volume
   matched); at the `ended` boundary the binding swaps and the prepared
   element starts — no src swap on a dying element, no re-buffer gap. All
   element handlers guard `el !== audio` (standby events are machinery,
   never state); a standby load error falls back to the classic advance;
   repeat-one never preloads; `load()` resets the standby. The queue
   snapshot self-heals: `prepareStandby()` re-peeks on every timeupdate,
   so queue edits under a prepared standby converge within one tick.

6. **Sort everywhere (§2.4).** Albums and Artists take `dir` now; both
   views ride the shared `SortMenu` with URL state (`?sort=&dir=`), pick-
   active-flips-direction, count sorts defaulting to most-first. Artists'
   bespoke pill is gone — one grammar, one implementation. *Considered
   and deferred:* year section-headers / a letter index — the counts that
   motivate them aren't there yet; revisit only with the §4.2 schema
   futures.

7. **Genres are a filter, not a section (§2.2's "section or filter").**
   The nav's section set is settled (§18, §23 — five sections, owner
   approved), and a genre's natural destination is "its songs," which the
   Tracks table already is. `GET /api/genres` (name, track/album counts,
   a representative cover) feeds a **Genre pill** in the Tracks header:
   URL state (`?genre=<id>`), subtitle reads "N tracks in 'Jazz'",
   `?genre=` rides `fetchAllTracks` so play-from-here and the row menu
   queue the whole filtered view (§29 holds).

8. **Home earns its place (§2.5).** Modules: Continue listening (§29),
   **Shuffle all** — one quiet card that fetches the *full* library before
   queuing (never a truncated queue) and flips shuffle on — Recently
   added, Playlists. The "cut the route" branch is resolved: Home keeps
   its place.

9. **The tab, the icon, the install (§2.7).** `document.title` follows the
   playing track — "Artist — Track · Flow" — set engine-side (React never
   re-renders for it) and reverted to "Flow" when the queue empties. A
   vector favicon adapts per theme ramp (dark tile in light chrome,
   inverted in dark); `apple-touch-icon.png` (180), PWA manifest
   (`display: standalone`, 192/512 + maskable, theme-color per ramp), and
   the iOS meta set. Icons are generated by a stdlib script committed to
   no build step — regenerating is `/tmp`-script work only if the mark
   ever changes.

10. **Settings tells the truth about the machine (§2.8).** The scanner
    persists a per-file error log (path + reason, capped at 500 with an
    honest `total`), served by `GET /api/scan/errors` and shown in a calm
    disclosure — "N files skipped — View" — only after a scan ends. The
    broken-mount trip gets its own state (`scan.mount_guard`): a card,
    not an error — what happened, that nothing was removed, what to do —
    with the rescan action inside it. The analyze phase has its own SSE
    label ("Analyzing audio…") everywhere "Scanning…" used to smear.

**API deltas (OpenAPI → TS client regenerated):** `GET /api/genres`,
`GET /api/scan/errors`, `?dir=` on albums/artists, `?genre_id=` on
tracks, `gain_db` + `album_artist` on TrackOut, `album_artist` on
TrackPatch/BulkApplyIn, `mount_guard` + `"analyze"` phase on ScanStatus.

Verified in the running app against a generated 2,400-track / 120-album
library, 372 feat. credits, 7 genre families, 277 ReplayGain-tagged files
(the review's scale, plus this addendum's data): album/artist headers show
Play · Shuffle · … and the "…" queues Play Next / opens the destination
dialog; New Playlist created with the album's 20 tracks in one click; the
per-card menu opens above the cover with all four actions; the genre pill
filters to "?genre=2 — 271 tracks in 'Jazz'" and play-from-here queues the
full filtered view; a 2,400-track shuffle-all runs with the Sound Check
graph active and the queue advances track-to-track (1-second fixtures
stress the ended→swap path continuously) with zero console errors; the
window title reads "Artist 04 — Track 20 · Flow"; the analysis phase
measured 2,123/2,123 in 85 s and returned to idle; a corrupt file lands
in "1 file skipped — View" with path + reason; renaming the music folder
away trips the calm mount-guard card and a scan after restoring it clears
the flag with all 2,400 tracks intact. Backend suite green (101 tests,
20 new), `tsc --noEmit`, `vite build`, and `npm test` clean.

## 31. Addendum — Part 3, the design system: the accent reserved, the details at the bar (2026-10-01)

Implements Part 3 of `docs/UX-REVIEW.md` (§3.1–§3.4; §3.3 is a protection
note, nothing to build). One decision was taken explicitly with the owner
and revises a settled decision; the rest are the review's named details.
All changes are frontend-only — no API deltas.

1. **The accent is reserved for the playing bars (§3.1 — decided with the
   owner 2026-10-01).** The review's "reduce to the playing bars" branch is
   adopted: monochrome chrome + colored art is the design language, and a
   permanent red was a watermark on it. The `--accent` token survives
   (light `#d64541`, dark `#e5544e`) but is consumed by exactly one rule —
   `.eq span` (controls.css), the playing-row equalizer bars: the review's
   "one moment of true state." Every former consumer is monochrome now,
   carried by inversion, fills, and weight:
   - active nav pill (top bar + phone sheet icon): full ink + 600 weight
     on the existing quiet pill;
   - `:focus-visible` ring: `--text-primary`; `::selection`: an 18% ink
     tint;
   - transport mode-active (shuffle/repeat): full ink;
   - playlist swipe-reveal field: ink-tinted wash with the remove glyph at
     full ink; the swipe Delete action itself: inverted fill (`--text-primary`
     ground, `--bg-canvas` label);
   - destructive affordances (menu danger item, Manage Playlist two-step
     delete, the "clear" suggestion row): full ink, weight 600/650 — the
     consequence reads through weight and, where armed, inversion;
   - hearts (row + menu), remove/× hovers, undo pill: full ink or quiet
     greys.
   §8.1's rule — the album art is the only source of color — now holds in
   practice, not just intent.

2. **Body text one step larger (§3.2).** `--text-body` 13px → 14px; the
   ladder reads 11 / 12 / 14 / 15 / 16 / 22 / 30. Secondary metadata
   (`--text-small`, `--text-caption`) is unchanged and carries the
   hierarchy, as the review prescribed. Geometry is untouched: rows are
   governed by their 38px min-height (and the virtualizer's fixed
   ROW_HEIGHT constants), so nothing shifts or clips.

3. **The scrubber seeks live and glides (§3.4a).** Two engine changes in
   `player.ts` / `transport.tsx`:
   - A **rAF position loop** publishes `currentTime` every frame while
     playing — started on the element's `play` event, stopped on `pause`
     (so it never runs while paused or resting at the queue's end). The
     4Hz `timeupdate` path stays as the fallback and keeps `prepareStandby`
     fed; rAF suspends itself when the tab hides. The §29 persistence
     layer already coalesces position writes, so the 60×/s store updates
     cost the same one throttled localStorage write per 3s.
   - **Live seek under the thumb:** the Scrubber's `onInput` coalesces
     through one rAF — at most one seek per frame while dragging (a
     pointer burst or keyboard repeat can't stack seeks the element must
     cancel). The time label and fill follow the thumb live; release and
     blur commit exactly as before.

4. **Click-to-mute (§3.4b).** The volume icon is a control. A shared
   `VolumeControl` (transport.tsx) renders the mute button + slider in
   both bars so the grammar can't drift. `muted` lives in the player
   store as transient state — deliberately not persisted; a fresh session
   is unmuted, like every platform player. The slider keeps its level
   under mute; raising the slider unmutes; `effectiveVolume()` is the one
   writer of element volume (initial state, `setVolume`, and the standby
   pre-roll all read it), so gapless swaps stay mute-consistent. New
   `IconVolumeMute`; the muted state reads at `--text-tertiary`.

5. **The Add Tracks picker is honest at library scale (§3.4c — extends
   §23).** The silent 200-row cap (`RESULT_LIMIT`) is gone:
   - The picker reads offset pages of 200; a quiet **"Load more — showing
     N of M"** tail appends the next page, and the header meta reads
     honestly in both states ("Library — N of M", "Showing N of M
     matches").
   - The list is **element-virtualized** (the queue drawer's pattern, rows
     fixed at 48px) — a fully loaded library stays at ~30 live DOM rows,
     so loading everything is smooth, not a thousands-of-buttons cliff.
   - **Select all means all matches:** if pages remain unloaded, the
     button ("Selecting…" while busy) fetches every remaining page first,
     then selects — the accumulation reads off each `fetchNextPage`
     result, never stale state. "Select all (of the loaded 200)" was the
     defect; the fix makes the label true.

6. **Modals manage focus (§3.4d — a new standing rule under §15.7).** One
   hook, `useModalFocus` (lib/focus.ts), applied to every declared
   `aria-modal` surface: Now Playing, the Organize sheet, Get Info, Add
   Tracks, Add to Playlist, Manage Playlist. On open, focus moves to the
   surface's first control (the picker nominates its search field, keeping
   its precedent; the container itself — `tabindex={-1}` — is the fallback
   host). Never a text field: the Esc-defers-in-text grammar (§29) must
   not be defeated by an auto-focused input. Tab and Shift+Tab cycle
   within the surface (the focusable set is recomputed per press, so
   virtualized lists and conditional buttons stay honest); on close, focus
   returns to the element that held it before — skipped if the user
   already moved focus elsewhere. Anchored popovers and context menus keep
   their own grammar.

7. **Listening tables inherit the Organize cursor (§3.4e).** A shared
   `useRowCursor` (lib/rowCursor.ts), used by the plain TrackTable and the
   windowed VirtualTrackTable: the table container is **one Tab stop**;
   arrows move the cursor, Home/End jump, PageUp/PageDown page (20, as the
   Organize grid), **Enter plays** — idempotent, matching the row click:
   the current track's row never restarts. Keys defer to inner controls
   (buttons, links, sliders) exactly like the Organize grid's §16.3 guard,
   and Space stays with the global transport shortcut. The virtual table
   follows the cursor with `scrollToIndex`; the plain table scrolls the
   `[data-rowindex]` row into view; `.trackrow--cursor` mirrors the
   Organize outline so "the row the keyboard is on" looks the same
   everywhere.

8. **The empty bar actually dims (§3.4f).** `.player--empty` (PlayerBar
   sets it when nothing plays): the play circle drops to the `--bg-inset`
   fill with a tertiary glyph — no full-ink button pretending to be
   enabled — and the scrubber's empty rest track reads at
   `--control-border` strength via a `--scrubber-rest` variable the
   Scrubber's gradient consumes (default remains `--bg-active` for playing
   states). Resolves the dark-mode ambiguity; verified in both ramps.

9. **The queue count is honest (§3.4g).** No code — §29's whole-view
   queues already made "N of M" true. Verified at scale: 4,800 entries in
   the drawer reading "415 of 4800" with 35 live rows.

**Verified in the running app** against the generated 2,400-track /
120-album library (fresh scan: 2,400 indexed, 2,123 analyzed, 0 errors;
1-second fixtures keep the ended→swap path hot): computed-style checks
show `--accent` on exactly one selector — the `.eq` bars
(rgb(214, 69, 65)) — with the active nav pill at full ink and 14px row
titles in both ramps; the empty dark bar renders the play circle at the
inset fill with the scrubber track plainly visible; the playing scrubber's
fill advances per frame (~1.7%/frame — glide, no 4Hz plateaus) and a
trusted-input seek drives the full input → seek → position → fill chain;
click-to-mute flips the glyph and `aria-pressed` with the slider level
kept and restored; the picker opens reading "Library — 200 of 2400" with
Load more appending and Select all fetching all twelve pages ("2400
tracks · 40 min") into a windowed list (~21 live rows); the committed
queue reads "415 of 4800"; Now Playing takes focus at its close button,
Tab cycles inside (24 presses, never escapes), and Esc restores focus to
the element that opened it. Console clean. New regression tests pin the
class defects: modal focus (focus-in, Tab wrap, restore-on-close), row
cursor (arrows, Home/End/PageUp/Down, Enter, inner-control guard), and
mute (toggle keeps level, volume-rise unmutes) — `tsc --noEmit`,
`vite build`, and `npm test` clean (12 tests, 8 new).

## 32. Addendum — Part 4, the queue becomes server truth (2026-10-01)

Implements Part 4 of `docs/UX-REVIEW.md`: §4.0 (the server-truth queue)
and §4.1's two strategic notes. Three settled decisions were revised, all
with the review itself as the owner's work order — the same §12 sign-off
reading §29 and §30 recorded:

- **§13.9's "no server-side play statistics" is revised narrowly.** The
  non-goal that stands: no counts, no charts, no ratings (§1, §2). What
  ships: one private timestamp per track (`played_at`), recorded when the
  track actually plays — the honest server-side completion of the
  "recently played / continue listening" concession §13.9 made via
  localStorage, so the record no longer dies with the browser that played.
- **§29's persistence destination is revised.** The queue remains durable
  session state with the exact §29 cadences and restore grammar — but the
  server is now the *truth truth* and localStorage the offline fallback
  (§4.0: "the client store remains the source of *UI* truth").
- **§13.5's no-auth trade-off gains a README guardrail** (the review's
  "responsible amount of friction"): the warning, not a token.

### The queue API (migration 006; §6 deltas listed at the end)

1. **`POST /api/queue {track_ids | filter, start, shuffle}`** — "play this
   view" (§4.0): exactly one of an explicit id list or the GET /api/tracks
   filter contract minus pagination. The server resolves the WHOLE filter
   in one query — there is no page left to truncate to (§1.2 is fixed
   structurally, not by fetching). It builds the play order (identity
   honoring `start`, or a shuffle anchored there — the client's §29
   buildOrder, server-side), replaces the stored session, and returns the
   canonical snapshot, which the store adopts wholesale (`playSnapshot`).
2. **`GET /api/queue`** — the restore. Self-heals: queue entries cascade
   away when a track leaves the library (like playlist entries), stale
   play-order entries are dropped, the playhead re-points at the same track
   (or clamps like §29's restore when the playhead's own entry died), and
   the healed form is rewritten canonically in the same read.
3. **`PUT /api/queue`** — the plan mirror. The store's subscription (§29's
   400 ms debounce on queue/order changes) PUTs the whole plan — ids,
   play order, orderPos, position. The server validates honestly: `order`
   must be a permutation of 0..n-1 (a 422, answered client-side by falling
   back to localStorage-only persistence, never by corrupting the stored
   session).
4. **`PATCH /api/queue`** — the playhead (§29's 3 s cadence + pagehide
   flush, the flush via `keepalive`). An out-of-range `order_pos` is
   *ignored*, not clamped: it means the writer's plan isn't mirrored yet,
   and clamping would invent a pointer into an order the writer never
   meant — the in-flight PUT brings plan and playhead together.
5. **Storage** is two tiny tables: `queue_items` (dense positions,
   whole-snapshot replace — the queue is state, not a log) and the
   `queue_state` singleton (play order as JSON + orderPos + position +
   updated_at). Replaces are one transaction.
6. **Writes retry while busy.** The scanner's reconcile/analyze
   transactions hold the WAL write lock for seconds at a time; a mirror
   that 500s through every scan would be noise, not resilience. Queue
   writes run under a bounded busy-retry (4 attempts, ~0.3–1.2 s spacing
   beyond SQLite's 5 s busy timeout) — they land as soon as the scanner's
   commit gap appears, and exhaustion keeps the honest error. The client
   adds one quiet retry for the played_at stamp, whose follow-up ticks
   never carry an id (recency-only re-stamping is idempotent).
7. **Client restore precedence (§29 preserved, extended):** the
   localStorage snapshot applies synchronously — instant UI, click-safe —
   then the server's session is adopted over it *if it arrives while the
   local one is untouched*. An untouched first paint shows the server's
   truth (the desktop's queue, not this browser's stale copy); a session
   already begun here is never clobbered. Adoption is queued behind the
   persist middleware's own rehydration, and "touched" means session
   identity (plan, playhead, playing state) — preference writes (volume)
   don't count. Server empty or unreachable → exactly the §29 behavior.
   The client falls back mid-session too: every mirror write is
   fire-and-forget; the localStorage layer always has the session.
8. **Restore adoption is always paused** (§29's rule, unchanged): the bar
   is that state loss is never total, never that sound starts uninvited.

### played_at (migration 007) and its one surface

9. **`tracks.played_at`** — set when a track actually starts playing. The
   playhead sync that follows the engine's `play` event carries
   `played_track_id` explicitly (never derived from stored state, so a
   mirror PUT still in flight cannot mis-stamp). Rescans never touch it —
   the scanner's upsert takes a fixed column list, the same rule that
   protects `favorite` (§15.2's principle, one more column). No counts,
   no charts, no UI anywhere else — §1's exclusion stands.
10. **Its surface is the review's own framing** — "an app that knows you":
    a **Recently played** module on Home (albums ordered by their most
    recent play, the established card grammar), between Continue listening
    and Shuffle all, plus `sort=played` read paths on tracks and albums
    (Albums' SortMenu gains "Recently played"). Absent until something has
    actually played — no empty state, no noise.
11. **README exposure guardrail (§4.1, second note).** Quick start now
    says, in plain text: do not port-forward Flow — no auth means anyone
    who can reach the port can browse, stream, and rewrite the library's
    metadata; tunnel in with a VPN instead. The warning is the chosen
    friction; no auth scaffolding was added (§12).

### What this buys, verified

- **Reloads** restore from server truth even with localStorage wiped —
  player bar populated, paused, full 2,400-entry queue and playhead
  intact (the §29 bar held with its new foundation).
- **A second browser** on the LAN opens mid-session and continues the
  same queue (the review's "multi-screen household") — and played
  through ~2,000 tracks for the better part of an hour with every
  playhead sync at 200 OK.
- **Queue edits survive reloads**: a drawer removal mirrored server-side
  in ~400 ms, and the reload saw the edited queue, playing row intact.
- **Container restarts** resume: the queue and playhead live in SQLite,
  so killing and restarting uvicorn mid-session lost nothing — the
  §4.0 "eventually" is now "already".
- **played_at** accrued 274 timestamps across the verification sessions,
  exactly the tracks that actually played; Home's Recently played read
  them back in true listening order, both themes.
- **The scan collision is real and handled**: replaying the mirror under
  a running reconcile produced zero console errors where the naive
  version 500'd on every 3 s tick.

### API deltas (OpenAPI → TS client regenerated)

`POST/GET/PUT/PATCH /api/queue` (QueueSnapshot / QueuePlayIn /
QueuePutIn / QueuePatchIn / QueuePlayheadOut), `played_at` on TrackOut
and AlbumSummary, `?sort=played` on tracks and albums. Frontend: new
`api/queue.ts` (mirror + restore), `playSnapshot` in the player store,
the paged views' play-from-here and Shuffle all resolve through the
server POST (§29's client-side whole-view fetch remains the fallback),
Home gains the Recently played module, Albums gains the sort option.

New regression tests pin the contract: backend `test_queue_api.py` (the
whole-filter resolution, mirror validation, playhead clamping→ignore
semantics, played_at stamping + rescan survival, cascade healing) and
frontend `server-queue.test.tsx` (adoption over stale local state,
never-clobber once owned, empty-server degradation, plan mirroring) —
backend 112 tests, frontend 17, all green; `tsc --noEmit`, `vite build`,
`npm test` clean. Verified in the running app as recorded above, on
localhost and from a second independent browser, in both themes.

## 33. Addendum — Review 2, Part 1: the listening surfaces know where they are (2026-10-01)

Implements Part 1 of `docs/UX-REVIEW-2.md` (§1.1–§1.4) plus its keystone
§4.0 — one schema decision and its surfaces, shipped as one unit. Two
settled decisions were revised, both with the review itself as the owner's
work order (the §12 sign-off reading of §29–§32, applied again):

- **§23.5's append-only Add-to-Queue is revised to the two-verb grammar.**
  The review's own reasoning: the append-only stance was argued when
  queues were dozens of tracks; at server-truth scale (§32) appending into
  a whole-library queue is indistinguishable from doing nothing. The
  review explicitly re-litigates it, so §23.5's "chosen over insert-after-
  current" now reads "chosen as ONE of two destinations."
- **§32's QueueSnapshot/QueuePutIn grow the `origin` field** (one more
  column in the same contract; extends §5/§32, migration 008).

1. **Queue origin (§1.1 + §4.0).** `queue_state` gains a nullable `origin`
   JSON column — `{kind: album | artist | playlist | filter | shuffle-all
   | manual, label, href}`. POST /api/queue records what the caller
   declares (the caller knows what the view is); PUT mirrors it unchanged
   (queue edits never rewrite where the queue came from); GET returns it
   and healing rewrites preserve it; a corrupt value degrades to null
   (the label is lost, never the session). Surfaces: the drawer head shows
   "Playing from …" (linked when `href` exists — activating the link
   navigates AND closes the takeover, since the drawer lives inside it),
   and Now Playing shows the same sentence under the album line, small and
   secondary. **A `manual` origin renders nothing** — a hand-built queue
   came from nowhere else, and silence is the pre-origin behavior (§23's
   idle queue is unchanged).
2. **Origin is declared by every queue-creation site.** `playTracks` takes
   an optional origin and otherwise records `manual`; `playSnapshot` takes
   it from the adopted server snapshot. Album/artist/playlist/search/
   favorites/tracks views, the album cards, the header trio, the Home
   Shuffle-all card ("Everything, shuffled"), and the top-bar suggestions
   each declare theirs. Queue EDITS (`playNext*`, `addToQueue` on a
   non-empty queue) never touch it — an album queue that grew stays "from
   the album."
3. **The queue body groups by album (drawer only, §1.1).** One derived
   pass over the play order (no new components): a quiet divider row —
   "(album · artist)" + hairline — above each run of the same album.
   The review's literal condition ("only when the queue is longer than
   one album") is refined with one rule the literal reading misses: **a
   divider only sits above runs of two or more tracks.** A one-album
   queue already is its own context (the origin line says so), and a
   shuffled 2,400-track library would otherwise sprout a header above
   nearly every row — a run of one is not a group worth naming. Dividers
   fade while a drag is live, so the traveling rows never read against a
   stale group. Implementation: the virtualizer now measures a layout of
   row + divider entries (static heights, prefix-summed starts; the drag
   slot search bisects row bottoms instead of dividing by the row
   height). The rest of the drawer's math is unchanged.
4. **Play Next vs Add to Queue (end) (§1.2, revising §23.5).** The picker
   keeps append as its default verb ("Add to Queue") with "Play Next"
   beside it; the collection menus (header trio, album cards) carry both
   under their own names — insert-after-current remains the menus' first
   verb. Every addition confirms arrival through the §26 toast grammar:
   `Added N track(s) — play next / end of queue`, with Undo. The one
   non-undoable case is honest: an addition that STARTED playback (Play
   Next on an idle session) says "now playing" and carries no Undo —
   un-adding it would mean stopping the music (a gain stays quiet,
   §26.3's rule). Undo removes exactly the instances that were added,
   by REFERENCE identity (a different object with the same id elsewhere
   keeps its place), and never drops the playing row's own slot (Play
   Next on the playing track must not un-queue what the element holds —
   `removeQueued` in the player store).
5. **Artist Songs fold (§1.3).** The review's Songs-table item was found
   already shipped — `ArtistDetailView` has carried the full credited
   table (shared TrackRow grammar, per-surface count) since §30.3's
   credited-artist API; verified rather than rebuilt. What was missing is
   the fold: the table starts collapsed to 20 rows with a quiet
   "Show all N songs" when the count exceeds 30, so the fold still
   belongs to the covers. `context` stays the WHOLE list while collapsed,
   so every visible row plays in the artist's full context; the header
   trio is untouched (§30.1).
6. **The listening surfaces are doors (§1.4).** Now Playing's artist and
   album lines are links; queue rows' artist names are links (the title
   keeps click-to-jump — no nesting, and a link inside a row owns its
   keyboard: Enter activates the link, never the row); the player bar's
   title links to the album when one is known (joining its artist link);
   Continue listening's artist name is a link inside the card (the card
   keeps play/pause — composition, not a second target). All styled as
   the text they replaced: underline on hover, nothing louder. Linking
   from a surface that overlays the app (Now Playing, its queue drawer)
   closes that surface on activation — a link must land somewhere the
   user can see.

Verification: backend suite green (117 tests, 5 new pinning origin
record/mirror/heal-preservation/degrade), frontend suite green (23 tests,
6 new pinning origin replacement vs. edit-stability, manual on empty,
arrival copy, and reference-identity undo incl. the playing-row
protection), `tsc --noEmit` and `vite build` clean. The API TS client
regenerated from the updated OpenAPI schema (`npm run gen:api`). A live
click-through was started (generated 600-track/30-album library; app
boots with a clean console and the player-bar title→album link observed
live) and was cut short at the owner's direction — the remaining §8.0.6
sweep (both themes, 375 px incl. the drawer's origin line, drawer
groupings) is owed by the next session's verification pass, alongside
Review 2's standing exit-checklist items.

---

## 34. Addendum — Review 2, Part 2: the product gaps that show (2026-10-01)

Implements Part 2 of `docs/UX-REVIEW-2.md` (§2.1–§2.8). Three settled
decisions were revised, each with the review as the owner's work order:

- **§30.1's header trio now includes the playlist.** The playlist detail
  header's standing furniture (Play · Add Tracks · Manage) was the one
  detail view outside the trio; its editing verbs move into the "…" menu,
  and the empty state keeps its one prominent Add affordance (§8.8).
- **§32.7's restore precedence is extended to cover the empty answer.**
  Previously, an empty session from a reachable server degraded to the
  local snapshot — the hole the review observed (a stale snapshot from a
  different library resurrected rows whose ids no longer exist, and the
  player bar linked into "Artist not found"). A reachable server's empty
  answer is now authoritative for CLEARING; only an unreachable server
  degrades to §29, and then §1.4's link grammar renders text, not links,
  for rows the server has not vouched for.
- **§9.5's keyboard set gains the chords the transport stopped short of**
  (§2.4): ⌘/Ctrl+→/← for next/previous — placed BEFORE the §16.3/§29
  modifier early-return, which exists to guard plain arrows and would
  otherwise swallow the chord — and M for mute (the §3.4b toggle action).
  Settings' Keyboard group now also documents §31.7's table cursor
  grammar, which had shipped undocumented — the list and the
  implementation are one grammar; they had drifted.

1. **The playlist joins the header trio (§2.1).** Play · Shuffle · … via
   the SHARED `CollectionActions` — a parameter (`extraItems`), not a
   fork — so Shuffle on a playlist is exactly the album/artist semantics:
   shuffle-on + random start. The "…" menu carries the shared curation
   verbs (Play Next, Add to Queue (end), Add to Playlist) plus, after a
   separator, "Add Tracks" and "Manage". **Delete stays in the Manage
   dialog**, where its two-step confirm lives — hoisting a destructive
   verb one click closer contradicts that grammar, and the review's "the
   existing danger items" are read as the dialog's (the header carried
   none).
2. **Menus navigate (§2.2).** The album "…" menu gains "Go to Artist"
   (the header link is easy to miss); the track row menu gains "Go to
   Album" / "Go to Artist", each present only when the track names that
   entity (null-ability respected), sharing §1.4's destinations. The
   artist "…" menu gains nothing: its album cards ARE the click path, and
   a per-collection "Go to Album" has no single target there. The row
   menu's viewport clamp grew with it (identity + up to nine items).
3. **Favorites' empty state tells the truth (§2.3).** One platform-
   neutral string naming the actual grammar: the heart is on the row, the
   long-press (right-click on desktop) menu is for more. The old sentence
   described the pre-§23 row menu.
4. **The keyboard story is whole (§2.4).** Chords as described above; M
   defers to nothing new (the existing interactive-control guard applies,
   and text fields keep ⌘→ as "end of line" — the chord branch defers
   there explicitly). Settings lists all of it, in two halves: transport
   and chords, then "In tables" (cursor move · Home/End · PageUp/Down ·
   Enter plays · Space toggles).
5. **Search results lead with play, not an ordinal (§2.5).** One prop
   (`hideIndex`) through `TrackTable` → `TrackRow` — the number never
   renders; the play affordance takes its slot permanently (the playing
   row keeps its bars-at-rest/hover-glyph swap). No table fork.
6. **The subtitle never formats an unmeasured zero (§2.6).** Tracks
   (incl. its genre/query variants) and Favorites render an empty
   fixed-height slot while the query is in flight — no "0 songs" flash,
   no layout shift. A computed zero after a real empty result is honest
   and stays.
7. **The stale-snapshot hole is closed (§2.7).** As in the decision note
   above: reachable-empty clears (store AND the two localStorage keys, or
   the next reload resurrects the same ghosts; still gated on the session
   being untouched); unreachable degrades to §29 after two quiet retries
   (8 s, 24 s — a restarting server is a §32-verified event), with rows
   tagged (a WeakSet by object identity, never serialized) and every
   surface that links from player-store state — player bar, Now Playing
   (artist, album, AND the origin link), queue rows, queue head, Home's
   Continue card — rendering text until vouched. Tagged rows exit only by
   wholesale replacement: server adoption, the clear, or live rows
   arriving. No new backend surface: the review's `GET /api/tracks?ids=`
   alternative was weighed and the clearing option chosen (it needs no
   schema work, and a fresh container with an intact library keeps its
   session because the ids all resolve server-side via adoption).
8. **The iOS meta tag is doubled (§2.8).** `mobile-web-app-capable` added
   alongside the legacy `apple-` tag, which stays for older iOS; the
   deprecation log on every load is gone.

Verification: frontend suite green (25 tests — two new pinning §2.7: an
unreachable server degrades with rows unverified, an empty session from a
reachable server clears store and localStorage keys, and adoption
vouches for rows; one §32 case split to the new three-state contract),
`tsc --noEmit` and `vite build` clean. Backend untouched — no suite run.
Per the owner's standing instruction the live §8.0.6 click-through was
deferred; the remaining sweep (both themes, both widths, plus the exit-
checklist items) is owed by the next verification pass.
