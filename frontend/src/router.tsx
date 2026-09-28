import { createBrowserRouter } from "react-router";

import { AppShell } from "./components/AppShell";
import { AlbumsView } from "./views/AlbumsView";
import { ArtistsView } from "./views/ArtistsView";
import { HomeView } from "./views/HomeView";
import { PlaylistsView } from "./views/PlaylistsView";
import { SearchView } from "./views/SearchView";
import { SettingsView } from "./views/SettingsView";
import { TracksView } from "./views/TracksView";

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <HomeView /> },
      { path: "/albums", element: <AlbumsView /> },
      { path: "/artists", element: <ArtistsView /> },
      { path: "/tracks", element: <TracksView /> },
      { path: "/playlists", element: <PlaylistsView /> },
      { path: "/search", element: <SearchView /> },
      { path: "/settings", element: <SettingsView /> },
    ],
  },
]);
