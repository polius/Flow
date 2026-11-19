/* A played stamp is one play in the history (G2): it is sent once, and
   retried only when the first send did not land. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientApi = vi.hoisted(() => ({
  api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn(), DELETE: vi.fn(), use: vi.fn() },
}));
vi.mock("../api/client", () => clientApi);

import { saveServerPlayhead } from "../api/queue";

const answer = (status: number) =>
  Promise.resolve({ data: {}, response: new Response(null, { status }) });

beforeEach(() => {
  vi.useFakeTimers();
  clientApi.api.PATCH.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("the played stamp", () => {
  it("is sent once when the server takes it", async () => {
    clientApi.api.PATCH.mockReturnValue(answer(200));
    saveServerPlayhead({ orderPos: 0, position: 31, playedTrackId: 7 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(clientApi.api.PATCH).toHaveBeenCalledTimes(1);
  });

  it("is sent once more when the first did not land", async () => {
    clientApi.api.PATCH.mockReturnValueOnce(answer(503)).mockReturnValue(answer(200));
    saveServerPlayhead({ orderPos: 0, position: 31, playedTrackId: 7 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(clientApi.api.PATCH).toHaveBeenCalledTimes(2);
  });

  it("a plain playhead save is never retried", async () => {
    clientApi.api.PATCH.mockReturnValue(answer(503));
    saveServerPlayhead({ orderPos: 0, position: 31 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(clientApi.api.PATCH).toHaveBeenCalledTimes(1);
  });
});
