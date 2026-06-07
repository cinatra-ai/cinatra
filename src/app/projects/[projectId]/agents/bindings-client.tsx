"use client";

// ---------------------------------------------------------------------------
// Project agent-template bindings UI.
//
// Single shadcn-admin Card containing the bindings list + a Bind form.
// Each row exposes:
//   - visibility selector (visible / hidden / project-private)
//   - optional pinned_version input
//   - optional default_context_overrides JSON editor (textarea; the JSON
//     parses on Save and surfaces an inline error on invalid input)
//   - Unbind button
//
// The Bind form at the bottom accepts the same fields for a new agent
// template id. All mutations route through server actions that call the
// `project_agent_template_bindings_*` MCP handlers in-process.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { toast } from "@/lib/cinatra-toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  createProjectAgentTemplateBindingAction,
  deleteProjectAgentTemplateBindingAction,
  updateProjectAgentTemplateBindingAction,
  type ProjectAgentTemplateBinding,
} from "./actions";

type Visibility = "visible" | "hidden" | "project-private";

type Props = {
  projectId: string;
  canEdit: boolean;
  bindings: ProjectAgentTemplateBinding[];
};

function parseOverridesJsonOrNull(text: string): {
  ok: true;
  value: Record<string, unknown> | null;
} | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null) return { ok: true, value: null };
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Must be a JSON object." };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Invalid JSON.",
    };
  }
}

