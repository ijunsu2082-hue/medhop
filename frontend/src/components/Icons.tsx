// Small inline SVG icons. Always paired with text: colour and shape are never the only signal.

interface IconProps {
  className?: string;
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
});

export function IconCheck({ className, size = 18 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="10" cy="10" r="8" />
      <path d="M6.5 10.2l2.4 2.4 4.6-5" />
    </svg>
  );
}

export function IconWarn({ className, size = 18 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10 2.8l7.6 13.4H2.4z" />
      <path d="M10 8v3.6M10 14.2v.1" />
    </svg>
  );
}

export function IconCross({ className, size = 18 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2.5" y="2.5" width="15" height="15" rx="2" />
      <path d="M7 7l6 6M13 7l-6 6" />
    </svg>
  );
}

export function IconClock({ className, size = 18 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="10" cy="10" r="8" />
      <path d="M10 5.5V10l3 2" />
    </svg>
  );
}

export function IconBell({ className, size = 18 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M5 13.5V9a5 5 0 0110 0v4.5l1.5 1.5h-13z" />
      <path d="M8.3 17a1.8 1.8 0 003.4 0" />
    </svg>
  );
}

export function IconPin({ className, size = 18 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10 18s5.5-5.2 5.5-9.3A5.5 5.5 0 004.5 8.7C4.5 12.8 10 18 10 18z" />
      <circle cx="10" cy="8.6" r="1.9" />
    </svg>
  );
}

export function IconHand({ className, size = 18 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 10V5.5a1.2 1.2 0 012.4 0V9M8.4 9V4a1.2 1.2 0 012.4 0v5M10.8 9V5a1.2 1.2 0 012.4 0v5.5M13.2 10.5V8a1.2 1.2 0 012.4 0v4c0 3.3-2.4 6-5.6 6-2.4 0-3.7-1.1-5-3l-2-3.2a1.2 1.2 0 012-1.3L6 12" />
    </svg>
  );
}

export function IconSpeaker({ className, size = 18, muted = false }: IconProps & { muted?: boolean }) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 7.5h3l4-3.5v12l-4-3.5H3z" />
      {muted ? <path d="M13 7.5l4 5M17 7.5l-4 5" /> : <path d="M13.2 7a4 4 0 010 6M15.4 5a7 7 0 010 10" />}
    </svg>
  );
}

/** The MedHop mark: a rounded square with a plus. Decorative; the word "MedHop" always sits next to it. */
export function IconMark({ className, size = 28 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable={false} className={className}>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="currentColor" />
      <rect x="9" y="13.5" width="14" height="5" rx="2.5" fill="#FFFFFF" />
      <rect x="13.5" y="9" width="5" height="14" rx="2.5" fill="#FFFFFF" />
    </svg>
  );
}
