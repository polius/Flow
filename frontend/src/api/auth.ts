/* Auth status + the sign-in calls.

   The status query drives the AppShell guard and Settings' Access group.
   Login, logout, and password changes use plain fetch rather than the
   typed client: their interesting failures — 401 wrong password, 429
   rate-limited by nginx — arrive as status codes outside the OpenAPI
   contract, and branching on the code here beats typing them into the
   generated schema. */

import { useQuery } from "@tanstack/react-query";

import { api } from "./client";
import { queryClient } from "./queryClient";

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
}

/** The one cache entry every auth surface reads and writes. */
export const AUTH_STATUS_KEY = ["auth", "status"] as const;

export function useAuthStatus() {
  return useQuery({
    queryKey: AUTH_STATUS_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/auth/status");
      return data;
    },
    // Session state never drifts with time — it changes through these
    // helpers, the 401 middleware below, or a page load. Infinity keeps
    // window-focus refetches from re-asking a question the cache answers.
    staleTime: Infinity,
  });
}

// A 401 from any typed-client call (the auth endpoints excluded — a wrong
// password there is expected, not a dead session) means the session died
// while the app was open. Flip the cached status so the AppShell guard
// routes to sign-in on the next render, wherever the user happened to be.
api.use({
  onResponse({ request, response }) {
    const path = new URL(request.url).pathname;
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      queryClient.setQueryData(AUTH_STATUS_KEY, {
        enabled: true,
        authenticated: false,
      } satisfies AuthStatus);
    }
    return response;
  },
});

export type LoginFailure = "wrong-password" | "rate-limited";

export async function login(password: string): Promise<void> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.ok) return;
  throw new Error(res.status === 429 ? "rate-limited" : "wrong-password");
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

/** Turn login on, change the password, or turn it off (null). */
export async function setPassword(password: string | null): Promise<void> {
  const res = await fetch("/api/auth/password", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.ok) return;
  if (res.status === 401) throw new Error("unauthenticated");
  throw new Error(res.status === 429 ? "rate-limited" : "failed");
}
