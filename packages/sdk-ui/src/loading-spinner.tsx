type LoadingSpinnerProps = {
  className?: string;
};

export function LoadingSpinner({ className = "h-6 w-6 text-foreground" }: LoadingSpinnerProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`animate-spin ${className}`}>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M20.5 12A8.5 8.5 0 0 0 12 3.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * THE SPINNER OF Components § Skeleton / Spinner, in its own words: "Spinner:
 * indigo arc · 1s linear".
 *
 * ONE ARC, AND NOTHING BEHIND IT. `LoadingSpinner` above draws an arc over a
 * 25%-opacity track ring; that is a different mark, it keeps every caller it
 * has, and it is not what the drawing draws for a card that is waiting. The path
 * here is the ratified drawing's own, character for character, at the anchors
 * `run-progress-placeholder` (Agent run & review) and
 * `run-progress-placeholder-in-thread` (Lifecycle cards § I).
 *
 * The caller sets the size and the colour; the accent token is the indigo the
 * drawing names.
 */
export function SpinnerArc({ className = "size-[22px] text-primary" }: LoadingSpinnerProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={`animate-spin ${className}`}
    >
      <path
        d="M21 12a9 9 0 1 1-6.219-8.56"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
