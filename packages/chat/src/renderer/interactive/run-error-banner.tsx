"use client";

// ---------------------------------------------------------------------------
// Run-error banner (cinatra#1311 — AG-UI interactive layer).
// ---------------------------------------------------------------------------
// Renders the human-readable error a RUN_ERROR produced (the reducer stored the
// normalized `message.error` via `extractErrorMessage`). Empty/undefined error
// renders nothing. Mirrors the bespoke chat error surface.

export function RunErrorBanner({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="my-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-foreground"
      data-run-error
    >
      {error}
    </div>
  );
}
