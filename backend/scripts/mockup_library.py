"""Dev utility: build a picture-perfect mockup library for screenshots.

The catalog, cover art and MP3 generation live in `app/demo.py` — the same
module the container's DEMO=true mode uses. This script is the dev-facing CLI:
it writes the library anywhere you point it and, when Flow is reachable,
seeds it over the API (scan, favorites, playlists) — handy for dressing a
running instance without touching its files on disk.

    python scripts/mockup_library.py               # files + seed via API
    python scripts/mockup_library.py --skip-api    # files only
    python scripts/mockup_library.py --seed-only   # API only (files exist)

Tear-down: delete the generated folder and rescan (playlists: delete in UI).
"""

from __future__ import annotations

import argparse
import getpass
import json
import random
import sys
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import demo  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]


def generate(out: Path) -> tuple[int, int]:
    """Write the whole catalog; returns (albums, tracks)."""
    tracks = demo.generate_library(out)
    albums = sum(len(albums) for _, _, albums in demo.CATALOG)
    return albums, tracks


# ---- Flow API -----------------------------------------------------------------

class Flow:
    """Tiny stdlib API client: cookies, JSON, no dependencies."""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar())
        )

    def call(self, method: str, path: str, payload: dict | None = None) -> dict | list | None:
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(req, timeout=30) as resp:
                body = resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:200]
            raise SystemExit(f"API {method} {path} failed: HTTP {exc.code} — {detail}")
        return json.loads(body) if body else None

    def login_if_needed(self) -> None:
        status = self.call("GET", "/api/auth/status")
        if not status or not status.get("enabled") or status.get("authenticated"):
            return
        for attempt in range(3):
            password = getpass.getpass(f"Flow at {self.base} is password-protected, password: ")
            try:
                self.call("POST", "/api/auth/login", {"password": password})
                print("  Logged in.")
                return
            except SystemExit:
                print(f"  Incorrect password ({2 - attempt} tries left).")
        raise SystemExit("Wrong password three times — aborting seed.")

    def scan_and_wait(self, expected_tracks: int) -> None:
        try:
            self.call("POST", "/api/scan")
        except SystemExit as exc:
            if "409" not in str(exc):  # already scanning is fine
                raise
        print("  Scan running…")
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            time.sleep(1.5)
            page = self.call("GET", "/api/tracks?limit=1")
            total = page["total"] if page else 0
            if total >= expected_tracks:
                print(f"  Scan complete: {total} tracks indexed.")
                return
        raise SystemExit("Scan didn't finish in 5 minutes — check the app's scan log.")

    def all_tracks(self) -> list[dict]:
        items: list[dict] = []
        offset = 0
        while True:
            page = self.call("GET", f"/api/tracks?limit=500&offset={offset}")
            items.extend(page["items"])
            offset += len(page["items"])
            if offset >= page["total"] or not page["items"]:
                return items

    def seed(self) -> None:
        self.login_if_needed()
        rng = random.Random(1403)
        albums = self.call("GET", "/api/albums?limit=1")["total"]
        tracks = self.call("GET", "/api/tracks?limit=1")["total"]
        print(f"  Library: {albums} albums, {tracks} tracks.")

        tracks = self.all_tracks()
        favorites = demo.pick_favorites(tracks, rng)
        for tid in favorites:
            self.call("PATCH", f"/api/tracks/{tid}", {"favorite": True})
        print(f"  Favorites: {len(favorites)}")

        existing = {
            p["name"]: p["id"]
            for p in self.call("GET", "/api/playlists?limit=100")["items"]
        }
        for name, description, ids in demo.playlist_picks(tracks, rng):
            pid = existing.get(name)
            if pid is None:
                pid = self.call(
                    "POST", "/api/playlists", {"name": name, "description": description}
                )["id"]
            self.call("POST", f"/api/playlists/{pid}/tracks", {"track_ids": ids})
            print(f"  Playlist “{name}”: {len(ids)} tracks")


# ---- entry point ---------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--out", type=Path, default=REPO_ROOT / "flow" / "music",
        help="library root to fill (default: %(default)s)",
    )
    ap.add_argument("--api", default="http://localhost:8080", help="Flow base URL")
    ap.add_argument("--skip-api", action="store_true", help="only write music files")
    ap.add_argument("--seed-only", action="store_true", help="only seed (files already exist)")
    args = ap.parse_args()

    if args.seed_only:
        print(f"Seeding via {args.api} …")
        Flow(args.api).seed()
        return

    if args.out.exists() and any(args.out.iterdir()):
        ap.error(f"{args.out} exists and is not empty — pick a fresh --out")

    total_albums = sum(len(specs) for _, _, specs in demo.CATALOG)
    total_tracks = sum(n for _, _, specs in demo.CATALOG for _, _, n, _ in specs)
    print(f"Generating {len(demo.CATALOG)} artists × {total_albums} albums "
          f"→ {total_tracks} tracks in {args.out}")
    args.out.mkdir(parents=True, exist_ok=True)
    albums, tracks = generate(args.out)
    print(f"Done: {albums} albums, {tracks} tracks.")

    if args.skip_api:
        return

    flow = Flow(args.api)
    try:
        flow.call("GET", "/api/health")
    except (urllib.error.URLError, OSError):
        print(f"Flow isn't reachable at {args.api}. Files are in place —")
        print("start the app, then run again with --seed-only.")
        raise SystemExit(1)
    print(f"Seeding via {args.api} …")
    flow.login_if_needed()
    flow.scan_and_wait(tracks)
    flow.seed()

    print("\nReady for screenshots — worth shooting:")
    print("  Home · Albums · Artist page · Playlists · Playlist detail · Favorites · Search")


if __name__ == "__main__":
    main()