export function ProjectAgentBindingsClient({ projectId, canEdit, bindings }: Props) {
  const [pending, startTransition] = useTransition();

  // Bind form state.
  const [newTemplateId, setNewTemplateId] = useState("");
  const [newVisibility, setNewVisibility] = useState<Visibility>("visible");
  const [newPinnedVersion, setNewPinnedVersion] = useState("");
  const [newOverridesText, setNewOverridesText] = useState("");
  const [newOverridesError, setNewOverridesError] = useState<string | null>(null);

  const onBind = () => {
    const tid = newTemplateId.trim();
    if (!tid) {
      toast.error("Enter an agent template id.");
      return;
    }
    const overrides = parseOverridesJsonOrNull(newOverridesText);
    if (!overrides.ok) {
      setNewOverridesError(overrides.error);
      return;
    }
    setNewOverridesError(null);
    const pinned = newPinnedVersion.trim() || null;
    startTransition(async () => {
      const r = await createProjectAgentTemplateBindingAction(
        projectId,
        tid,
        newVisibility,
        pinned,
        overrides.value,
      );
      if (r.ok) {
        toast.success(`Bound ${tid} to project.`);
        setNewTemplateId("");
        setNewVisibility("visible");
        setNewPinnedVersion("");
        setNewOverridesText("");
      } else {
        toast.error(`Could not bind template: ${r.error}`);
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Agent template bindings</CardTitle>
        <CardDescription>
          Pin agent templates to this project. Templates stay ambient — the
          binding curates visibility, optional version pin, and per-project
          default context overrides.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {bindings.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No agent template bindings yet.
          </p>
        ) : (
          <ul
            data-testid="project-bindings-list"
            className="flex flex-col gap-3"
          >
            {bindings.map((b) => (
              <BindingRow
                key={b.agentTemplateId}
                projectId={projectId}
                canEdit={canEdit}
                binding={b}
                pending={pending}
                startTransition={startTransition}
              />
            ))}
          </ul>
        )}

        {canEdit && (
          <div
            data-testid="project-bind-form"
            className="soft-panel flex flex-col gap-3 p-4"
          >
            <p className="text-sm font-medium text-foreground">
              Bind a new agent template
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="new-template-id">Agent template id</Label>
                <Input
                  id="new-template-id"
                  value={newTemplateId}
                  onChange={(e) => setNewTemplateId(e.target.value)}
                  placeholder="e.g. @cinatra-ai/agent-scrape"
                  disabled={pending}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="new-visibility">Visibility</Label>
                <Select
                  value={newVisibility}
                  onValueChange={(v) => setNewVisibility(v as Visibility)}
                >
                  <SelectTrigger id="new-visibility">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="visible">Visible</SelectItem>
                    <SelectItem value="hidden">Hidden</SelectItem>
                    <SelectItem value="project-private">Project-private</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="new-pinned-version">
                  Pinned version (optional)
                </Label>
                <Input
                  id="new-pinned-version"
                  value={newPinnedVersion}
                  onChange={(e) => setNewPinnedVersion(e.target.value)}
                  placeholder="e.g. 1.4.2"
                  disabled={pending}
                />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-3">
                <Label htmlFor="new-overrides">
                  Default context overrides (optional JSON object)
                </Label>
                <Textarea
                  id="new-overrides"
                  value={newOverridesText}
                  onChange={(e) => setNewOverridesText(e.target.value)}
                  placeholder='{"key": "value"}'
                  rows={3}
                  disabled={pending}
                />
                {newOverridesError && (
                  <p className="text-xs text-destructive">{newOverridesError}</p>
                )}
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={onBind}
                disabled={pending}
              >
                Bind template
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Per-row controls
// ---------------------------------------------------------------------------

type BindingRowProps = {
  projectId: string;
  canEdit: boolean;
  binding: ProjectAgentTemplateBinding;
  pending: boolean;
  startTransition: (cb: () => void) => void;
};

function BindingRow({
  projectId,
  canEdit,
  binding,
  pending,
  startTransition,
}: BindingRowProps) {
  const [visibility, setVisibility] = useState<Visibility>(binding.visibility);
  const [pinnedVersion, setPinnedVersion] = useState(binding.pinnedVersion ?? "");
  const [overridesText, setOverridesText] = useState(
    binding.defaultContextOverrides == null
      ? ""
      : JSON.stringify(binding.defaultContextOverrides, null, 2),
  );
  const [overridesError, setOverridesError] = useState<string | null>(null);

  const onSave = () => {
    const overrides = parseOverridesJsonOrNull(overridesText);
    if (!overrides.ok) {
      setOverridesError(overrides.error);
      return;
    }
    setOverridesError(null);
    startTransition(async () => {
      const r = await updateProjectAgentTemplateBindingAction(
        projectId,
        binding.agentTemplateId,
        {
          visibility,
          pinnedVersion: pinnedVersion.trim() || null,
          defaultContextOverrides: overrides.value,
        },
      );
      if (r.ok) toast.success(`Updated ${binding.agentTemplateId}.`);
      else toast.error(`Could not update binding: ${r.error}`);
    });
  };

  const onUnbind = () => {
    startTransition(async () => {
      const r = await deleteProjectAgentTemplateBindingAction(
        projectId,
        binding.agentTemplateId,
      );
      if (r.ok) toast.success(`Unbound ${binding.agentTemplateId}.`);
      else toast.error(`Could not unbind: ${r.error}`);
    });
  };

  return (
    <li className="soft-panel flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <code className="font-mono text-xs text-foreground">
            {binding.agentTemplateId}
          </code>
          <Badge variant="outline" className="capitalize">
            {binding.visibility}
          </Badge>
        </div>
        {canEdit && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onUnbind}
            disabled={pending}
          >
            Unbind
          </Button>
        )}
      </div>
      {canEdit && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`visibility-${binding.agentTemplateId}`}>
              Visibility
            </Label>
            <Select
              value={visibility}
              onValueChange={(v) => setVisibility(v as Visibility)}
            >
              <SelectTrigger id={`visibility-${binding.agentTemplateId}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="visible">Visible</SelectItem>
                <SelectItem value="hidden">Hidden</SelectItem>
                <SelectItem value="project-private">Project-private</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`pinned-${binding.agentTemplateId}`}>
              Pinned version (optional)
            </Label>
            <Input
              id={`pinned-${binding.agentTemplateId}`}
              value={pinnedVersion}
              onChange={(e) => setPinnedVersion(e.target.value)}
              placeholder="e.g. 1.4.2"
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label htmlFor={`overrides-${binding.agentTemplateId}`}>
              Default context overrides (optional JSON object)
            </Label>
            <Textarea
              id={`overrides-${binding.agentTemplateId}`}
              value={overridesText}
              onChange={(e) => setOverridesText(e.target.value)}
              rows={3}
              disabled={pending}
            />
            {overridesError && (
              <p className="text-xs text-destructive">{overridesError}</p>
            )}
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSave}
              disabled={pending}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
