# Flow — UX & Product Review 2 (senior-level)

> **Date:** 2026-10-01 · **Scope:** product, features, interaction, design system — not bugs.
> **Relationship to Review 1:** every Part in `docs/UX-REVIEW.md` (Parts 1–4) was verified
> shipped and working before this review began; this document is the next review, not a
> re-litigation of it. Same format: one Part per fresh session, checkbox per work item, a
> §-addendum to `docs/DESIGN.md` recording each decision.
>
> **Method:** second full click-through against a fresh 2,400-track / 120-album generated
> library — Home, Tracks (+ genre filter, sort, Organize), Albums + detail, Artists + detail,
> Favorites (empty), Playlists (create → Add Tracks → detail), Search (overlay + results page),
> Settings, Now Playing + queue, at 1440 / 1280 / 375 px, light and dark, with the console
> open. The mid-review server restart doubled as a live test of the §32 server-queue restore
> (it passed — the session came back from server truth, playing row intact).
>
> **How to use this file:** one Part per fresh session. Tick the checkbox when shipped, add
> the §-addendum, and verify in the running app per §8.0.6.

---

## The verdict

Review 1 said *the furniture is excellent; the load-bearing walls need rebuilding.* The walls
were rebuilt — and they hold. The queue survives anything, dismissal is trustworthy, streams
skip instead of dying, the accent is disciplined to one moment, and the restore behavior was
demonstrated live during this review. The foundation is no longer the story.

The story now is **context and reach**. Flow curates rows beautifully, but its listening
surfaces are context-free: the queue is an anonymous flat list that never says where it came
from, Now Playing is a beautiful dead end whose artist and album are unclickable text, an
artist with 500 songs offers no way to hear those songs as a list, and "Add to Queue" on a
2,400-track queue appends into the void — the user cannot observe where the track landed.
Nothing here is broken. What's missing is the connective tissue that makes a library feel
like it *knows what's playing*.

Apple review framing: *the rooms are finished; the doors between them are missing.*

One genuine regression was found (the Tracks header overflows on phones — the Organize pill
is clipped off-canvas at 375 px), and it is the only item rated P0. Everything else is the
work of turning a well-managed library into a well-*inhabited* one.

---

## Part 1 — Context: the listening surfaces don't know where they are

These four items are one argument. Fix them together or not at all; piecemeal they will read
as four small features, together they are the difference between a player and a library.

### 1.1 The queue has no origin, no shape, no "Playing from"

