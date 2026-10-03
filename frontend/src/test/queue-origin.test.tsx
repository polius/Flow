/* Queue origin: a queue replacement records where it came from, queue edits
   never rewrite it, a hand-built queue on an empty session is `manual`, and
   every Play Next / Add to Queue lands an undo toast whose Undo removes
   exactly the instances that were added (reference identity, so a duplicate
   of the same track elsewhere keeps its place). */

import { beforeEach, describe, expect, it } from "vitest";

import type { QueueOrigin, Track } from "../api/types";
import { usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";

/* jsdom has no media pipeline: play() returns nothing, load() is a stub.
   The store's engine layer is not under test here — the plan math is. */
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};
HTMLMediaElement.prototype.load = () => {};

const track = (id: number, albumId: number | null = 1): Track => ({
  id,
  title: `Track ${id}`,
  artist: "Artist",
  artist_id: 1,
  album: "Album",
  album_id: albumId,
  track_no: 1,
  disc_no: 1,
  year: 2026,
  duration: 60,
  format: "mp3",
  favorite: false,
  artwork_id: null,
  path: `track-${id}.mp3`,
  gain_db: null,
  played_at: null,
});

const ALBUM: QueueOrigin = {
  kind: "album",
  label: "Album 03",
  href: "/albums/3",
};

beforeEach(() => {
  usePlayerStore.setState({
    queue: [],
    order: [],
    orderPos: 0,
    isPlaying: false,
    position: 0,
    origin: null,
  });
  useUiStore.setState({ undoNotice: null });
});

describe("queue origin", () => {
  it("records the origin on playTracks and defaults to manual without one", () => {
    usePlayerStore.getState().playTracks([track(1), track(2)], 0, ALBUM);
    expect(usePlayerStore.getState().origin).toEqual(ALBUM);

    usePlayerStore.getState().playTracks([track(3)], 0);
    expect(usePlayerStore.getState().origin).toEqual({
      kind: "manual",
      label: null,
      href: null,
    });
  });

  it("adopts the origin with a server snapshot", () => {
    usePlayerStore.getState().playSnapshot({
      items: [track(1), track(2)],
      order: [0, 1],
      order_pos: 0,
      origin: { kind: "playlist", label: "Road Trip", href: "/playlists/9" },
    });
    expect(usePlayerStore.getState().origin?.label).toBe("Road Trip");
  });

  it("queue edits never rewrite the origin; an empty-session add is manual", () => {
    usePlayerStore.getState().playTracks([track(1), track(2)], 0, ALBUM);
    usePlayerStore.getState().addToQueue([track(3)]);
    expect(usePlayerStore.getState().origin).toEqual(ALBUM);

    usePlayerStore.setState({ queue: [], order: [], orderPos: 0, origin: null });
    usePlayerStore.getState().addToQueue([track(4)]);
    expect(usePlayerStore.getState().origin?.kind).toBe("manual");
  });
});

describe("arrival toast + undo", () => {
  it("Play Next lands 'play next' with an undo that removes exactly the insert", () => {
    usePlayerStore.getState().playTracks([track(1)], 0, ALBUM);
    const added = track(9);
    usePlayerStore.getState().playNextMany([added, track(10)]);

    const notice = useUiStore.getState().undoNotice;
    expect(notice?.message).toBe("Added 2 tracks — play next");
    expect(notice?.undo).toBeTypeOf("function");

    const order = usePlayerStore.getState().order;
    expect(usePlayerStore.getState().queue[order[1]]).toBe(added);

    void notice!.undo!();
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual([1]);
  });

  it("Add to Queue lands 'end of queue' with undo", () => {
    usePlayerStore.getState().playTracks([track(1)], 0, ALBUM);
    const added = track(5);
    usePlayerStore.getState().addToQueue([added]);

    const notice = useUiStore.getState().undoNotice;
    expect(notice?.message).toBe("Added 1 track — end of queue");

    void notice!.undo!();
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual([1]);
  });

  it("undo by reference keeps a duplicate of the same id elsewhere intact", () => {
    const dup = track(7);
    usePlayerStore.getState().playTracks([dup, track(2)], 0, ALBUM);
    usePlayerStore.getState().playNext(dup); // the same instance, again

    const notice = useUiStore.getState().undoNotice;
    void notice!.undo!();
    const ids = usePlayerStore.getState().queue.map((t) => t.id);
    expect(ids.filter((id) => id === 7)).toHaveLength(1);
  });
});
