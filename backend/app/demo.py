"""Demo mode (DEMO=true): a picture-perfect throwaway library, generated on boot.

Ships in the runtime image so `docker run --rm -e DEMO=true …` boots into a
lived-in app — no volume, nothing kept. Three pieces:

- `generate_library()` writes the catalog as real (silent) MP3s: plausible
  artists, albums, tracklists, a solid pastel cover per album, realistic
  durations.
- `prepare_library()` / `seed_when_indexed()` are the lifespan hooks: fill an
  empty library, then dress the database (favorites, playlists) once the
  first scan has indexed the files — before the server accepts traffic, so
  the first paint is never an empty screen.
- `pick_favorites()` / `playlist_picks()` are shared with the dev script
  (scripts/mockup_library.py), which seeds a running instance over the API.
"""

from __future__ import annotations

import logging
import random
import struct
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

from mutagen.id3 import APIC, ID3, TALB, TCON, TIT2, TPE1, TPE2, TPOS, TRCK, TYER

from app import config

log = logging.getLogger("flow.demo")

# ---- catalog -------------------------------------------------------------------
# (artist, genre, [(album, year, track_count, [hand-picked titles…]), …]).
# Titles past the hand-picked ones come from the word bank below, deterministically.

CATALOG: list[tuple[str, str, list[tuple[str, int, int, list[str]]]]] = [
    ("Velvet Hour", "Dream Pop", [
        ("Neon Reverie", 2021, 10, ["City of Glass", "Ultraviolet", "Slow Parade"]),
        ("Hazy Days", 2018, 10, ["Sunday Skin", "Peach Wine", "Oversleep"]),
        ("Afterglow", 2024, 9, ["Golden Rule", "Stay Gold", "Marmalade"]),
        ("Velvet Hour EP", 2016, 6, [
            "First Light", "Echo Park", "Tape Hiss", "Dizzy", "Limousine", "Sleepwalk",
        ]),
    ]),
    ("Cassette Club", "Synthwave", [
        ("Polaroid Summer", 2019, 10, ["Rooftop Tape", "Analog Love", "Sunbleached"]),
        ("Chrome Sunset", 2015, 9, ["Night Drive", "Turquoise", "Out of Order"]),
        ("Rewind", 2017, 10, ["Be Kind", "VHS Heart", "Second Best"]),
    ]),
    ("The Paper Lanterns", "Indie Folk", [
        ("Harbor Lights", 2020, 11, ["Harbor Lights", "North Shore", "Bigger Boats"]),
        ("Winter Letters", 2022, 10, ["Frostbite", "Evergreen", "Woodsmoke"]),
        ("Field Notes", 2017, 9, ["Margin Sketch", "Red Tail", "Long Meadow"]),
    ]),
    ("Midnight Harbor", "Jazz", [
        ("Blue Hour Sessions", 2018, 8, ["Blue Hour", "Smoke Rings", "Slow Drag"]),
        ("Quartet Noir", 2021, 8, ["Black Coffee", "Fourth Floor", "Goodbye, Mr. Blue"]),
        ("Last Train Home", 2015, 9, ["Last Train", "Platform Nine", "Railway Sleepers"]),
    ]),
    ("Aurora Fields", "Ambient", [
        ("Northern Light", 2023, 7, ["Aurora", "Snowblind", "Long Days"]),
        ("Glacier", 2020, 7, ["Blue Ice", "Crevasse", "Moraine"]),
        ("Tundra", 2017, 7, ["Permafrost", "White Out", "Lichen"]),
        ("Sea of Clouds", 2015, 8, ["Overcast", "Altitude", "Smooth Air"]),
    ]),
    ("Neon Cartographers", "Electronic", [
        ("City Grids", 2022, 10, ["One-Way", "Underpass", "Ring Road"]),
        ("Night Routes", 2019, 10, ["Night Bus", "Cyan Street", "Detour"]),
    ]),
    ("Marlowe Reyes", "Soul", [
        ("Golden Hour", 2021, 11, ["Honey Slow", "Sun Kiss", "Sweet Lemon"]),
        ("Slow Burn", 2018, 10, ["Matches", "Candlewick", "Low Flame"]),
        ("Velvet & Gold", 2015, 9, ["Suede", "Brass Buttons", "Tinsel"]),
        ("Saturn Return", 2024, 10, ["Ring Cycle", "Pale Moons", "Late Bloom"]),
    ]),
    ("The Slow Tide", "Post-Rock", [
        ("Undertow", 2020, 8, ["Riptide", "Sea Glass", "Breakwater"]),
        ("Salt & Static", 2017, 8, ["Saltwater", "White Noise", "Longwave"]),
        ("Beacon", 2023, 7, ["Lighthouse", "Foghorn", "North Pier"]),
    ]),
    ("Kite Theory", "Indie Pop", [
        ("Paper Planes", 2023, 11, ["Fold", "Tailwind", "Glide"]),
        ("Cartography", 2020, 10, ["Compass Rose", "Mercator", "Legend"]),
        ("Sundial", 2017, 9, ["Noon", "Shadowline", "Gnomon"]),
    ]),
    ("Odette Blue", "Lo-fi", [
        ("Rainy Window", 2022, 12, ["Puddles", "Umbrella", "Petrichor"]),
        ("Coffee & Rain", 2021, 10, ["Refill", "Slow Pour", "Corner Seat"]),
        ("Dusty Tape", 2019, 10, ["Tape Deck", "Worn Magnets", "Dust in the Groove"]),
    ]),
    ("Fern & Fog", "Americana", [
        ("Hollow Pines", 2019, 10, ["Pinewood", "Campfire", "Old Trail"]),
        ("Sawmill Hymns", 2021, 10, ["Grain and Grit", "Cedar Line", "Riverstone"]),
    ]),
    ("Silver Larch", "Shoegaze", [
        ("Static Bloom", 2021, 9, ["Bloom", "Feedback", "Drown"]),
        ("Nothing Feels Like This", 2018, 8, ["Weightless", "Bruised", "Fade Out"]),
    ]),
]

