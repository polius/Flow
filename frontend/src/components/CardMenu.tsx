/* A cover card's menu (album, playlist): the popover anchored to the "…"
   button with a mouse; on touch — where the cover carries no buttons and
   a long press opens the menu (lib/cardMenu.ts) — the same bottom sheet
   song rows use. */

import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { TOUCH_MQ } from "../lib/cardMenu";
import { useMediaQuery } from "../lib/media";

/** The card's menu surface: the anchored popover with a mouse, a bottom
    sheet on touch (portaled, so no scroller or card can clip it). */
export function CardMenu({
  label,
  title,
  subtitle,
  onClose,
  children,
}: {
  label: string;
  /** What the sheet is about: with no cover button under the finger, the
      sheet says which card it belongs to. */
  title: string;
  subtitle?: string | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const touch = useMediaQuery(TOUCH_MQ);
  if (!touch) {
    return (
      <div className="trackmenu album-card__menu" role="menu" aria-label={label}>
        {children}
      </div>
    );
  }
  return createPortal(
    <div className="tracksheet__scrim" onClick={onClose}>
      {/* Only a tap on the scrim closes: an item decides for itself (the
          playlist's Delete arms on its first tap and must stay up). */}
      <div
        className="tracksheet"
        role="menu"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="tracksheet__grabber" aria-hidden="true" />
        <div className="trackmenu__identity">
          <div className="trackmenu__identitymeta">
            <span className="trackmenu__identitytitle">{title}</span>
            {subtitle && <span className="trackmenu__identitysub">{subtitle}</span>}
          </div>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
