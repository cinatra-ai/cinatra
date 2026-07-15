"use client";

// Entity-count portlet (cinatra#702). A RENDER-ONLY presentation building block
// for an entity's Overview: a row of count / stat tiles (big value + label)
// rendered straight from `config.items`. Same contract as the entity-metadata
// portlet — zero server read (`resource: "none"`), no drizzle-cube/client
// (Layer-4 clean), and never persisted (the mutation service rejects
// render-only kinds), so a saved row can never serve a stale count.
import type { PortletComponentProps } from "./types";
import { readSummaryItems, readSummaryTitle } from "./summary-items";

export function EntityCountPortlet({ config }: PortletComponentProps) {
  const title = readSummaryTitle(config);
  const items = readSummaryItems(config);
  return (
    <div className="flex flex-col gap-3">
      {title && <h3 className="text-sm font-semibold text-foreground">{title}</h3>}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No counts to show.</p>
      ) : (
        <div className="flex flex-wrap gap-6">
          {items.map((item, i) => (
            <div key={`${item.label}-${i}`} className="flex min-w-20 flex-col gap-1">
              <span className="text-2xl font-semibold tabular-nums text-foreground">{String(item.value)}</span>
              <span className="text-xs text-muted-foreground">{item.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