# Per-genre realistic track lengths (seconds) — Jazz/Ambient/Post-Rock run long,
# Lo-fi runs short; the spread is what makes tracklists and totals look real.
_DURATIONS: dict[str, tuple[int, int]] = {
    "Dream Pop": (180, 300),
    "Synthwave": (200, 285),
    "Indie Folk": (150, 260),
    "Jazz": (240, 420),
    "Ambient": (300, 540),
    "Electronic": (240, 360),
    "Soul": (180, 280),
    "Post-Rock": (300, 480),
    "Indie Pop": (150, 240),
    "Lo-fi": (90, 150),
    "Americana": (180, 300),
    "Shoegaze": (210, 330),
}

_NOUNS = [
    "Skylight", "Afterglow", "Harbor", "Static", "Neon", "Lantern", "Tide",
    "Cassette", "Postcard", "Ember", "Velvet", "Midnight", "Signal", "Avenue",
    "Orbit", "Juniper", "Comet", "Ferris", "Halo", "Radio", "Window", "Meadow",
    "Current", "Mirror", "Canyon", "Pulse", "Starling", "Mercury", "Atlas",
    "Nectar", "Fable", "Daylight", "Rooftop", "Orchard",
]
_SCENIC = [  # nouns that read naturally after "in the …"
    "Window", "Meadow", "Harbor", "Canyon", "Orchard", "Avenue", "Daylight",
]
_ADJECTIVES = [
    "Slow", "Golden", "Quiet", "Electric", "Bitter", "Soft", "Wild", "Silver",
    "Late", "Restless", "Hollow", "Gentle", "Distant", "Frozen", "Burning",
    "Secret", "Lonely", "Bright", "Endless", "Halfway", "Sudden",
]
_GERUNDS = [
    "Chasing", "Falling", "Waiting", "Dancing", "Drifting", "Floating",
    "Holding", "Sinking", "Waking", "Running", "Glowing", "Humming",
]


def _generated_title(rng: random.Random, used: set[str]) -> str:
    noun = rng.choice(_NOUNS)
    scenic = rng.choice(_SCENIC)
    patterns = [
        f"{rng.choice(_ADJECTIVES)} {noun}",
        noun,
        f"{rng.choice(_GERUNDS)} {noun}s",
        f"The {noun}",
        f"{noun} & {rng.choice(_NOUNS)}",
        f"{rng.choice(_GERUNDS)} in the {scenic}",
    ]
    title = rng.choice(patterns)
    if title in used:  # one retry is plenty at this collision rate
        title = f"{rng.choice(_ADJECTIVES)} {rng.choice(_NOUNS)}"
    used.add(title)
    return title


# ---- covers ----------------------------------------------------------------------
# One solid pastel per album — nothing else. The discipline is the design: a
# wall of perfectly flat tiles reads like a curated record shop, the playlist
# mosaics become quiet color grids, and the derived album-page gradient picks
# up the exact tile color. The set spans the hue wheel at matched lightness so
# any two covers sit together; the picker just avoids back-to-back repeats.

COVER_COLORS: list[tuple[int, int, int]] = [
    (238, 228, 214),  # cream
    (240, 208, 180),  # apricot
    (238, 196, 196),  # blush
    (218, 182, 162),  # clay
    (243, 234, 190),  # butter
    (212, 224, 190),  # pistachio
    (186, 206, 184),  # sage
    (162, 192, 176),  # eucalyptus
    (202, 228, 216),  # mint
    (192, 214, 232),  # powder
    (168, 192, 220),  # sky
    (184, 188, 222),  # periwinkle
    (204, 194, 226),  # lavender
    (224, 206, 226),  # lilac
    (218, 198, 210),  # mauve
    (226, 224, 220),  # pearl
]