`QueuePanel` renders the play order as one continuous list of identical rows — title, artist,
time — with nothing marking where one album ends and the next begins, and no label anywhere
naming what produced this queue. Play an album, shuffle the library, build a queue by hand:
all three render identically. Apple Music answers this with a header ("Playing from `Album` /
`Playlist` / `Your Library`") and quiet album-header groupings inside the queue. The
information exists in the data model the moment a queue is created — it is simply discarded.

**Do:**
- [x] Record the queue's origin when the session is created: extend `queue_state`
      (`backend/app/routers/queue.py`, migration 008) with `origin` — `kind`
      (album / artist / playlist / filter / shuffle-all / manual), `label` ("Album 03",
      "Everything, shuffled"), `href` (a route, so the label can be a link).
      `POST /api/queue` already receives the filter or id list; the caller knows what it is.
- [x] Surface it: the queue drawer's head shows "Playing from …" next to the position count;
      Now Playing shows it under the album line (small, secondary — §8.3).
- [x] Group the queue body by album: a quiet divider row (album · artist) between runs of the
      same album, in the drawer only, only when the queue is longer than one album. No new
      components — one derived pass over the existing rows.

### 1.2 "Add to Queue" appends to the end of a 2,400-row queue

§23.5 chose append-over-insert deliberately ("click-to-jump already gives play-next by
composition"). That reasoning held when queues were dozens of tracks. After §32, "play this
view" queues 2,400. Appending to the end of a 2,400-entry queue is functionally indistinguishable
from not adding the track at all: the row lands ~39 hours away, the drawer's centering follows
the playing row, and the user sees nothing happen. The honest append would at least announce
itself; the *useful* behavior is the Apple grammar: **Play Next** (insert after current) vs
**Play Last** (append) — the same two verbs Apple Music has offered for a decade.

**Do:**
- [x] In the Add-to-Queue picker (`AddTracksDialog` queue mode) and the row/collection menus,
      offer both destinations: "Play Next" and "Add to Queue (end)". Keep append as the
      picker's default, insert-after-current as the menus' default — matching the verb.
- [x] Confirm arrival with the existing undo-toast grammar (§26): "Added N to the queue —
      play next · Undo." Quiet, honest, one line. (`playNextMany` in the player store already
      implements the insert; this is exposure, not machinery.)

### 1.3 An artist with 500 songs offers no way to play those songs

`ArtistDetailView` is a header (Play · Shuffle · …) and a cover grid. The songs themselves are
reachable only album-by-album, or by leaving the artist for Tracks and — there is no artist
filter in Tracks — failing. The API has supported this surface since §30.3
(`GET /api/tracks?artist_id=` matches credits, feat. included); the view never got it.
Apple Music's artist page is Top Songs / Albums / All Songs — the song list is the page's
center of gravity, not its garnish.

**Do:**
- [x] Add a **Songs** table below the album grid: the shared `TrackRow` grammar, all credited
      tracks of the artist (500 rows is ordinary; plain table per §17.1's reasoning).
      Header row gets a per-surface count ("500 songs · 25 albums" already exists — keep).
      *(Found already shipped — the view has carried the Songs table since the §30.3
      credited-artist API; verified working rather than rebuilt. The fold below was the
      missing piece.)*
- [x] The header trio already resolves the whole catalog server-side (§30.1) — unchanged.
- [x] Consider, and only if it costs nothing: the table starts collapsed to ~20 rows with
      "Show all" when the count is large, so the page's fold still belongs to the covers.

### 1.4 The listening surfaces are dead ends

In Now Playing, the artist and album lines are plain `<p>` text
(`frontend/src/components/NowPlaying.tsx:142`); the queue drawer's rows carry no links
(`QueuePanel.tsx` — zero `Link` usages); the player bar links the artist but not the album
(`PlayerBar.tsx:26-31`); and the Home "Continue listening" card navigates nowhere except
play/pause. These are the four surfaces a listener stares at for hours, and every name on
them is inert. In Apple Music, every artist/album name in every one of these surfaces is a
door. §8.0.5 makes this first-class: *invisible details are still details.*

**Do:**
- [x] Now Playing: artist → artist detail, album → album detail (links styled as today's
      text; hover reveals the underline, nothing louder).
- [x] Queue rows: artist link (title stays the click-to-jump target — do not nest).
- [x] Player bar: title links to the album when the album is known.
- [x] Continue listening: the card keeps play/pause; the artist name inside it becomes a link
      (composition, not a second target on the same surface).

---

## Part 2 — Coherence: the product gaps that show

### 2.1 The playlist header breaks the header trio — and reads as an editing surface

Album and artist detail ship the §30.1 trio: **Play · Shuffle · …**. Playlist detail ships
**Play (disabled when empty) · Add Tracks · Manage** — no Shuffle, and two editing verbs as
permanent header furniture. The playlist is the most *listening*-dense surface in the app
(it's the only collection the user authors), and its header says "spreadsheet." The empty
state can keep "Add your first tracks"; a full playlist's header should speak listening.

**Do:**
- [x] Playlist trio: **Play · Shuffle · …**, where "…" carries Add Tracks, Manage, and the
      existing danger items. The empty state keeps its one prominent Add affordance (§8.8).
- [x] Shuffle on a playlist = shuffle-on + random start, exactly the album/artist semantics
      (`CollectionActions` is shared — this should be a parameter, not a fork).

### 2.2 The menus can browse nothing

The collection "…" menu is exactly {Play Next, Add to Playlist}; the track row menu is
{Play, Play Next, Add to Queue, Add to Playlist, Favorite, Get Info} — no navigation at all
(`CollectionActions.tsx`, `TrackActionsMenu.tsx`). Looking at Album 03, "Go to Artist" is two
clicks away only if the user notices the small artist link in the header; from a row in the
queue, reaching the album is impossible (1.4). Apple's every menu answers "where can I go
from here."

**Do:**
- [x] Collection "…": add **Go to Artist** (album menu), **Go to Album** (artist card menu
      already navigates by clicking the card — the menu item is for the actions row only;
      add it where the context lacks a click path).
- [x] Track row menu: add **Go to Album** / **Go to Artist** (respecting `album_id`/`artist_id`
      null-ability). Two rows, shared with 1.4's link grammar.

### 2.3 The Favorites empty state describes a menu that no longer exists

`FavoritesView.tsx:173`: *"Touch the heart on any track's menu — press and hold a row (or
right-click it) and choose Add to Favorites."* Since §23 the row menu is gone from library
rows; the heart is a hover button on the row itself on desktop and an always-revealed control
on touch. The copy sends new users hunting for a menu that isn't there — the first sentence a
new user reads about the app's flagship personalization feature is wrong. (The long-press
context menu does still carry Favorite on touch, so the second half is half-right.)

**Do:**
- [x] Rewrite per the actual grammar, one string, platform-neutral:
      *"Touch the heart on any row — or press and hold a row (right-click on desktop) for
      more."* Verify in both themes at both widths.

### 2.4 The keyboard story is half-told

The global set is Space, arrows, ⌘F, Esc (`lib/shortcuts.ts`) — transport-era keys. Meanwhile
§31.7 shipped a full table grammar (arrows, Home/End/PageUp/Down, Enter-to-play) that
Settings doesn't list, and there is no chord for the two actions every desktop user performs
a hundred times a session: **next/previous track** and **mute**. For an app whose contract
says the keyboard is "a big part of the Apple feel" (§9.5), the chords stopped at the
transport. Apple Music: `⌘→/⌘←` next/prev.

**Do:**
- [x] Add `⌘→ / ⌘←` (next / previous; plain arrows stay with seek — note the §16.3 guard
      must not swallow the modifier chord; `useGlobalShortcuts` already returns early on
      modifiers, so these need their own listener or an explicit chord branch *before* that
      early return).
- [x] Add `M` for mute (`toggleMuted` exists in the store; VolumeControl is its only caller).
- [x] Settings' Keyboard group gains the row-cursor section (arrows move · Enter plays ·
      Space toggles) and the two new chords. The list and the implementation are one grammar;
      they drifted apart in §31 and nobody noticed — that's the §8.0.5 lesson applied to
      documentation.

