import { createBrowserRouter, useNavigate, type RouteObject } from "react-router";

import { AppShell } from "./components/AppShell";
import { NotFoundView, RouteErrorView } from "./views/NotFoundView";
import { useEffect, type ComponentType } from "react";
import { useUiStore } from "./stores/ui";

/* Old deep links to /organize land here: the task opens over Tracks and
   the URL stops advertising a section that doesn't exist. */
function OrganizeRedirect() {
  const openOrganize = useUiStore((s) => s.openOrganize);
  const navigate = useNavigate();
  useEffect(() => {
    openOrganize();
    void navigate("/tracks", { replace: true });
  }, [openOrganize, navigate]);
  return null;
}

/* Each section's code loads when it is first visited, so a start pays
   for the page it opens and not for all twelve (sign-in included). After the first visit
   the service worker holds every chunk, so later switches don't wait. */
function view<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M) {
  return async () => ({ Component: (await load())[name] as ComponentType });
}

/* The route table, exported bare so tests can mount it in a memory router.
   Both top-level routes carry the root errorElement: a render error
   anywhere below lands on a calm page with a reload, never on the
   router's developer screen. */
export const routes: RouteObject[] = [
  // Sign-in stands alone: no shell, no nav, nothing to interact with but
  // the password. It renders only when Login is on (the guard inside).
  {
    path: "/login",
    lazy: view(() => import("./views/LoginView"), "LoginView"),
    errorElement: <RouteErrorView />,
  },
  {
    element: <AppShell />,
    errorElement: <RouteErrorView />,
    children: [
      { path: "/", lazy: view(() => import("./views/HomeView"), "HomeView") },
      { path: "/albums", lazy: view(() => import("./views/AlbumsView"), "AlbumsView") },
      { path: "/albums/:albumId", lazy: view(() => import("./views/AlbumDetailView"), "AlbumDetailView") },
      { path: "/artists", lazy: view(() => import("./views/ArtistsView"), "ArtistsView") },
      { path: "/artists/:artistId", lazy: view(() => import("./views/ArtistDetailView"), "ArtistDetailView") },
      { path: "/tracks", lazy: view(() => import("./views/TracksView"), "TracksView") },
      // Organize is a task, not a section: a full-screen sheet opened from
      // the Tracks view — no route, no nav slot.
      { path: "/organize", element: <OrganizeRedirect /> },
      { path: "/favorites", lazy: view(() => import("./views/FavoritesView"), "FavoritesView") },
      { path: "/playlists", lazy: view(() => import("./views/PlaylistsView"), "PlaylistsView") },
      { path: "/playlists/:playlistId", lazy: view(() => import("./views/PlaylistDetailView"), "PlaylistDetailView") },
      { path: "/search", lazy: view(() => import("./views/SearchView"), "SearchView") },
      { path: "/settings", lazy: view(() => import("./views/SettingsView"), "SettingsView") },
      // Anything else is an in-app 404: the shell (player, queue) stays.
      { path: "*", element: <NotFoundView /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
