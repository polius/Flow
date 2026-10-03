/* Organize (§22): mass curation of the library's SQLite metadata. The view
   has opinions (the "Needs attention" strip) and two gestures (inline cell
   edits; select + bulk set). Files are never touched — every edit is an
   overlay through the same path as Get Info (§15.2), so rescans preserve
   it. Grid keys: arrows move the cursor, Space selects, Enter edits,
   ⌘A selects all matching, ⌘Z undoes the last bulk apply.

   §23 revision: Organize is a task, not a destination — it renders inside
   the full-screen OrganizeSheet (opened from Tracks) instead of living as
   its own route, so the user launches it from where the mess is visible
   and returns exactly where they were. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { api } from "../api/client";
import type { BulkApplyIn, Track } from "../api/types";
import {
  useBulkApply,
  usePatchTrack,
  useReorderTracks,
  useUndoBulkApply,
} from "../api/mutations";
import { BulkBar, BulkBanner } from "../components/BulkBar";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { OrganizeGrid, type SelectAllState } from "../components/OrganizeGrid";
import { ReviewStrip, useReviewSummary } from "../components/ReviewStrip";
import { IconClose, IconOrganize, IconSearch } from "../components/icons";
import { useCurrentTrack } from "../stores/player";
import { useUiStore } from "../stores/ui";
import "../styles/organize.css";

const PAGE_SIZE = 1000;

/** Phones get the review strip and Get Info, not the grid (§22). */
function useCompactMode(): boolean {
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 640px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const onChange = () => setCompact(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return compact;
}

const isInteractiveTarget = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.tagName === "BUTTON" ||
    el.tagName === "A" ||
    el.isContentEditable
  );
};

