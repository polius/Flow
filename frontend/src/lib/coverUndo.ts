/* Cover undo notices shared by the album, artist, and playlist headers,
   so the three surfaces word the recovery identically and the undo logic
   lives in one place. The `artwork` table is content-addressed and never
   pruned, so every undo is a reference write — never a re-upload. */

import type { UndoNotice } from "../stores/ui";

type ShowNotice = (notice: Omit<UndoNotice, "id">) => void;
type ApplyCover = (coverArtworkId: number | null) => Promise<unknown>;
/** The schema types `cover_artwork_id` optional; undefined reads as none. */
type CoverRef = number | null | undefined;

/** After an upload lands: "Added"/"Changed" reads the truth; Undo
    restores the previous cover — or the derived artwork when none was
    set, so undoing an add is removal. */
export function coverChangeNotice(
  show: ShowNotice,
  name: string,
  previous: CoverRef,
  apply: ApplyCover,
): void {
  show({
    message:
      previous != null
        ? `Changed the cover of “${name}”`
        : `Added a cover to “${name}”`,
    undo: async () => {
      await apply(previous ?? null);
    },
  });
}

/** After a removal lands: Undo re-points the cover at the artwork row
    the removal cleared. Nothing to say when the call failed. */
export function coverRemovalNotice(
  show: ShowNotice,
  name: string,
  removed: CoverRef,
  apply: ApplyCover,
): void {
  if (removed == null) return;
  show({
    message: `Removed the cover from “${name}”`,
    undo: async () => {
      await apply(removed);
    },
  });
}
