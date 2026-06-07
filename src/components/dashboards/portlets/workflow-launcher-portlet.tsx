"use client";

// Workflow-launcher portlet. Resolves the configured templateKey to a
// template, renders a typed picker per placeholder hint (blog-project /
// blog-post → object-list picker; wordpress-instance → secrets-stripped
// WordPress instance picker; no hint → free-text), and instantiates the
// workflow project-write-gated server-side. Picker state wins over upstream
// prefill via a dirty-field overlay — an earlier useEffect-seed missed inputs
// that arrived AFTER template load.
//
// Scope axes:
//   - workflow-row projectId ← rowContext.projectId (the Cinatra project).
//   - placeholder prefills ← `inputs[placeholderName]` (selection chain).
//   - Operator edits add to `dirty` → those fields stay user-controlled.
import { useEffect, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  loadWorkflowLauncherTemplate,
  launchWorkflowAction,
  loadWordpressInstanceOptions,
  type WorkflowLauncherTemplate,
  type PortletPickerOption,
} from "@/lib/dashboards/portlet-actions";
import { loadObjectListPortlet } from "@/lib/dashboards/portlet-loaders";
import { computeLauncherValues } from "./launcher-values";
import type { PortletComponentProps } from "./types";

// Hint-kind registry: kind → option resolver. Server-loader-backed.
type OptionsResolver = () => Promise<PortletPickerOption[]>;
const HINT_RESOLVERS: Record<string, OptionsResolver> = {
  "blog-project": async () =>
    (await loadObjectListPortlet({ typeId: "@cinatra-ai/assets:blog-project" })).map((r) => ({ id: r.id, label: r.label })),
  "blog-post": async () =>
    (await loadObjectListPortlet({ typeId: "@cinatra-ai/assets:blog-post" })).map((r) => ({ id: r.id, label: r.label })),
  "wordpress-instance": loadWordpressInstanceOptions,
};

function PlaceholderField({
  name,
  hintKind,
  value,
  onChange,
}: {
  name: string;
  hintKind: string | undefined;
  value: string;
  onChange: (v: string) => void;
}) {
  const resolver = hintKind ? HINT_RESOLVERS[hintKind] : undefined;
  const [options, setOptions] = useState<PortletPickerOption[] | null>(null);
  useEffect(() => {
    if (!resolver) return;
    resolver().then(setOptions).catch(() => setOptions([]));
  }, [resolver]);

  if (!resolver) {
    return <Input id={`wf-ph-${name}`} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  if (options === null) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger id={`wf-ph-${name}`}>
        <SelectValue placeholder={`Select ${name}…`} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function WorkflowLauncherPortlet({ config, inputs, rowContext, onOutput }: PortletComponentProps) {
  const templateKey = typeof config.templateKey === "string" ? config.templateKey : "";
  const templateVersion = typeof config.templateVersion === "string" ? config.templateVersion : undefined;
  // workflow-row projectId — the dashboard's Cinatra project. Distinct from a
  // BPMN placeholder also named "projectId" (which holds the blog-domain id).
  const workflowRowProjectId = typeof rowContext.projectId === "string" ? rowContext.projectId : undefined;

  const [tmpl, setTmpl] = useState<WorkflowLauncherTemplate | null>(null);
  const [overlay, setOverlay] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const [launching, startLaunch] = useTransition();

  useEffect(() => {
    if (!templateKey) return;
    startLoad(async () => setTmpl(await loadWorkflowLauncherTemplate({ templateKey, templateVersion })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateKey, templateVersion]);

  const placeholderKeys = useMemo(() => Object.keys(tmpl?.placeholders ?? {}), [tmpl]);
  // Effective values DERIVE from upstream inputs + the dirty-field overlay so
  // late-arriving selections seed automatically and operator edits stick.
  const values = useMemo(() => computeLauncherValues(placeholderKeys, inputs, dirty, overlay), [placeholderKeys, inputs, dirty, overlay]);

  if (!templateKey) return <p className="text-sm text-muted-foreground">Misconfigured: no templateKey.</p>;
  if (loading) return <p className="text-sm text-muted-foreground">Loading template…</p>;
  if (!tmpl) return <p className="text-sm text-muted-foreground">Template not found or not accessible.</p>;

  const placeholderHints =
    (tmpl.metadata as { placeholderHints?: Record<string, { kind?: string }> })?.placeholderHints ?? {};

  function handleEdit(name: string, v: string) {
    setDirty((d) => {
      if (d.has(name)) return d;
      const next = new Set(d);
      next.add(name);
      return next;
    });
    setOverlay((o) => ({ ...o, [name]: v }));
  }

  function handleLaunch() {
    setError(null);
    setWorkflowId(null);
    startLaunch(async () => {
      const res = await launchWorkflowAction({
        templateId: tmpl!.templateId,
        projectId: workflowRowProjectId,
        inputs: values,
        name: tmpl!.name,
      });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setWorkflowId(res.workflowId);
      onOutput({ workflowId: res.workflowId });
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-foreground">{tmpl.name}</p>
      {placeholderKeys.map((name) => (
        <div key={name} className="flex flex-col gap-1">
          <Label htmlFor={`wf-ph-${name}`} className="text-xs">
            {name}
          </Label>
          <PlaceholderField
            name={name}
            hintKind={placeholderHints[name]?.kind}
            value={values[name] ?? ""}
            onChange={(v) => handleEdit(name, v)}
          />
        </div>
      ))}
      <div className="flex items-center justify-between gap-3">
        <Button type="button" onClick={handleLaunch} disabled={launching}>
          {launching ? "Launching…" : "Launch workflow"}
        </Button>
        {workflowId ? (
          <a href={`/workflows/${workflowId}`} className="text-sm text-primary underline">
            View workflow
          </a>
        ) : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
