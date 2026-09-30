import { createBrowserRouter } from "react-router";

import { AppShell } from "./components/AppShell";
import { AlbumDetailView } from "./views/AlbumDetailView";
import { AlbumsView } from "./views/AlbumsView";
import { ArtistDetailView } from "./views/ArtistDetailView";
import { ArtistsView } from "./views/ArtistsView";
import { HomeView } from "./views/HomeView";
import { PlaylistDetailView } from "./views/PlaylistDetailView";
import { PlaylistsView } from "./views/PlaylistsView";
import { SearchView } from "./views/SearchView";
import { SettingsView } from "./views/SettingsView";
import { TracksView } from "./views/TracksView";
import { OrganizeView } from "./views/OrganizeView";

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <HomeView /> },
      { path: "/albums", element: <AlbumsView /> },
      { path: "/albums/:albumId", element: <AlbumDetailView /> },
      { path: "/artists", element: <ArtistsView /> },
      { path: "/artists/:artistId", element: <ArtistDetailView /> },
      { path: "/tracks", element: <TracksView /> },
      { path: "/organize", element: <OrganizeView /> },
      { path: "/playlists", element: <PlaylistsView /> },
      { path: "/playlists/:playlistId", element: <PlaylistDetailView /> },
      { path: "/search", element: <SearchView /> },
      { path: "/settings", element: <SettingsView /> },
    ],
  },
]);
