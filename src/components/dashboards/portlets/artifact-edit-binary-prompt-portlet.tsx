"use client";

// PORT-06 artifact-edit-binary-prompt portlet. Read-only baseline preview of
// the parent object's current binary artifact + the configured generation
// mode. Interactive prompt-driven regeneration is deferred to a follow-up,
// where the concrete (blog-specific) binary-generation primitive is composed
// into the blog dashboard.
import { useEffect, useState, useTransition } from "react";
import { loadArtifactBaselinePortlet, type PortletArtifactBaseline } from "@/lib/dashboards/portlet-loaders";
import type { PortletComponentProps } from "./types";

export function ArtifactEditBinaryPromptPortlet({ config, inputs }: PortletComponentProps) {
  const parentObjectField = typeof config.parentObjectField === "string" ? config.parentObjectField : "";
  const refSwapMode = config.refSwapMode === "auto" || config.refSwapMode === "manual" ? config.refSwapMode : null;
  const objectId = typeof inputs.parentObjectId === "string" ? inputs.parentObjectId : null;
  const [baseline, setBaseline] = useState<PortletArtifactBaseline | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!objectId || !parentObjectField) {
      setBaseline(null);
      return;
    }
    start(async () => setBaseline(await loadArtifactBaselinePortlet({ objectId, parentObjectField })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId, parentObjectField]);

  if (!parentObjectField || !refSwapMode) {
    return <p className="text-sm text-muted-foreground">Misconfigured: missing binary-prompt config.</p>;
  }
  if (!objectId) return <p className="text-sm text-muted-foreground">Select an item to preview its image.</p>;
  if (pending) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="flex flex-col gap-2">
      {baseline ? (
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-sm text-foreground">{baseline.title ?? baseline.artifactId}</span>
          <span className="font-mono text-xs text-muted-foreground">{baseline.mime}</span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No current representation.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Prompt-driven regeneration ({refSwapMode}) is available in the blog dashboard.
      </p>
    </div>
  );
}
