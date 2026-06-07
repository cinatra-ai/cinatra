"use client";

// PORT-03 object-detail portlet. Read-only detail for the selected object id
// (resolved from a binding). Empty state when no selection. Scope + read authz
// enforced server-side by the loader.
import { useEffect, useState, useTransition } from "react";
import { loadObjectDetailPortlet, type PortletObjectDetail } from "@/lib/dashboards/portlet-loaders";
import type { PortletComponentProps } from "./types";

export function ObjectDetailPortlet({ inputs }: PortletComponentProps) {
  const objectId = typeof inputs.objectId === "string" ? inputs.objectId : null;
  const [detail, setDetail] = useState<PortletObjectDetail | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!objectId) {
      setDetail(null);
      return;
    }
    start(async () => {
      const d = await loadObjectDetailPortlet({ objectId });
      setDetail(d);
    });
  }, [objectId]);

  if (!objectId) return <p className="text-sm text-muted-foreground">Select an item to see its details.</p>;
  if (pending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!detail) return <p className="text-sm text-muted-foreground">Not found or not accessible.</p>;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-foreground">{detail.label}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {detail.fields.map((f) => (
          <div key={f.key} className="contents">
            <dt className="font-mono text-xs text-muted-foreground">{f.key}</dt>
            <dd className="text-sm text-foreground">{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
