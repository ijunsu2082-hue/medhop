// The only icon module. One 24x24 grid. Stroke icons: no fill, currentColor, 1.75 wide, square caps, mitred joins.
// Solid status icons knock their glyph out with even-odd fill, so they read on paper, on ink and on red.
// Every icon is decorative (aria-hidden) and always sits next to a word: shape and colour are never the only signal.
// Verdict mapping everywhere: pass IconPass, warn IconWarn, fail IconCross, info IconInfo.

import type { SVGProps } from "react";

interface IconProps {
  className?: string;
  size?: number;
}

function frame(size: number, className?: string): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    "aria-hidden": true,
    focusable: false,
    className,
  };
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "square" as const,
  strokeLinejoin: "miter" as const,
};

const solid = { fill: "currentColor", fillRule: "evenodd" as const, stroke: "none" };

/** The MedHop mark: two half-capsules, the right half hopped up. */
export function IconMark({ className, size = 24 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M11 9H8a6 6 0 0 0 0 12h3z" fill="currentColor" />
      <path d="M13 3h3a6 6 0 0 1 0 12h-3z" fill="currentColor" />
    </svg>
  );
}

/** A bare check mark: done or confirm only (not a verdict). */
export function IconCheck({ className, size = 20 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M5.5 12 10 16.5l8.5-9" {...stroke} />
    </svg>
  );
}

/** Verdict pass: a solid circle with the check knocked out. */
export function IconPass({ className, size = 20 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path
        d="M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20zM7 10.23l3.5 3.5 7-7 1.77 1.77-8.77 8.77L5.23 12z"
        {...solid}
      />
    </svg>
  );
}

/** Verdict warn: a solid triangle with the exclamation knocked out. */
export function IconWarn({ className, size = 20 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M12 2 23 21.5H1zM11 9h2v6.5h-2zM11 17h2v2.2h-2z" {...solid} />
    </svg>
  );
}

/** Verdict fail, and the blocked mark: a solid square with the X knocked out. */
export function IconCross({ className, size = 20 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path
        d="M3 3h18v18H3zM12 10.23 16 6.23 17.77 8 13.77 12l4 4L16 17.77l-4-4-4 4L6.23 16l4-4-4-4L8 6.23z"
        {...solid}
      />
    </svg>
  );
}

/** Verdict info: an outlined circle with an i. */
export function IconInfo({ className, size = 20 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <circle cx="12" cy="12" r="9.125" {...stroke} />
      <path d="M12 11v6" {...stroke} />
      <path d="M11 6.6h2v2h-2z" fill="currentColor" />
    </svg>
  );
}

/** Emergency stop family only: a solid octagon with a horizontal bar knocked out. */
export function IconStop({ className, size = 24 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86zM6 10.5h12v3H6z" {...solid} />
    </svg>
  );
}

export function IconLock({ className, size = 20 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" {...stroke} />
      <path d="M4.875 11h14.25v9.875H4.875z" {...stroke} />
      <path d="M12 14.5v2.5" {...stroke} />
    </svg>
  );
}

export function IconClock({ className, size = 20 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <circle cx="12" cy="12" r="9.125" {...stroke} />
      <path d="M12 7v5.25l3.5 2.25" {...stroke} />
    </svg>
  );
}

export function IconBell({ className, size = 20 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M6.5 17v-6.5a5.5 5.5 0 0 1 11 0V17M4.5 17h15M10 20.5h4" {...stroke} />
    </svg>
  );
}

/** Arrival at the station. */
export function IconPin({ className, size = 20 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M12 21.5s6.5-6.2 6.5-11.25a6.5 6.5 0 0 0-13 0C5.5 15.3 12 21.5 12 21.5z" {...stroke} />
      <circle cx="12" cy="10.25" r="2.25" {...stroke} />
    </svg>
  );
}

export function IconSpeaker({ className, size = 20, muted = false }: IconProps & { muted?: boolean }) {
  return (
    <svg {...frame(size, className)}>
      <path d="M3.5 9h4l5-4.5v15l-5-4.5h-4z" {...stroke} />
      {muted ? (
        <path d="M16 9.5l5 5M21 9.5l-5 5" {...stroke} />
      ) : (
        <path d="M15.75 9a4.25 4.25 0 0 1 0 6M18.25 6.25a8 8 0 0 1 0 11.5" {...stroke} />
      )}
    </svg>
  );
}

/** Disclosure arrow, pointing right; CSS turns it 90 degrees when the owning control has aria-expanded="true". */
export function IconChevron({ className, size = 16 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M9 5.5 15.5 12 9 18.5" {...stroke} />
    </svg>
  );
}

/** The station sign: a square marker with a filled cell, on a post. */
export function IconSign({ className, size = 20 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M3.875 2.875h16.25v13.25H3.875zM12 16.5v4.625M8 21.125h8" {...stroke} />
      <path d="M7.5 6.5H12V11H7.5z" fill="currentColor" />
    </svg>
  );
}

export function IconCameraOff({ className, size = 20 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M2.875 7.5h4.25l2-2.75h5.75l2 2.75h4.25v12H2.875z" {...stroke} />
      <circle cx="12" cy="13.25" r="3.5" {...stroke} />
      <path d="M3 3l18 18" {...stroke} />
    </svg>
  );
}

export function IconDrone({ className, size = 20 }: IconProps) {
  return (
    <svg {...frame(size, className)}>
      <path d="M9.875 9.875h4.25v4.25h-4.25z" {...stroke} />
      <path d="M9.5 9.5 7 7M14.5 9.5 17 7M14.5 14.5 17 17M9.5 14.5 7 17" {...stroke} />
      <circle cx="5" cy="5" r="2.75" {...stroke} />
      <circle cx="19" cy="5" r="2.75" {...stroke} />
      <circle cx="19" cy="19" r="2.75" {...stroke} />
      <circle cx="5" cy="19" r="2.75" {...stroke} />
    </svg>
  );
}
