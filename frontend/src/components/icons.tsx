/* Hand-drawn icon set on a 24px grid, 1.6px stroke.
   One visual voice — no mixed icon libraries. */

import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconAlbums(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="8" width="13.5" height="12.5" rx="2" />
      <path d="M8 5.2h10.3a2.2 2.2 0 0 1 2.2 2.2v10.1" />
    </Icon>
  );
}

export function IconArtists(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8.2" r="3.4" />
      <path d="M5.5 19.8c.6-3.4 3.2-5.2 6.5-5.2s5.9 1.8 6.5 5.2" />
    </Icon>
  );
}

export function IconTracks(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="17.8" r="2.4" />
      <circle cx="17.6" cy="15.8" r="2.4" />
      <path d="M9.4 17.8V6.6L20 4.6v11.2" />
    </Icon>
  );
}

export function IconPlaylists(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6.5h10.5M4 11.5h10.5M4 16.5h6" />
      <circle cx="17.4" cy="17" r="2.3" />
      <path d="M19.7 17V6.5" />
    </Icon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.3" />
      <path d="m15.7 15.7 4.3 4.3" />
    </Icon>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 8h8.4M17.6 8H20M4 16h4.4M13.6 16H20" />
      <circle cx="15" cy="8" r="2.2" />
      <circle cx="11" cy="16" r="2.2" />
    </Icon>
  );
}

export function IconMusicNote(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8.3" cy="17.6" r="2.8" />
      <path d="M11.1 17.6V5.6" />
      <path d="M11.1 5.6c2.3.15 4.2 1.15 5 3.1" />
    </Icon>
  );
}

export function IconHeart(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19.6C7.3 15.7 4 12.8 4 9.6 4 7.1 5.9 5.3 8.2 5.3c1.5 0 2.9.75 3.8 2 .9-1.25 2.3-2 3.8-2 2.3 0 4.2 1.8 4.2 4.3 0 3.2-3.3 6.1-8 10Z" />
    </Icon>
  );
}

export function IconHeartFill(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M12 19.6C7.3 15.7 4 12.8 4 9.6 4 7.1 5.9 5.3 8.2 5.3c1.5 0 2.9.75 3.8 2 .9-1.25 2.3-2 3.8-2 2.3 0 4.2 1.8 4.2 4.3 0 3.2-3.3 6.1-8 10Z"
        fill="currentColor"
        strokeWidth={1.4}
      />
    </Icon>
  );
}

export function IconMore(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.4" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="18.6" cy="12" r="1.15" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function IconMinus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Icon>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Icon>
  );
}

export function IconGrip(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 9h14M5 15h14" />
    </Icon>
  );
}

/* --- transport (filled glyphs, like SF Symbols) --- */

export function IconPlay(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M8.4 6.1 18.2 12 8.4 17.9Z"
        fill="currentColor"
        strokeWidth={1.4}
      />
    </Icon>
  );
}

export function IconPause(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="7.1" y="5.5" width="3.3" height="13" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.6" y="5.5" width="3.3" height="13" rx="1.2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconPrev(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.6" y="5.8" width="2.4" height="12.4" rx="1.1" fill="currentColor" stroke="none" />
      <path
        d="M18.4 6.4 10.5 12l7.9 5.6Z"
        fill="currentColor"
        strokeWidth={1.3}
      />
    </Icon>
  );
}

export function IconNext(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="16" y="5.8" width="2.4" height="12.4" rx="1.1" fill="currentColor" stroke="none" />
      <path
        d="M5.6 6.4 13.5 12l-7.9 5.6Z"
        fill="currentColor"
        strokeWidth={1.3}
      />
    </Icon>
  );
}

export function IconShuffle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 7h2.4c1.1 0 2.1.5 2.8 1.35l6.6 7.8c.7.85 1.7 1.35 2.8 1.35h2.4" />
      <path d="m17.8 14.8 3.1 3-3.1 3" />
      <path d="M3.5 18.5h2.4c1.1 0 2.1-.5 2.8-1.35l1.1-1.3" />
      <path d="M13.4 10.05l1.1-1.3c.7-.85 1.7-1.35 2.8-1.35h2.4" />
      <path d="m17.8 4.5 3.1 3-3.1 3" />
    </Icon>
  );
}

export function IconRepeat(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M17.2 3.8 20.5 7l-3.3 3.2" />
      <path d="M20.5 7H8.3A4.3 4.3 0 0 0 4 11.3V12" />
      <path d="M6.8 20.2 3.5 17l3.3-3.2" />
      <path d="M3.5 17h12.2A4.3 4.3 0 0 0 20 12.7V12" />
    </Icon>
  );
}

export function IconVolume(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11.5 5.5v13L7.6 15H4.5V9h3.1Z" />
      <path d="M14.8 9.2a4.3 4.3 0 0 1 0 5.6" />
      <path d="M17.3 6.9a7.8 7.8 0 0 1 0 10.2" />
    </Icon>
  );
}
