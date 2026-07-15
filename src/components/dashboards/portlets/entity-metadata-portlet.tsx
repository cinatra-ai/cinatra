"use client";

// Entity-metadata portlet (cinatra#702). A RENDER-ONLY presentation building
// block for an entity's Overview: a labeled identity / metadata definition list
// rendered straight from `config.items` (composed server-side by the surface
// from data the actor may already see). Does ZERO server read (the kind's
// scopePolicy is `resource: "none"`) and imports NO drizzle-cube/client — the
// Layer-4 boundary is respected trivially. Its config is never persisted (the
// mutation service rejects render-only kinds), so it can never serve a stale or
// authorization-obsolete value from a saved row.
import type { PortletComponentProps } from "./types";
import { readSummaryItems, readSummaryTitle } from "./summary-items";

export function EntityMetadataPortlet({ config }: PortletComponentProps) {
  const title = readSummaryTitle(config);
  const items = readSummaryItems(config);
  return (
    <div className="flex flex-col gap-3">
      {title && <h3 className="text-sm font-semibold text-foreground">{title}</h3>}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No details to show.</p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          {items.map((item, i) => (
            <div key={`${item.label}-${i}`} className="contents">
              <dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
              <dd className="text-sm text-foreground">{String(item.value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
