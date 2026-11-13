// The only icon module. One icon is left: the disclosure chevron. States are words with a round mark (styles.css
// .state and .dot), so the pages need no status icons.

interface IconProps {
  className?: string;
  size?: number;
}

/** Disclosure arrow, pointing right; CSS turns it 90 degrees when the owning control has aria-expanded="true". */
export function IconChevron({ className, size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <path d="M9 5.5 15.5 12 9 18.5" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}
