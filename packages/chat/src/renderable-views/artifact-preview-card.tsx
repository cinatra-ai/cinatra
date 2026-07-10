// ---------------------------------------------------------------------------
// artifact_preview renderer (cinatra#1220, S4).
//
// Renders a file/artifact preview. `href` was scheme-allowlisted at the schema
// layer, so it is either a safe URL or undefined; an undefined href renders as
// an inert (non-link) row. All text is rendered as React text nodes.
// ---------------------------------------------------------------------------

import Link from "next/link";

import type { ArtifactPreviewView } from "@cinatra-ai/agent-ui-protocol/renderable-views";

function formatSize(bytes?: number): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

export function ArtifactPreviewCard({ view }: { view: ArtifactPreviewView }) {
  const size = formatSize(view.sizeBytes);
  const meta = [view.mimeType, size].filter(Boolean).join(" · ");

  return (
    <div
      className="my-3 flex items-center gap-3 rounded-lg border border-line bg-surface p-3"
      data-view-type="artifact_preview"
    >
      <div className="flex flex-col gap-0.5 overflow-hidden">
        <div className="truncate text-sm font-medium text-foreground">
          {view.href ? (
            <Link
              href={view.href}
              className="underline decoration-line hover:text-foreground"
              rel="noopener noreferrer"
              target="_blank"
            >
              {view.name}
            </Link>
          ) : (
            view.name
          )}
        </div>
        {meta && <div className="text-xs text-muted-foreground">{meta}</div>}
        {view.description && (
          <div className="text-xs text-muted-foreground">{view.description}</div>
        )}
      </div>
    </div>
  );
}
