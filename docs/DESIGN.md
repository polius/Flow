# Flow — Design Document

> **Status:** Approved plan. This document is the single source of truth for implementation.
> A prior design session made and agreed every decision below with the project owner.
> **Do not re-litigate settled decisions.** If something here seems questionable, raise it with
> the user before changing course. Do not implement beyond the current milestone without asking.

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
- **UI/UX is the top priority.** Apple-like design quality. The visual bar is Apple Music,
  not Dribbble. See §8 and §9.

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
- **Search**: `Cmd/Ctrl+F`-focusable, results grouped by entity type.
- **Now Playing**: full-screen takeover — large art, blurred-art ambient background, queue
  drawer on the right. `Esc` closes. (This is the strongest idea from the reference images.)

### 9.3 Editing UX (the Apple way)
- Double-click a track title to rename inline.
- Right-side **"Get Info" panel** for full edits — not stacked modal dialogs.
- Playlist reorder via drag & drop; queue supports "play next" from any context menu.

### 9.4 Player behavior
- Native `HTMLAudioElement`; no server-side transcode.
- Shuffle, repeat off/all/one; queue manipulation (play next, remove from queue).
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
