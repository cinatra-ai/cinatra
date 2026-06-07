"use client";

// PORT-04 artifact-list portlet. Lists artifact rows eligible for
// config.extensionPackageName via the session-scoped server loader; emits
// `selectedArtifactId` on click. Scope enforced server-side.
import { useEffect, useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { loadArtifactListPortlet, type PortletObjectSummary } from "@/lib/dashboards/portlet-loaders";
import type { PortletComponentProps } from "./types";

export function ArtifactListPortlet({ config, onOutput }: PortletComponentProps) {
  const extensionPackageName = typeof config.extensionPackageName === "string" ? config.extensionPackageName : "";
  const [items, setItems] = useState<PortletObjectSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!extensionPackageName) return;
    start(async () => setItems(await loadArtifactListPortlet({ extensionPackageName })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensionPackageName]);

  if (!extensionPackageName) return <p className="text-sm text-muted-foreground">Misconfigured: no extensionPackageName.</p>;

  return (
    <div className="flex flex-col gap-1">
      {pending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!pending && items.length === 0 && <p className="text-sm text-muted-foreground">No artifacts.</p>}
      {items.map((it) => (
        <Button
          key={it.id}
          type="button"
          variant="ghost"
          onClick={() => {
            setSelected(it.id);
            onOutput({ selectedArtifactId: it.id });
          }}
          className={cn("h-auto justify-start px-3 py-2 text-left text-sm font-normal", selected === it.id && "bg-surface-muted text-foreground")}
        >
          {it.label}
        </Button>
      ))}
    </div>
  );
}
