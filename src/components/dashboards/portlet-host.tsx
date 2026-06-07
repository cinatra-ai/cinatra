"use client";

// Client PortletHost. Owns the kind→component map + the dashboard's
// selection/output state, and resolves each portlet's input bindings before
// rendering its component. Registered kinds without a built component (and
// unknown kinds) fall back to a structured placeholder. Scope is enforced
// server-side by each portlet's loader — the host only passes config + resolved
// selection values.
import { useState, type ComponentType } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import type { PortletComponentProps } from "./portlets/types";
import { ObjectListPortlet } from "./portlets/object-list-portlet";
import { ObjectDetailPortlet } from "./portlets/object-detail-portlet";
import { ArtifactListPortlet } from "./portlets/artifact-list-portlet";
import { ObjectVersionHistoryPortlet } from "./portlets/object-version-history-portlet";
import { ArtifactEditTextPortlet } from "./portlets/artifact-edit-text-portlet";
import { ArtifactEditBinaryPromptPortlet } from "./portlets/artifact-edit-binary-prompt-portlet";
import { WorkflowLauncherPortlet } from "./portlets/workflow-launcher-portlet";
import { AgentLauncherPortlet } from "./portlets/agent-launcher-portlet";
import { WorkflowStatusPortlet } from "./portlets/workflow-status-portlet";

const COMPONENT_MAP: Record<string, ComponentType<PortletComponentProps>> = {
  "object-list": ObjectListPortlet,
  "object-detail": ObjectDetailPortlet,
  "artifact-list": ArtifactListPortlet,
  "artifact-version-history": ObjectVersionHistoryPortlet,
  "artifact-edit-text": ArtifactEditTextPortlet,
  "artifact-edit-binary-prompt": ArtifactEditBinaryPromptPortlet,
  "workflow-launcher": WorkflowLauncherPortlet,
  "agent-launcher": AgentLauncherPortlet,
  "workflow-status": WorkflowStatusPortlet,
};

type Binding = { fromInstanceId: string; key: string } | { fromDashboard: string };

export type PortletInstanceProp = {
  readonly instanceId: string;
  readonly kind: string;
  readonly version: string;
  readonly slot: string;
  readonly config: Record<string, unknown>;
  readonly inputs?: Record<string, Binding>;
  readonly outputs?: readonly string[];
};

export function PortletHost({
  portlets,
  rowContext,
}: {
  portlets: readonly PortletInstanceProp[];
  rowContext: Record<string, unknown>;
}) {
  // selection[instanceId][outputKey] = value (null = cleared, invalidates downstream)
  const [selection, setSelection] = useState<Record<string, Record<string, string | null>>>({});

  function resolveInputs(p: PortletInstanceProp): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, binding] of Object.entries(p.inputs ?? {})) {
      if ("fromInstanceId" in binding) {
        out[key] = selection[binding.fromInstanceId]?.[binding.key];
      } else {
        out[key] = rowContext[binding.fromDashboard];
      }
    }
    return out;
  }

  return (
    <div className="flex flex-col gap-4">
      {portlets.map((p) => {
        const Comp = COMPONENT_MAP[p.kind];
        return (
          <Card key={p.instanceId} className="border-line bg-surface backdrop-blur-none">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base">{p.instanceId}</CardTitle>
                <span className="font-mono text-xs text-muted-foreground">
                  {p.kind}@{p.version}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              {Comp ? (
                <Comp
                  instanceId={p.instanceId}
                  config={p.config}
                  inputs={resolveInputs(p)}
                  boundInputs={Object.keys(p.inputs ?? {})}
                  rowContext={rowContext}
                  onOutput={(o) =>
                    setSelection((s) => ({ ...s, [p.instanceId]: { ...s[p.instanceId], ...o } }))
                  }
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Portlet kind <span className="font-mono">{p.kind}</span> is not yet available.
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
