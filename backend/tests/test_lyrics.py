"""Lyrics from the listener's own files (G1): a .lrc beside the song first,
then its lyrics tag, then a .txt beside it. Never anything else."""

from __future__ import annotations

import pytest
from mutagen.id3 import ID3, USLT

from app.lyrics import MAX_BYTES, for_file, parse
from tests.audio_fixtures import make_mp3


def test_lrc_lines_carry_their_times_in_order():
    lyrics = parse(
        "﻿[ar:Someone]\n[ti:A Song]\n[offset:+500]\n"
        "[00:12.50]First line\n[01:02]Third\n[00:30.00][00:45.25]Chorus\n\n"
    )
    assert lyrics.synced
    assert [(round(line.time, 2), line.text) for line in lyrics.lines] == [
        (12.0, "First line"),
        (29.5, "Chorus"),
        (44.75, "Chorus"),
        (61.5, "Third"),
    ]


def test_plain_text_is_unsynced_lines():
    lyrics = parse("\n\nOne\r\nTwo\n\nThree\n\n")
    assert not lyrics.synced
    assert [(line.time, line.text) for line in lyrics.lines] == [
        (None, "One"),
        (None, "Two"),
        (None, ""),
        (None, "Three"),
    ]
    assert parse("   \n").lines == []


@pytest.fixture
def lyric_library(music):
    make_mp3(music / "A" / "with-lrc.mp3", title="With LRC", artist="X")
    (music / "A" / "with-lrc.lrc").write_text("[00:01.00]Synced\n", encoding="utf-8")
    (music / "A" / "with-lrc.txt").write_text("Ignored, the .lrc wins\n", encoding="utf-8")
    tagged = make_mp3(music / "A" / "tagged.mp3", title="Tagged", artist="X")
    tags = ID3(tagged)
    tags.add(USLT(encoding=3, lang="eng", desc="", text="From the tag\nSecond"))
    tags.save(tagged)
    make_mp3(music / "A" / "with-txt.mp3", title="With TXT", artist="X")
    (music / "A" / "with-txt.txt").write_text("Plain words\n", encoding="utf-8")
    make_mp3(music / "A" / "none.mp3", title="None", artist="X")
    make_mp3(music / "A" / "huge.mp3", title="Huge", artist="X")
    (music / "A" / "huge.lrc").write_bytes(b"[00:01]x\n" * (MAX_BYTES // 8))
    return music


def test_sources_in_order_and_nothing_when_none(lyric_library):
    music = lyric_library
    assert [line.text for line in for_file(music, "A/with-lrc.mp3").lines] == ["Synced"]
    assert for_file(music, "A/with-lrc.mp3").synced
    tagged = for_file(music, "A/tagged.mp3")
    assert not tagged.synced and [line.text for line in tagged.lines] == ["From the tag", "Second"]
    assert [line.text for line in for_file(music, "A/with-txt.mp3").lines] == ["Plain words"]
    assert for_file(music, "A/none.mp3").lines == []
    assert for_file(music, "A/huge.mp3").lines == []  # over the size cap: not read


def test_nothing_outside_the_library_is_read(music, tmp_path):
    (tmp_path / "secret.lrc").write_text("[00:01]nope\n", encoding="utf-8")
    assert for_file(music, "../secret.mp3").lines == []


def test_the_lyrics_endpoint(client, lyric_library):
    tracks = {t["title"]: t["id"] for t in client.get("/api/tracks").json()["items"]}
    out = client.get(f"/api/tracks/{tracks['With LRC']}/lyrics").json()
    assert out == {"synced": True, "lines": [{"time": 1.0, "text": "Synced"}]}
    assert client.get(f"/api/tracks/{tracks['None']}/lyrics").json() == {"synced": False, "lines": []}
    assert client.get("/api/tracks/999999/lyrics").status_code == 404


@pytest.fixture
def library(lyric_library):
    return lyric_library


def test_other_encodings_and_enhanced_lrc(tmp_path):
    (tmp_path / "a.mp3").write_bytes(b"")
    (tmp_path / "a.lrc").write_bytes("[00:01.00]Café déjà vu\n".encode("utf-16"))
    assert for_file(tmp_path, "a.mp3").lines[0].text == "Café déjà vu"
    (tmp_path / "a.lrc").write_bytes("[00:01.00]Café déjà vu\n".encode("cp1252"))
    assert for_file(tmp_path, "a.mp3").lines[0].text == "Café déjà vu"
    words = parse("[00:12.00]<00:12.00> One <00:12.50> two\n")
    assert words.lines[0].text == "One two"


def test_one_line_with_thousands_of_stamps_is_capped():
    from app.lyrics import MAX_LINES

    lyrics = parse("[00:01]" * 5000 + "chorus\n")
    assert len(lyrics.lines) == MAX_LINES

