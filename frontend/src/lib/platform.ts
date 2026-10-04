/* Platform facts the player's audio strategy depends on. */

/* iOS / iPadOS — including iPads that request the desktop site: their user
   agent claims "Macintosh", and the touchpoint count gives them away.
   Every iOS browser is WebKit underneath (Brave and Chrome included) and
   shares the constraints the player designs around: the OS suspends
   AudioContext rendering the moment the page is backgrounded, and
   HTMLMediaElement.volume is ignored outright. */
export const isIOS: boolean =
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
