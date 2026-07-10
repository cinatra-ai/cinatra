"use client";

// ---------------------------------------------------------------------------
// Citation list (cinatra#1311 — AG-UI interactive layer).
// ---------------------------------------------------------------------------
// Renders the merged `UiCitation[]` a run produced (from DATA_PART citation
// payloads, deduped by url in the reducer). Numbered, external links open in a
// new tab with `rel="noopener noreferrer"`. Empty list renders nothing. Mirrors
// the bespoke chat sources panel; token-driven, no per-surface CSS.

import type { UiCitation } from "../../types";

export function CitationList({ citations }: { citations: UiCitation[] }) {
  if (citations.length === 0) return null;
  return (
    <div
      className="my-3 rounded-lg border border-line bg-surface-muted p-3"
      data-citation-list
    >
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Sources
      </div>
      <ol className="flex flex-col gap-1.5">
        {citations.map((c) => (
          <li key={`${c.index}:${c.url}`} className="flex gap-2 text-sm">
            <span className="text-muted-foreground">{c.index}.</span>
            <a
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline decoration-line hover:text-foreground"
            >
              {c.title || c.url}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
