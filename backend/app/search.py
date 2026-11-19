"""Word search over the track_search index (migration 004).

A query is split into words. A track matches when every word begins a word
in its title, its artist, its album or the album's artist — in any order,
across those four, without regard to case or accents ("hour blue",
"midnight harbor blue hour", "blu ho" and "beyonce" all find what they
should). Albums and artists are matched the same way against their own
names. The same matcher serves the search endpoint and the `q` filter of
the track, album and artist lists.

A query with no word in it (punctuation only) keeps the old behaviour: a
literal substring match, with LIKE's wildcards escaped.
"""

from __future__ import annotations

from app.routers.common import like_pattern


def _words(q: str) -> list[str]:
    return [w for w in q.split() if any(ch.isalnum() for ch in w)]


def _phrase(text: str) -> str:
    """One FTS5 string: quoted, so nothing in it is read as query syntax."""
    return '"' + text.replace('"', '""') + '"'


def fts_query(q: str, columns: tuple[str, ...] = ()) -> str | None:
    """The FTS5 MATCH expression for `q`, or None when it holds no word.
    Every word is a prefix; all of them must match, in the given columns
    (all four when none are named)."""
    words = _words(q)
    if not words:
        return None
    expr = " ".join(f"{_phrase(w)}*" for w in words)
    if columns:
        return f"{{{' '.join(columns)}}} : ({expr})"
    return expr


_MATCH = "(SELECT rowid FROM track_search WHERE track_search MATCH ?)"


def track_match(q: str) -> tuple[str, list]:
    """WHERE fragment (over `t`, `ar`, `al`) selecting the tracks `q` finds."""
    expr = fts_query(q)
    if expr is None:
        pat = like_pattern(q)
        return (
            "(t.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\' "
            "OR al.title LIKE ? ESCAPE '\\')",
            [pat, pat, pat],
        )
    return f"t.id IN {_MATCH}", [expr]


def title_starts(q: str) -> tuple[str, list]:
    """ORDER BY term that puts tracks whose title begins with the whole
    query first (0 before 1). A constant when the query holds no word."""
    words = _words(q)
    if not words:
        return "(t.id IS NULL)", []  # an expression: a bare 0 would be a column number
    return f"(t.id NOT IN {_MATCH})", [f"title : ^ {_phrase(' '.join(words))}*"]


def album_match(q: str) -> tuple[str, list]:
    """WHERE fragment (over `al`, `ar`) selecting the albums `q` finds: every
    word begins a word in the album's title or its artist's name."""
    expr = fts_query(q, ("album", "album_artist"))
    if expr is None:
        pat = like_pattern(q)
        return "(al.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\')", [pat, pat]
    return f"al.id IN (SELECT album_id FROM tracks WHERE id IN {_MATCH})", [expr]


def artist_match(q: str) -> tuple[str, list]:
    """WHERE fragment (over `ar`) selecting the artists `q` finds. The index
    knows an artist through the tracks and albums that name them; an artist
    credited only as a guest is still found by the literal match."""
    pat = like_pattern(q)
    literal = "ar.name LIKE ? ESCAPE '\\'"
    as_artist = fts_query(q, ("artist",))
    as_album_artist = fts_query(q, ("album_artist",))
    if as_artist is None or as_album_artist is None:
        return literal, [pat]
    return (
        f"(ar.id IN (SELECT artist_id FROM tracks WHERE id IN {_MATCH}) "
        f"OR ar.id IN (SELECT al2.artist_id FROM albums al2 JOIN tracks t2 "
        f"ON t2.album_id = al2.id WHERE t2.id IN {_MATCH}) OR {literal})",
        [as_artist, as_album_artist, pat],
    )
