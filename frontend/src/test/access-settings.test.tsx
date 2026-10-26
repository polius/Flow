/* Settings → Access: changing the password or turning Login off asks for
   the current password, sends it as `current_password`, and a 403 says
   so inline. New passwords need 8 characters. */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_STATUS_KEY } from "../api/auth";
import { AccessSettings } from "../components/AccessSettings";

let fetchMock: ReturnType<typeof vi.fn>;

function renderSettings(enabled: boolean) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(AUTH_STATUS_KEY, { enabled, authenticated: enabled });
  render(
    <QueryClientProvider client={queryClient}>
      <AccessSettings />
    </QueryClientProvider>,
  );
  return queryClient;
}

const sentBody = () =>
  JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Access settings", () => {
  it("turning Login on needs 8 characters and no current password", () => {
    renderSettings(false);
    fireEvent.click(screen.getByRole("button", { name: "Turn On" }));
    expect(screen.queryByLabelText("Current password")).toBeNull();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Reenter password"), { target: { value: "short" } });
    const submit = screen.getAllByRole("button", { name: "Turn On" }).at(-1)!;
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "longenough" } });
    fireEvent.change(screen.getByLabelText("Reenter password"), {
      target: { value: "longenough" },
    });
    expect(submit).toHaveProperty("disabled", false);
  });

  it("changing the password sends the current one", async () => {
    renderSettings(true);
    fireEvent.click(screen.getByRole("button", { name: "Change Password" }));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "newpassword" } });
    fireEvent.change(screen.getByLabelText("Reenter password"), {
      target: { value: "newpassword" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Change Password" });
    expect(sentBody()).toEqual({ password: "newpassword", current_password: "old" });
  });

  it("a wrong current password is said inline", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    renderSettings(true);
    fireEvent.click(screen.getByRole("button", { name: "Turn Off" }));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "nope" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Turn Off" }).at(-1)!);
    expect(await screen.findByText("Current password is incorrect.")).toBeTruthy();
    expect(sentBody()).toEqual({ password: null, current_password: "nope" });
  });
});
