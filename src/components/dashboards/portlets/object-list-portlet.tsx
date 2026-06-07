"use client";

// PORT-02 object-list portlet. Lists objects of config.typeId (optionally filtered
// to children of the resolved parentId input) via the session-scoped server loader,
// and emits `selectedId` on click. Scope is enforced server-side (the loader takes
// no tenant override). When the parent selection changes, the local selection is
// cleared + an explicit null is emitted so stale child portlets invalidate.
import { useEffect, useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { loadObjectListPortlet, type PortletObjectSummary } from "@/lib/dashboards/portlet-loaders";
import type { PortletComponentProps } from "./types";

export function ObjectListPortlet({ config, inputs, boundInputs, onOutput }: PortletComponentProps) {
  const typeId = typeof config.typeId === "string" ? config.typeId : "";
  const parentId = typeof inputs.parentId === "string" ? inputs.parentId : null;
  // A parentId BINDING present but unresolved (null) = "no parent selected yet" →
  // show empty (never broaden). No binding = top-level list (list all).
  const requireParent = boundInputs.includes("parentId");
  const awaitingParent = requireParent && !parentId;
  const [items, setItems] = useState<PortletObjectSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // When the parent selection changes, clear our selection + invalidate downstream.
  useEffect(() => {
    setSelected(null);
    onOutput({ selectedId: null });
    // onOutput intentionally omitted from deps (new closure each render); this runs
    // only on parentId change, which is the invalidation trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId]);

  useEffect(() => {
    if (!typeId) return;
    if (awaitingParent) {
      setItems([]);
      return;
    }
    start(async () => {
      const rows = await loadObjectListPortlet({ typeId, parentId, requireParent });
      setItems(rows);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId, parentId, requireParent, awaitingParent]);

  if (!typeId) return <p className="text-sm text-muted-foreground">Misconfigured: no typeId.</p>;
  if (awaitingParent) return <p className="text-sm text-muted-foreground">Select a parent item first.</p>;

  return (
    <div className="flex flex-col gap-1">
      {pending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!pending && items.length === 0 && <p className="text-sm text-muted-foreground">No items.</p>}
      {items.map((it) => (
        <Button
          key={it.id}
          type="button"
          variant="ghost"
          onClick={() => {
            setSelected(it.id);
            onOutput({ selectedId: it.id });
          }}
          className={cn("h-auto justify-start px-3 py-2 text-left text-sm font-normal", selected === it.id && "bg-surface-muted text-foreground")}
        >
          {it.label}
        </Button>
      ))}
    </div>
  );
}
