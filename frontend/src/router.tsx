import { createBrowserRouter, useNavigate, type RouteObject } from "react-router";

import { AppShell } from "./components/AppShell";
import { AlbumDetailView } from "./views/AlbumDetailView";
import { AlbumsView } from "./views/AlbumsView";
import { ArtistDetailView } from "./views/ArtistDetailView";
import { ArtistsView } from "./views/ArtistsView";
import { FavoritesView } from "./views/FavoritesView";
import { HomeView } from "./views/HomeView";
import { LoginView } from "./views/LoginView";
import { NotFoundView, RouteErrorView } from "./views/NotFoundView";
import { PlaylistDetailView } from "./views/PlaylistDetailView";
import { PlaylistsView } from "./views/PlaylistsView";
import { SearchView } from "./views/SearchView";
import { SettingsView } from "./views/SettingsView";
import { TracksView } from "./views/TracksView";
import { useEffect } from "react";
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

/* The route table, exported bare so tests can mount it in a memory router.
   Both top-level routes carry the root errorElement: a render error
   anywhere below lands on a calm page with a reload, never on the
   router's developer screen. */
export const routes: RouteObject[] = [
  // Sign-in stands alone: no shell, no nav, nothing to interact with but
  // the password. It renders only when Login is on (the guard inside).
  { path: "/login", element: <LoginView />, errorElement: <RouteErrorView /> },
  {
    element: <AppShell />,
    errorElement: <RouteErrorView />,
    children: [
      { path: "/", element: <HomeView /> },
      { path: "/albums", element: <AlbumsView /> },
      { path: "/albums/:albumId", element: <AlbumDetailView /> },
      { path: "/artists", element: <ArtistsView /> },
      { path: "/artists/:artistId", element: <ArtistDetailView /> },
      { path: "/tracks", element: <TracksView /> },
      // Organize is a task, not a section: a full-screen sheet opened from
      // the Tracks view — no route, no nav slot.
      { path: "/organize", element: <OrganizeRedirect /> },
      { path: "/favorites", element: <FavoritesView /> },
      { path: "/playlists", element: <PlaylistsView /> },
      { path: "/playlists/:playlistId", element: <PlaylistDetailView /> },
      { path: "/search", element: <SearchView /> },
      { path: "/settings", element: <SettingsView /> },
      // Anything else is an in-app 404: the shell (player, queue) stays.
      { path: "*", element: <NotFoundView /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
