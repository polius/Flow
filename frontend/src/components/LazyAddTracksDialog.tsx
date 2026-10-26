/* The library picker loads on first use: most visits never open it, and
   its code stays out of the startup bundle. Same props, same behavior —
   the dialog simply arrives a frame later the first time. */

import { lazy, Suspense, type ComponentProps } from "react";

const AddTracksDialogImpl = lazy(() =>
  import("./AddTracksDialog").then((m) => ({ default: m.AddTracksDialog })),
);

export function AddTracksDialog(
  props: ComponentProps<typeof AddTracksDialogImpl>,
) {
  return (
    <Suspense fallback={null}>
      <AddTracksDialogImpl {...props} />
    </Suspense>
  );
}