_RENDER = 512


def _png(width: int, height: int, raw: bytes) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def render_cover(color: tuple[int, int, int]) -> bytes:
    """A perfectly flat tile: one solid color, edge to edge."""
    row = bytes(color) * _RENDER
    return _png(_RENDER, _RENDER, (b"\x00" + row) * _RENDER)


# ---- audio writer ---------------------------------------------------------------
# Silent MP3s with real tags. Self-contained (the image has no tests/):
# mutagen prepends ID3; frames are zero-payload Layer III = decoders render
# silence. Mutagen estimates CBR duration from file size, so 32 kbps keeps
# generated libraries small without changing reported lengths.

_BITRATE_INDEX = {32: 0x10, 128: 0x90}
_FRAMES_PER_SECOND = 38  # 1152 samples / 44100 Hz ≈ 38.3 frames/s
_UNSAFE = '/\\:*?"<>|'


def _mp3_frame(kbps: int) -> bytes:
    size = 144 * kbps * 1000 // 44100
    return bytes([0xFF, 0xFB, _BITRATE_INDEX[kbps], 0xC4]) + b"\x00" * (size - 4)


def _write_track(
    path: Path,
    *,
    title: str,
    artist: str,
    album: str,
    track: str,
    year: str,
    genre: str,
    seconds: float,
    picture: bytes,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame = _mp3_frame(32)
    path.write_bytes(frame * int(seconds * _FRAMES_PER_SECOND))

    n, disc = track.split("/")
    tags = ID3()
    tags.add(TIT2(encoding=3, text=title))
    tags.add(TPE1(encoding=3, text=artist))
    tags.add(TPE2(encoding=3, text=artist))
    tags.add(TALB(encoding=3, text=album))
    tags.add(TRCK(encoding=3, text=track))
    tags.add(TPOS(encoding=3, text=f"1/{disc}"))
    tags.add(TYER(encoding=3, text=year))
    tags.add(TCON(encoding=3, text=genre))
    tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="", data=picture))
    tags.save(str(path), v2_version=3)


def _safe_name(title: str) -> str:
    return "".join("-" if c in _UNSAFE else c for c in title).strip()


def generate_library(music_dir: Path, albums_limit: int | None = None) -> int:
    """Write the catalog into `music_dir`; returns the expected track count."""
    rng = random.Random(1403)  # fixed seed: every demo boots the same library
    used: set[str] = set()
    tracks = 0

    catalog = CATALOG if albums_limit is None else _first_albums(albums_limit)
    # Round-robin over the title-sorted wall: the default Albums view reads as
    # a deliberate hue sweep, and color repeats land 16 titles apart.
    wall = sorted(
        ((artist, album[0]) for artist, _, albums in catalog for album in albums),
        key=lambda pair: pair[1].lower(),
    )
    color_of = {pair: COVER_COLORS[i % len(COVER_COLORS)] for i, pair in enumerate(wall)}

    for artist, genre, albums_spec in catalog:
        for album, year, n_tracks, anchors in albums_spec:
            used.update(anchors)
            titles = list(anchors)
            while len(titles) < n_tracks:
                titles.append(_generated_title(rng, used))

            cover = render_cover(color_of[(artist, album)])

            album_dir = music_dir / _safe_name(artist) / f"{year} - {_safe_name(album)}"
            for t, title in enumerate(titles):
                _write_track(
                    album_dir / f"{t + 1:02d} - {_safe_name(title)}.mp3",
                    title=title,
                    artist=artist,
                    album=album,
                    track=f"{t + 1}/{n_tracks}",
                    year=str(year),
                    genre=genre,
                    seconds=rng.uniform(*_DURATIONS[genre]),
                    picture=cover,
                )
                tracks += 1

    return tracks


def _first_albums(limit: int) -> list[tuple[str, str, list[tuple[str, int, int, list[str]]]]]:
    """The first `limit` albums, re-grouped per artist (test-speed generation)."""
    flat = [(artist, genre, album) for artist, genre, albums in CATALOG for album in albums]
    out: list[tuple[str, str, list[tuple[str, int, int, list[str]]]]] = []
    for artist, genre, album in flat[:limit]:
        if out and out[-1][0] == artist:
            out[-1][2].append(album)
        else:
            out.append((artist, genre, [album]))
    return out


# ---- dressing the database -------------------------------------------------------
# Favorites and playlists live in the DB, not in files. The dev script goes
# through the API; demo mode writes the same end state directly, right after
# the first scan indexes the generated files.

