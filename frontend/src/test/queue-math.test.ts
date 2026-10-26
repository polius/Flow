/* Queue index math: the plan is two arrays (queue + play order) and a
   playhead, and every edit must keep them a consistent permutation. The
   audit's repros are pinned first: Play Next on a built-but-idle queue
   wrote NaN into the order, and Option+↓ moved a row two slots. */

import { beforeEach, describe, expect, it } from "vitest";

import type { Track } from "../api/types";
import { buildOrder, nudgeSlot, sameIds, usePlayerStore } from "../stores/player";
import { useUiStore } from "../stores/ui";

/* jsdom has no media pipeline: play() returns nothing, load() is a stub.
   The plan math is under test, not the engine. */
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};
HTMLMediaElement.prototype.load = () => {};

const track = (id: number): Track => ({
  id,
  title: `Track ${id}`,
  artist: "Artist",
  artist_id: 1,
  album: "Album",
  album_id: 1,
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

/** The plan reads back as ids in play order — what the user hears. */
const planIds = () => {
  const { queue, order } = usePlayerStore.getState();
  return order.map((i) => queue[i]?.id);
};

/** Every invariant the mirror (PUT /api/queue) relies on. */
function expectConsistent() {
  const { queue, order, orderPos } = usePlayerStore.getState();
  expect(order).toHaveLength(queue.length);
  expect(order.every((i) => Number.isInteger(i))).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(queue.map((_, i) => i));
  expect(orderPos === -1 || (orderPos >= 0 && orderPos < order.length)).toBe(true);
}

beforeEach(() => {
  usePlayerStore.setState({
    queue: [],
    order: [],
    orderPos: 0,
    isPlaying: false,
    position: 0,
    origin: null,
    shuffle: false,
  });
  useUiStore.setState({ undoNotice: null });
});

describe("Play Next", () => {
  it("on an idle built queue inserts at the head — no NaN in the order", () => {
    // The audit's repro: queue [1,2] built with Add to Queue (orderPos -1),
    // then Play Next(9) gave queue 9,1,2 with order NaN,0,1.
    usePlayerStore.getState().addToQueue([track(1), track(2)]);
    expect(usePlayerStore.getState().orderPos).toBe(-1);

    usePlayerStore.getState().playNext(track(9));

    const s = usePlayerStore.getState();
    expect(s.order.some((i) => Number.isNaN(i))).toBe(false);
    expect(planIds()).toEqual([9, 1, 2]);
    expect(s.orderPos).toBe(-1); // still idle: nothing started
    expectConsistent();
  });

  it("Play Next (many) on an idle queue keeps the inserted order at the head", () => {
    usePlayerStore.getState().addToQueue([track(1), track(2)]);
    usePlayerStore.getState().playNextMany([track(7), track(8)]);
    expect(planIds()).toEqual([7, 8, 1, 2]);
    expectConsistent();
  });

  it("while playing lands right after the current track", () => {
    usePlayerStore.getState().playTracks([track(1), track(2), track(3)], 1);
    usePlayerStore.getState().playNext(track(9));
    const s = usePlayerStore.getState();
    expect(planIds()).toEqual([1, 2, 9, 3]);
    expect(s.queue[s.order[s.orderPos]].id).toBe(2); // the playhead didn't move
    expectConsistent();
  });

  it("under shuffle keeps the rest of the planned order", () => {
    usePlayerStore.setState({ shuffle: true });
    usePlayerStore.getState().playTracks([1, 2, 3, 4, 5].map(track), 0);
    const before = planIds();
    usePlayerStore.getState().playNextMany([track(8), track(9)]);
    const after = planIds();
    const pos = usePlayerStore.getState().orderPos;
    expect(after.slice(pos + 1, pos + 3)).toEqual([8, 9]);
    expect(after.filter((id) => id !== 8 && id !== 9)).toEqual(before);
    expectConsistent();
  });
});

describe("Option+↑/↓ (nudgeSlot + moveInQueue)", () => {
  beforeEach(() => {
    // An idle queue: no anchored playing row in the way.
    usePlayerStore.getState().addToQueue([0, 1, 2, 3, 4].map(track));
  });

  it("moves a row down exactly one slot", () => {
    // The audit's repro: order [0..4], moving 0 down gave 1,2,0,… .
    usePlayerStore.getState().moveInQueue(0, nudgeSlot(0, 1));
    expect(planIds()).toEqual([1, 0, 2, 3, 4]);
    expectConsistent();
  });

  it("moves a row up exactly one slot", () => {
    usePlayerStore.getState().moveInQueue(3, nudgeSlot(3, -1));
    expect(planIds()).toEqual([0, 1, 3, 2, 4]);
    expectConsistent();
  });

  it("the playing row follows when a neighbor moves across it", () => {
    usePlayerStore.getState().playAt(2); // track 2 plays
    usePlayerStore.getState().moveInQueue(1, nudgeSlot(1, 1)); // 1 jumps below it
    const s = usePlayerStore.getState();
    expect(planIds()).toEqual([0, 2, 1, 3, 4]);
    expect(s.queue[s.order[s.orderPos]].id).toBe(2);
    expectConsistent();
  });
});

describe("shuffle order", () => {
  it("puts the current track at the head of a full permutation", () => {
    const { order, pos } = buildOrder(50, true, 17);
    expect(pos).toBe(0);
    expect(order[0]).toBe(17);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("toggling shuffle keeps the playing track and restores identity order", () => {
    usePlayerStore.getState().playTracks([1, 2, 3, 4, 5].map(track), 3);
    usePlayerStore.getState().setShuffle(true);
    let s = usePlayerStore.getState();
    expect(s.queue[s.order[s.orderPos]].id).toBe(4);
    expectConsistent();
    usePlayerStore.getState().setShuffle(false);
    s = usePlayerStore.getState();
    expect(s.order).toEqual([0, 1, 2, 3, 4]);
    expect(s.queue[s.order[s.orderPos]].id).toBe(4);
  });

  it("shuffling an idle queue keeps it idle instead of naming a current track", () => {
    usePlayerStore.getState().addToQueue([1, 2, 3].map(track));
    usePlayerStore.getState().setShuffle(true);
    expect(usePlayerStore.getState().orderPos).toBe(-1);
    expectConsistent();
    usePlayerStore.getState().setShuffle(false);
    expect(usePlayerStore.getState().orderPos).toBe(-1);
    expectConsistent();
  });
});

describe("sameIds", () => {
  it("a row patched in place is the same queue; an insert is not", () => {
    const q = [track(1), track(2)];
    expect(sameIds(q, [q[0], { ...q[1], favorite: true }])).toBe(true);
    expect(sameIds(q, [q[0], track(3)])).toBe(false);
    expect(sameIds(q, [q[0]])).toBe(false);
  });
});