### 2.5 Search results inherit meaningless index numbers

The Search results page renders matched tracks in the shared track table, index column
included: 1, 2, 3… over a *result set*. The numbers are the row's position in the match list,
not in anything. Apple's results rows lead with the play affordance, not an ordinal. (Seen
live at `/search?q=rack 15`: a numbered list of matches.)

**Do:**
- [x] Suppress the index column in the search variant (reveal the play glyph in its slot,
      as the playing row already does). One prop on the table, not a fork.

### 2.6 The Tracks header flashes "0 songs" on first load

The subtitle formats `total` before the query resolves (`TracksView.tsx:193-196`): a fresh
visit renders "0 songs" for a beat, then "2,400 songs." The LoadingState skeleton exists
precisely for this (§16.6: *a loading list must never read as an empty library*) — the row
body uses it, the header count doesn't. Same flash on Favorites and the genre/match variants.

**Do:**
- [x] While the query is in flight, render the subtitle slot empty (fixed height — no layout
      shift) instead of formatting a zero. Never show a computed "0" that isn't measured.

### 2.7 A stale localStorage snapshot can resurrect dead entities

Observed live: a leftover local snapshot from a *previous, different library* restored a
queue whose artist link pointed at an id that doesn't exist — the player bar linked
`/artists/6` and the app landed on the (well-designed, honest) "Artist not found" page. The
server queue self-heals on GET (§32.2: cascade, re-point, clamp); the localStorage fallback
layer has no equivalent pass, and §32.7 adopts server truth only when the local snapshot is
*untouched* — an empty server (fresh container, reset volume) leaves stale local state in
charge.

**Do:**
- [x] Validate the local snapshot at adopt time, the same way GET heals: drop queue entries
      whose track ids no longer resolve (the restore path can check against a single
      `GET /api/tracks?ids=` — or simply accept the server's empty-session response as
      authoritative for *clearing* rather than degrading to local).
- [x] Guard every rendered link built from restored state: if the entity id is absent from
      any loaded data, render text, not a link. (The player bar is the one surface that links
      from restored state alone.)

### 2.8 The iOS meta tag is deprecated

Every page load logs: `apple-mobile-web-app-capable is deprecated — include
mobile-web-app-capable` (`frontend/index.html`). One line, but it's the app announcing
un-tended code in its own console — §8.0.5 territory.