# (name, description, genres to pull from — None for everything, size)
PLAYLIST_SPECS: list[tuple[str, str, tuple[str, ...] | None, int]] = [
    ("Late Night Drive", "Neon streets, long roads home.", ("Synthwave", "Dream Pop"), 16),
    ("Sunday Coffee", "Slow mornings and warm refills.", ("Lo-fi", "Jazz", "Indie Folk"), 14),
    ("Deep Focus", "No words, just flow.", ("Ambient", "Electronic", "Post-Rock"), 18),
    ("Golden Hour", "That last warm hour of light.", ("Soul", "Indie Pop"), 12),
    ("Weekend Mixtape", "Everything that stuck this week.", None, 22),
]


def pick_favorites(tracks: list, rng: random.Random) -> list[int]:
    """Two whole albums plus a few singles — how a real library's favorites look."""
    by_album: dict = {}
    for t in tracks:
        if t["album_id"] is not None:
            by_album.setdefault(t["album_id"], []).append(t["id"])
    picked = {tid for album in rng.sample(sorted(by_album), min(2, len(by_album)))
              for tid in by_album[album]}
    rest = [t["id"] for t in tracks if t["id"] not in picked]
    picked.update(rng.sample(rest, min(8, len(rest))))
    return sorted(picked)


def playlist_picks(tracks: list, rng: random.Random) -> list[tuple[str, str, list[int]]]:
    """Playlist specs resolved against a track list: (name, description, ids)."""
    picks = []
    for name, description, genres, size in PLAYLIST_SPECS:
        pool = tracks if genres is None else [t for t in tracks if t["genre"] in genres]
        chosen = rng.sample(pool, min(size, len(pool)))
        picks.append((name, description, [t["id"] for t in chosen]))
    return picks


_TRACKS_WITH_GENRE = """
SELECT t.id, t.album_id,
       (SELECT g.name FROM track_genres tg JOIN genres g ON g.id = tg.genre_id
        WHERE tg.track_id = t.id ORDER BY tg.genre_id LIMIT 1) AS genre
FROM tracks t
"""


def seed_database(db, rng: random.Random | None = None) -> bool:
    """Favorites + playlists, straight into the DB. One-shot: skipped when
    any playlist already exists. Returns whether it dressed anything."""
    rng = rng or random.Random(1403)
    conn = db.connect()
    if conn.execute("SELECT 1 FROM playlists LIMIT 1").fetchone() is not None:
        return False

    tracks = conn.execute(_TRACKS_WITH_GENRE).fetchall()
    if not tracks:
        return False

    favorites = pick_favorites(tracks, rng)
    marks = ",".join("?" * len(favorites))
    conn.execute(f"UPDATE tracks SET favorite = 1 WHERE id IN ({marks})", favorites)

    for name, description, ids in playlist_picks(tracks, rng):
        cur = conn.execute(
            "INSERT INTO playlists (name, description, created_at) VALUES (?, ?, ?)",
            (name, description, datetime.now(timezone.utc).isoformat()),
        )
        conn.executemany(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
            [(cur.lastrowid, tid, pos) for pos, tid in enumerate(ids, 1)],
        )
    conn.commit()
    log.info("Demo dressed: %d favorites, %d playlists", len(favorites), len(PLAYLIST_SPECS))
    return True


# ---- lifespan hooks ---------------------------------------------------------------

def prepare_library(db) -> int | None:
    """DEMO first boot: generate the catalog into an empty library.

    Returns the expected track count so the caller can scan and then dress
    the DB; None means "nothing to do" (library already indexed, or real
    files are mounted — demo never touches those)."""
    conn = db.connect()
    if conn.execute("SELECT COUNT(*) AS c FROM tracks").fetchone()["c"]:
        return None
    music = config.MUSIC_DIR
    if any(music.iterdir()):
        log.info("DEMO with a mounted library — leaving it alone")
        return None

    expected = generate_library(music)
    albums = sum(len(albums) for _, _, albums in CATALOG)
    log.info("Demo library generated: %d albums, %d tracks in %s", albums, expected, music)
    return expected


def seed_when_indexed(db, expected: int, timeout: float = 180.0) -> None:
    """Block until the first scan has indexed the demo files, then dress the DB.

    Called from the lifespan, before the server accepts traffic — indexing a
    few hundred files is seconds. Loudness analysis keeps running in the
    background and doesn't conflict (WAL + busy timeout)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(0.5)
        count = db.connect().execute("SELECT COUNT(*) AS c FROM tracks").fetchone()["c"]
        if count >= expected:
            seed_database(db)
            return
    log.warning("Demo scan didn't index %d tracks in %.0fs — seeding anyway", expected, timeout)
    seed_database(db)