export function OrganizeView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQ = searchParams.get("q") ?? "";
  const review = searchParams.get("review");
  const albumParam = searchParams.get("album_id");
  const artistParam = searchParams.get("artist_id");
  const albumId = albumParam != null ? Number(albumParam) : null;
  const artistId = artistParam != null ? Number(artistParam) : null;
  // Latest-added-first is the default read (§22): finding and fixing what
  // just landed is the job. The № header restores the curated album order.
  const hasSort = searchParams.get("sort") != null;
  const urlSort = searchParams.get("sort") ?? "added_at";
  const sort = urlSort; // whitelisted server-side; unknown → server default
  const dirParam = searchParams.get("dir");
  const dir =
    dirParam === "desc" ? "desc" : dirParam === "asc" ? "asc" : hasSort ? "asc" : "desc";

  const compact = useCompactMode();
  const openGetInfo = useUiStore((s) => s.openGetInfo);
  const openTrackMenu = useUiStore((s) => s.openTrackMenu);
  const current = useCurrentTrack();

  const summary = useReviewSummary();
  const patchTrack = usePatchTrack();
  const bulkApply = useBulkApply();
  const undoBulk = useUndoBulkApply();
  const reorderTracks = useReorderTracks();

  // ---- filters -----------------------------------------------------------
  const [filterText, setFilterText] = useState(urlQ);
  useEffect(() => {
    setFilterText(urlQ);
  }, [urlQ]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (filterText.trim()) next.set("q", filterText.trim());
      else next.delete("q");
      if (next.toString() !== searchParams.toString()) {
        setSearchParams(next, { replace: true });
      }
    }, 150);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterText]);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (value != null) next.set(key, value);
      else next.delete(key);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const hasFilters = Boolean(urlQ || review || albumParam || artistParam);
  const clearFilters = () => {
    const next = new URLSearchParams();
    setSearchParams(next, { replace: true });
    setFilterText("");
  };

  // ---- data ---------------------------------------------------------------
  const query = useInfiniteQuery({
    queryKey: ["tracks", "organize", { q: urlQ, review, albumId, artistId, sort, dir }],
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET("/api/tracks", {
        params: {
          query: {
            limit: PAGE_SIZE,
            offset: pageParam,
            sort,
            dir,
            ...(urlQ ? { q: urlQ } : {}),
            ...(review ? { review } : {}),
            ...(albumId != null ? { album_id: albumId } : {}),
            ...(artistId != null ? { artist_id: artistId } : {}),
          },
        },
      });
      return data;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + (p?.items.length ?? 0), 0);
      return loaded < (lastPage?.total ?? 0) ? loaded : undefined;
    },
    // A filter change or a header click must not tear the grid down to a
    // skeleton while it fetches — the rows stay mounted and the new order
    // swaps in in one paint. This is the typing-glitch fix (§22).
    placeholderData: (prev) => prev,
  });

  const tracks = useMemo(
    () => query.data?.pages.flatMap((p) => p?.items ?? []) ?? [],
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? 0;

  const handleNearEnd = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  // Column sorting (Finder grammar): click a header to sort by it, click
  // again to flip. The № header restores the curate order (the grid's
  // native grouping).
  const onSort = useCallback(
    (key: string, nextDir: "asc" | "desc") => {
      const next = new URLSearchParams(searchParams);
      next.set("sort", key);
      next.set("dir", nextDir);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    document.querySelector<HTMLElement>(".shell__canvas")?.scrollTo(0, 0);
  }, [sort, dir]);

  // ---- selection -----------------------------------------------------------
  const [selected, setSelected] = useState<Map<number, Track>>(new Map());
  const [allMatching, setAllMatching] = useState(false);
  const [exceptIds, setExceptIds] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  const clearSelection = useCallback(() => {
    setSelected(new Map());
    setAllMatching(false);
    setExceptIds(new Set());
    setAnchor(null);
  }, []);

  const checked = useCallback(
    (t: Track) => (allMatching ? !exceptIds.has(t.id) : selected.has(t.id)),
    [allMatching, exceptIds, selected],
  );

  const count = allMatching
    ? Math.max(0, total - exceptIds.size)
    : selected.size;

  const selectAllState: SelectAllState =
    count === 0
      ? "none"
      : allMatching || (!allMatching && selected.size >= total && total > 0)
        ? "all"
        : "some";

  const toggleRow = useCallback(
    (track: Track, index: number, mods: { shiftKey: boolean; metaKey: boolean }) => {
      setEditTrackId(null);
      if (mods.shiftKey && anchor != null && !allMatching) {
        // Range over the loaded rows between anchor and here (§22: the rest
        // of the library resolves server-side via select-all + except).
        const from = Math.min(anchor, index);
        const to = Math.max(anchor, index);
        setSelected((prev) => {
          const next = new Map(prev);
          for (let i = from; i <= to && i < tracks.length; i++) {
            const t = tracks[i];
            if (t) next.set(t.id, t);
          }
          return next;
        });
        setAnchor(index);
        return;
      }
      setAnchor(index);
      if (allMatching) {
        setExceptIds((prev) => {
          const next = new Set(prev);
          if (next.has(track.id)) next.delete(track.id);
          else next.add(track.id);
          return next;
        });
        return;
      }
      setSelected((prev) => {
        const next = new Map(prev);
        if (next.has(track.id)) next.delete(track.id);
        else next.set(track.id, track);
        return next;
      });
    },
    [anchor, allMatching, tracks],
  );

  const toggleAll = useCallback(() => {
    setEditTrackId(null);
    if (selectAllState === "all") {
      clearSelection();
      return;
    }
    if (!allMatching && tracks.length >= total) {
      // Everything is loaded — an explicit selection keeps the confirm
      // sheet's removal arithmetic exact.
      setSelected(new Map(tracks.map((t) => [t.id, t])));
      setExceptIds(new Set());
      setAnchor(null);
      return;
    }
    // Server-side select-all: what matches the filter minus except_ids.
    setAllMatching(true);
    setSelected(new Map());
    setExceptIds(new Set());
    setAnchor(null);
  }, [selectAllState, allMatching, tracks, total, clearSelection]);

  // ---- cursor + grid keyboard ---------------------------------------------
  const [cursorIndex, setCursorIndex] = useState<number | null>(null);
  const [editTrackId, setEditTrackId] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const [banner, setBanner] = useState<{ kind: "applied" | "undone"; n: number } | null>(null);

  const editAt = useCallback((index: number) => {
    const t = tracks[index];
    if (!t) return;
    setEditTrackId(t.id);
    // startInEdit initializes the editor on mount; clear promptly so a
    // virtualizer remount never re-opens it (§22).
    window.setTimeout(() => setEditTrackId((cur) => (cur === t.id ? null : cur)), 400);
  }, [tracks]);

  // ⌘Z — undo the last bulk apply (§22, one generation, server-side).
  const undo = useCallback(async () => {
    setApplying(true);
    const n = await undoBulk();
    setApplying(false);
    if (n != null) setBanner({ kind: "undone", n });
  }, [undoBulk]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if (isInteractiveTarget(e.target)) return;
        if (summary.data?.undo_available) {
          e.preventDefault();
          void undo();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, summary.data?.undo_available]);

  // ---- apply ----------------------------------------------------------------
  const applyBulk = useCallback(
    async (changes: { artist?: string; album?: string; album_artist?: string }) => {
      setApplying(true);
      const body: BulkApplyIn = allMatching
        ? {
            ...(urlQ ? { q: urlQ } : {}),
            ...(review ? { review } : {}),
            ...(albumId != null ? { album_id: albumId } : {}),
            ...(artistId != null ? { artist_id: artistId } : {}),
            except_ids: [...exceptIds],
            ...changes,
          }
        : { track_ids: [...selected.keys()], except_ids: [], ...changes };
      const n = await bulkApply(body);
      setApplying(false);
      if (n != null) {
        clearSelection();
        setBanner({ kind: "applied", n });
      }
    },
    [allMatching, urlQ, review, albumId, artistId, exceptIds, selected, bulkApply, clearSelection],
  );

  // ---- cell commits ----------------------------------------------------------
  const commitTitle = useCallback(
    async (t: Track, title: string) => void patchTrack(t.id, { title }),
    [patchTrack],
  );
  const commitArtist = useCallback(
    async (t: Track, artist: string) => void patchTrack(t.id, { artist }),
    [patchTrack],
  );
  const commitAlbum = useCallback(
    async (t: Track, album: string) => void patchTrack(t.id, { album }),
    [patchTrack],
  );
  const commitTrackNo = useCallback(
    async (t: Track, value: number | null) => void patchTrack(t.id, { track_no: value }),
    [patchTrack],
  );
  const commitGenre = useCallback(
    async (t: Track, genre: string) => void patchTrack(t.id, { genre }),
    [patchTrack],
  );

  // Drag-reorder within an album (§22): the grid resolves one album's block
  // into its new order; the server renumbers 1..n as overlay edits.
  const onReorderBlock = useCallback(
    async (orderedIds: number[]) => {
      await reorderTracks(orderedIds);
    },
    [reorderTracks],
  );
  // Dragging needs the album grouping to be the truth on screen — the
  // curated order (album blocks, track order within) or a single album's
  // filter. Any other sort would reorder against a different reading.
  const reorderable = sort === "curate" || albumId != null;

  // ---- chip labels for entity filters ---------------------------------------
  const albumChip = useQuery({
    queryKey: ["album", albumId],
    queryFn: async () => {
      const { data } = await api.GET("/api/albums/{album_id}", {
        params: { path: { album_id: albumId! } },
      });
      return data?.title ?? null;
    },
    enabled: albumId != null,
  });
  const artistChip = useQuery({
    queryKey: ["artist", artistId],
    queryFn: async () => {
      const { data } = await api.GET("/api/artists/{artist_id}", {
        params: { path: { artist_id: artistId! } },
      });
      return data?.name ?? null;
    },
    enabled: artistId != null,
  });

  const undoAvailable = summary.data?.undo_available === true;

  const empty = query.isPending ? (
    <LoadingState variant="rows" />
  ) : tracks.length === 0 ? (
    hasFilters ? (
      <div className="orgempty">
        <EmptyState
          icon={<IconSearch size={26} />}
          title="No tracks match"
          hint="Try a different filter, or clear it to see the whole library."
        />
        <button type="button" className="view__action" onClick={clearFilters}>
          Clear filters
        </button>
      </div>
    ) : (
      <EmptyState
        icon={<IconOrganize size={26} />}
        title="Nothing to organize yet"
        hint="Scan your library first — new files land here, grouped by their tags."
      />
    )
  ) : null;

  return (
    <section className="view view--organize">
      <div className="orgtoolbar">
        <div className="orgfilter">
          <span className="orgfilter__icon" aria-hidden="true">
            <IconSearch size={15} />
          </span>
          <input
            className="orgfilter__input"
            value={filterText}
            placeholder="Filter by title, artist, or album"
            aria-label="Filter tracks"
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              // The field's own Esc: clear first, blur — the sheet closes on
              // a second, now-unfocused Esc (the topbar search's grammar).
              if (e.key === "Escape" && filterText) {
                e.stopPropagation();
                setFilterText("");
                e.currentTarget.blur();
              }
            }}
          />
          {filterText && (
            <button
              type="button"
              className="orgfilter__clear"
              aria-label="Clear filter"
              onClick={() => setFilterText("")}
            >
              <IconClose size={13} />
            </button>
          )}
        </div>
        {undoAvailable && !compact && (
          <button
            type="button"
            className="orgfilter__undo"
            onClick={() => void undo()}
            title="Undo the last bulk apply (⌘Z)"
          >
            Undo
          </button>
        )}
      </div>

      <ReviewStrip
        summary={summary.data}
        activeReview={review}
        onPick={(key) => setParam("review", key)}
        onPickAlbum={(id) => {
          const next = new URLSearchParams(searchParams);
          next.delete("review");
          next.set("album_id", String(id));
          setSearchParams(next, { replace: true });
        }}
      />

      {(review || albumParam || artistParam) && (
        <div className="orgchips">
          {review && (
            <span className="chip">
              Review
              <button
                type="button"
                className="chip__x"
                aria-label="Remove review filter"
                onClick={() => setParam("review", null)}
              >
                <IconClose size={10} />
              </button>
            </span>
          )}
          {albumParam && (
            <span className="chip">
              Album: {albumChip.data ?? "…"}
              <button
                type="button"
                className="chip__x"
                aria-label="Remove album filter"
                onClick={() => setParam("album_id", null)}
              >
                <IconClose size={10} />
              </button>
            </span>
          )}
          {artistParam && (
            <span className="chip">
              Artist: {artistChip.data ?? "…"}
              <button
                type="button"
                className="chip__x"
                aria-label="Remove artist filter"
                onClick={() => setParam("artist_id", null)}
              >
                <IconClose size={10} />
              </button>
            </span>
          )}
        </div>
      )}

      {empty}

      {!empty && (
        <OrganizeGrid
          tracks={tracks}
          checked={checked}
          selectAllState={selectAllState}
          currentId={current?.id ?? null}
          compact={compact}
          cursorIndex={compact ? null : cursorIndex}
          editTrackId={compact ? null : editTrackId}
          sort={sort}
          dir={dir}
          onSort={onSort}
          onNearEnd={handleNearEnd}
          onToggleAll={toggleAll}
          onToggleRow={toggleRow}
          onCursorMove={setCursorIndex}
          onCursorToggle={() => {
            if (cursorIndex == null) return;
            const t = tracks[cursorIndex];
            if (t) toggleRow(t, cursorIndex, { shiftKey: false, metaKey: false });
          }}
          onCursorEdit={() => {
            if (cursorIndex != null) editAt(cursorIndex);
          }}
          onOpenInfo={(t) => openGetInfo(t.id)}
          onTrackMenu={(t, x, y) => openTrackMenu({ track: t, x, y, context: tracks })}
          onCommitTitle={commitTitle}
          onCommitArtist={commitArtist}
          onCommitAlbum={commitAlbum}
          onCommitTrackNo={commitTrackNo}
          onCommitGenre={commitGenre}
          canReorder={reorderable && !compact}
          libraryTruncated={tracks.length < total}
          onReorderBlock={(ids) => void onReorderBlock(ids)}
        />
      )}

      {!compact && banner && (
        <BulkBanner
          applied={banner.n}
          onUndo={
            banner.kind === "applied"
              ? () => void undo()
              : () => setBanner(null)
          }
          onDismiss={() => setBanner(null)}
        />
      )}
      {!compact && !banner && count > 0 && (
        <BulkBar
          count={count}
          filterMode={allMatching}
          applying={applying}
          selectedTracks={allMatching ? [] : [...selected.values()]}
          onClear={clearSelection}
          onApply={(changes) => void applyBulk(changes)}
        />
      )}
    </section>
  );
}