**Do:**
- [x] Add `mobile-web-app-capable` alongside (keep the legacy tag for older iOS).

---

## Part 3 — The design system: second-pass critique

### 3.0 What must not change (the protection note, again)

The §31 resolution is *right* and now holds in practice: one accent consumer, monochrome
chrome, colored art, the quiet playing row, the live scrubber, the drag grammar, modal focus,
the row cursor. Both themes read correctly at every width tested. The token ladder, the undo
pill, the honest empty states, and the scan disclosures are the best-in-class parts of this
app. Protect all of it from accretion — several findings below are *removals*, not additions,
for exactly that reason.

### 3.1 Home's full-width cards are unbalanced at desktop widths

"Continue listening" and "Shuffle all" stretch their 56 px of content across the full canvas —
a 1,200+ px row carrying a title, a sub-line, and a button at one end. At 1440 the card is
mostly empty plane; the eye gets nothing between the left content and the right glyph. This
is the one place the app's discipline slips: §8.3's "generous whitespace in hero moments" was
meant for breathing room, not vacancy.

**Do:**
- [ ] Constrain Home (and only Home) to a content column — ~980 px max, left-anchored like
      Settings, so the cover grids stay generous — or re-template the two cards as compact
      rows (art + text + action, ~560 px). Measure both; ship the calmer one. The phone
      layout (§21) already reads correctly and must not change.

### 3.2 Settings hugs the left edge of a wide canvas

The groups form a 560 px column pinned left; on a 1440 canvas the right two-thirds is empty
while the left column carries everything. macOS System Settings centers its column; Apple
Music's settings (limited as they are) center too. The left-pinning reads as an omission, not
a choice.

**Do:**
- [ ] Center the settings column (`margin-inline: auto` on the group container, same max
      width). Two lines of CSS; verify the mount-guard card centers with it.

### 3.4 The phone Now Playing ambience washes out

At 375 px the blurred-art ambience behind Now Playing is so light the artwork's own hue
barely survives — a red album rendered on a pastel pink field. The desktop wash reads as
*tinted*; the phone wash reads as *bleached*. Likely the fixed scrim/wash opacities were
tuned on desktop and the smaller art-to-canvas ratio (§16.1) dilutes the source.

**Do:**
- [ ] Deepen the ambience scrim / raise the wash opacity below the 640 px breakpoint until
      the artwork's hue reads at a glance. Verify against a dark cover *and* a light cover
      (the failure mode is only visible on saturated art).

### 3.5 The Organize "Done ⌄" chevron promises a menu that doesn't exist

`OrganizeSheet.tsx:78-86` renders a chevron inside the Done button; clicking Done closes the
sheet — the chevron is decoration. A chevron is an affordance with exactly one meaning
(*something opens here*). §8.0.3: every element earns its place.

**Do:**
- [ ] Remove the chevron. (If a future Done-menu is plausible, add the chevron when the menu
      exists — affordances follow function, never the reverse.)

### 3.6 One table-density nit, for the record

At wide windows the Tracks table's artist/album columns start at ~44% / ~64% width, leaving
the title column a wide plain field before the first break. It reads fine — but a proportional
column distribution (title ~40%, artist ~25%, album ~25%, time right) would match Music.app's
rhythm at 1440+ without touching the phone ladder. Considered, low priority; include only if
a session is already in `tracktable` CSS for 3.3's regression.

---

## Part 4 — Strategic: the changes worth a decision

### 4.0 Queue origin metadata is the keystone (architecture for Part 1)

Nothing in Part 1 needs new philosophy — it needs one small schema decision: the queue
snapshot carries *where it came from*. This enables "Playing from," the queue's album
groupings, honest "Undo" copy for queue additions, and every future context behavior
(re-queue last session, "play this playlist again") without further schema work. Storage is
one JSON column on the existing `queue_state` singleton (migration 008). Client: `playSnapshot`
already adopts wholesale — the origin rides along and renders in two places.

**Do:**
- [x] Ship 1.1's `origin` column and its two surfaces as one unit. Record as a §-addendum.

### 4.1 Batch curation on listening tables is the one §23 decision worth re-litigating

