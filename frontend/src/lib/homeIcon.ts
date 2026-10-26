/* The Home Screen icon: iOS reads <link rel="apple-touch-icon"> and
   Android reads the manifest's icons at the moment someone adds Flow to
   the Home Screen, so the choice lives in those two links. index.html
   carries a matching inline boot snippet so the links are right before
   any module runs. An icon already on a Home Screen keeps its tile until
   it is removed and added again. */

import { useUiStore, type HomeIcon } from "../stores/ui";

export const HOME_ICON_FILES: Record<HomeIcon, { touch: string; manifest: string }> = {
  dark: { touch: "/icons/apple-touch-icon.png", manifest: "/manifest.webmanifest" },
  light: {
    touch: "/icons/apple-touch-icon-light.png",
    manifest: "/manifest-light.webmanifest",
  },
};

export function applyHomeIcon(icon: HomeIcon): void {
  const files = HOME_ICON_FILES[icon];
  document
    .querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')
    ?.setAttribute("href", files.touch);
  document
    .querySelector<HTMLLinkElement>('link[rel="manifest"]')
    ?.setAttribute("href", files.manifest);
}

let initialized = false;

export function initHomeIcon(): void {
  if (initialized) return;
  initialized = true;
  applyHomeIcon(useUiStore.getState().homeIcon);
  useUiStore.subscribe((state, prev) => {
    if (state.homeIcon !== prev.homeIcon) applyHomeIcon(state.homeIcon);
  });
}
