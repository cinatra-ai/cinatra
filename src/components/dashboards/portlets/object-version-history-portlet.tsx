"use client";

// PORT-07 artifact-version-history portlet. Read-only ref-swap timeline for the
// parent object's configured `parentObjectField` (resolved from the
// `parentObjectId` input). Scope + read authz enforced server-side by the loader;
// only events that CHANGED the field (plus the create event) are returned.
import { useEffect, useState, useTransition } from "react";
import {
  loadObjectVersionHistoryPortlet,
  type PortletHistoryEvent,
} from "@/lib/dashboards/portlet-loaders";
import type { PortletComponentProps } from "./types";

function formatTimestamp(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function ObjectVersionHistoryPortlet({ config, inputs }: PortletComponentProps) {
  const parentObjectField = typeof config.parentObjectField === "string" ? config.parentObjectField : "";
  const objectId = typeof inputs.parentObjectId === "string" ? inputs.parentObjectId : null;
  const [events, setEvents] = useState<PortletHistoryEvent[]>([]);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!objectId || !parentObjectField) {
      setEvents([]);
      return;
    }
    start(async () => {
      setEvents(await loadObjectVersionHistoryPortlet({ objectId, parentObjectField }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId, parentObjectField]);

  if (!parentObjectField) return <p className="text-sm text-muted-foreground">Misconfigured: no parentObjectField.</p>;
  if (!objectId) return <p className="text-sm text-muted-foreground">Select an item to see its version history.</p>;
  if (pending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No version history.</p>;

  return (
    <ol className="flex flex-col gap-2">
      {events.map((e) => (
        <li key={e.changeSetId} className="flex items-baseline justify-between gap-3 border-b border-line pb-2 last:border-b-0">
          <div className="min-w-0">
            <span className="text-sm font-medium capitalize text-foreground">{e.operation}</span>
            {e.fieldValue ? (
              <span className="ml-2 truncate font-mono text-xs text-muted-foreground">{e.fieldValue}</span>
            ) : null}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatTimestamp(e.createdAt)} · {e.actorKind}
          </span>
        </li>
      ))}
    </ol>
  );
}
