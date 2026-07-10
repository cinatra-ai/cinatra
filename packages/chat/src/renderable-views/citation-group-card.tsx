// ---------------------------------------------------------------------------
// citation_group renderer (cinatra#1220, S4).
//
// Renders a citations / source panel. Each source `url` was scheme-allowlisted
// at the schema layer. Titles/snippets are React text nodes (inert).
// ---------------------------------------------------------------------------

import Link from "next/link";

import type { CitationGroupView } from "@cinatra-ai/agent-ui-protocol/renderable-views";

export function CitationGroupCard({ view }: { view: CitationGroupView }) {
  return (
    <div
      className="my-3 rounded-lg border border-line bg-surface-muted p-3"
      data-view-type="citation_group"
    >
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {view.label ?? "Sources"}
      </div>
      <ol className="flex flex-col gap-2">
        {view.sources.map((s, i) => (
          <li key={i} className="text-sm">
            <div className="font-medium text-foreground">
              {s.url ? (
                <Link
                  href={s.url}
                  className="underline decoration-line hover:text-foreground"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {s.title}
                </Link>
              ) : (
                s.title
              )}
            </div>
            {s.snippet && (
              <div className="text-xs text-muted-foreground">{s.snippet}</div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
