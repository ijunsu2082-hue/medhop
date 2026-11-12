// Inline SVG icons used only on the Pilot page. Always paired with text.

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
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
});

/** Disclosure arrow; CSS turns it when the owning button has aria-expanded="true". */
export function IconChevron({ className, size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7 4.5l5.5 5.5L7 15.5" />
    </svg>
  );
}

/** Station sign: a square marker with a filled corner. */
export function IconSign({ className, size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3.5" y="3.5" width="13" height="13" rx="1.5" />
      <rect x="6.5" y="6.5" width="3.5" height="3.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