§23 made rows playback-only and centralized editing in Organize — right call at the time, and
the review defended it. Since then, "Add to Playlist" returned via the row menu (§30.2), and
the queue became server-truth at 2,400-track scale. What has *no path* is the middle gesture:
"these five tracks → that playlist." Today it's five menus, five dialogs. The picker's
Select-all covers *many*; single-row menus cover *one*; the common *few* is orphaned.

**Do (decision first, then build):**
- [ ] Decide with the owner: (a) accept the tax (five menus is honest, if tedious), (b)
      marquee multi-select — Cmd/Shift-click selects rows, a floating quiet bar offers
      Add to Playlist / Add to Queue / Favorite (Organize's BulkBar grammar, repurposed,
      §22's selection model minus the editing), or (c) drag rows onto playlist targets.
      Recommendation: (b) — it reuses two proven grammars, adds no chrome until selection
      exists, and degrades cleanly (a lone Cmd-click selects one; Esc clears).
- [ ] If (b): selection is *transient and listening-safe* — Enter on a selection plays the
      last-selected row; no other behavior changes.

### 4.2 An offline shell is the LAN answer to the server being down

The PWA installs (§30.9) but has no service worker: when uvicorn is restarting (a §32-verified
event!), the installed "app" shows the browser's dinosaur. Caching the built shell and
answering with a calm "Can't reach your library — retrying" card is the difference between an
installed app and a bookmark with ambitions. No data caching, no offline playback — the shell
only.

**Do:**
- [ ] Minimal service worker: cache-first for hashed assets, network-only for `/api`, an
      offline fallback page for navigations. One screen, one retry button. Record as a
      §-addendum (it's the first new §-surface since the manifest).

### 4.3 Playlist export/import (M3U) is table stakes for the self-hosted segment

Flow's stated model is Plex-for-music, and its peer set (Plex, Navidrome, Jellyfin) all move
playlists in and out as files. §1 is untouched: export streams an M3U from the browser
(upload-less), import reads a user-picked file — the music folder is never written. This is
also the honest answer to "what happens to my playlists if I reset the data volume?"

**Do (future milestone, not this cycle):**
- [ ] Export: playlist "…" → "Export M3U" (paths relative to the library root).
- [ ] Import: Playlists view → "Import" → match by path; unmatched rows reported honestly
      (the review-strip grammar, one screen).

### 4.4 Two futures that stay deferred — with the reason recorded

- **Genres as a browse surface.** `GET /api/genres` exists (§30.7); the Tracks filter pill is
  the right MVP surface. The deferral stands until a real library's genre counts motivate a
  section. Revisit with 4.1's outcome, not before.
- **ReplayGain album-mode.** Per-album vs per-track gain is one Settings select away in the
  scan; ship only if a user with classical/theatrical libraries asks. The per-track default
  is correct for shuffle-first listening.

---

## Priority order

**P0 — the regression (Part 3):** 3.3 phone header overflow — the Organize pill is clipped
and unreachable at 375 px; §21's verified no-overflow claim no longer holds. Fix before
anything else; it contradicts the app's own phone contract.

**P1 — context (Part 1 + 4.0):** queue origin + "Playing from" + album-grouped queue;
Play Next vs Add to Queue grammar with arrival feedback; artist Songs surface; links in Now
Playing / queue / player bar.

**P2 — coherence (Part 2 + 3.1/3.2):** playlist header trio; menu navigation items; keyboard
chords + Settings' stale list; Favorites copy; search numbering; "0 songs" flash; stale
snapshot self-heal; Home content column; Settings centering.

**P3 — shine (Part 3 tail + Part 4):** phone ambience depth; Done chevron; meta tag;
offline shell; M3U import/export; multi-select decision (4.1) and, if chosen, its build.

---

## Closing note for the implementing sessions

Review 1's closing warning was that verification tests features in isolation, not a person
listening — that's still true, and this review found its new favorite example: the phone
overflow shipped *after* a phone sweep that verified "no overflow at any width," because the
sweep predated the Organize pill (§23.4). Features added to a verified surface do not inherit
its verification. Two standing additions to every session's exit checklist, alongside Review
1's three:

> *Open `/tracks` at 375 px — every header control must be visible and reachable.*
> *Click every piece of text that names music, on every surface — it either navigates, or it
> is deliberately inert; nothing in between.*

The app has stopped being an excellent player-shaped object — Review 1's bar was met. The
bar for Review 2 is smaller to say and harder to ship: *a library that knows what's playing.*
Part 1 is that app. Build it in order.
