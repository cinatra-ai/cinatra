"use client";

// ---------------------------------------------------------------------------
// Project agent-template bindings UI.
//
// Single shadcn-admin Card containing the bindings list + a Bind panel
// (cinatra#1503 / design cinatra#1509 §4.4):
//   - bound rows render name-first (resolved template display name, raw id
//     demoted to a font-mono secondary; "Unknown template" fallback — never
//     id-only),
//   - the Bind panel mounts the shared EntitySearchCombobox over the
//     server-listed installed-template catalog (client-side filtering via the
//     pure filterBindableTemplates; already-bound ids are excluded
//     server-side AND client-side), with an "Enter ID manually" advanced
//     toggle preserving the raw-id path for unlisted/remote templates,
//   - the empty state uses the ui/empty kit with a primary "Add agent"
//     action opening the bind panel (shared with the PageHeader action via
//     BindPanelProvider),
//   - "Create new agent" links to the canonical /chat?mode=create-agent flow;
//     returning with ?bindTemplate=<id> preselects the template for ONE
//     explicit Bind click (cross-flow auto-binding is owner-gated — design
//     Open Decision 2 — and deliberately NOT implemented),
//   - read-only viewers keep the list plus one explanatory sentence.
//
// Each bound row exposes:
//   - visibility selector (visible / hidden / project-private)
//   - optional pinned_version input
//   - optional default_context_overrides JSON editor (textarea; the JSON
//     parses on Save and surfaces an inline error on invalid input)
//   - Unbind button
//
// All mutations route through server actions that call the
// `project_agent_template_bindings_*` MCP handlers in-process.
// ---------------------------------------------------------------------------

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Plus } from "lucide-react";
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EntitySearchCombobox,
  type EntitySearchItem,
} from "@/components/entity-search-combobox";
import { resolveScopeEntityName } from "@/components/access-scope";

import {
  createProjectAgentTemplateBindingAction,
  deleteProjectAgentTemplateBindingAction,
  listBindableAgentTemplatesAction,
  updateProjectAgentTemplateBindingAction,
  type ProjectAgentTemplateBinding,
} from "./actions";
import {
  filterBindableTemplates,
  type BindableAgentTemplate,
} from "./bindable-templates";
import { useBindPanel } from "./bind-panel-context";

type Visibility = "visible" | "hidden" | "project-private";

/** Binding enriched server-side (page.tsx) with the resolved template display
 *  name — null when the bound id is not in the installed catalog. */
export type ProjectAgentTemplateBindingView = ProjectAgentTemplateBinding & {
  templateName: string | null;
};

type Props = {
  projectId: string;
  canEdit: boolean;
  bindings: ProjectAgentTemplateBindingView[];
  /** Preselected template from the ?bindTemplate=<id> deep link (§4.4
   *  return/preselect — one explicit Bind click, never an auto-bind). */
  initialTemplate?: { id: string; name: string | null } | null;
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

export function ProjectAgentBindingsClient({
  projectId,
  canEdit,
  bindings,
  initialTemplate = null,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { open: bindOpen, openPanel } = useBindPanel();

  // Bind form state. The picker is the primary path; `manualMode` reveals the
  // raw-id Input (advanced escape hatch — template ids are legitimately an
  // open set, so unlisted/remote ids stay bindable).
  const [manualMode, setManualMode] = useState(false);
  const [manualTemplateId, setManualTemplateId] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<{
    id: string;
    name: string | null;
  } | null>(initialTemplate);
  const [newVisibility, setNewVisibility] = useState<Visibility>("visible");
  const [newPinnedVersion, setNewPinnedVersion] = useState("");
  const [newOverridesText, setNewOverridesText] = useState("");
  const [newOverridesError, setNewOverridesError] = useState<string | null>(null);

  // Server-listed candidate catalog, fetched once per open (empty query) and
  // filtered client-side per keystroke (§4.4 — client-side filtering is fine
  // at catalog scale; the candidates themselves stay server-listed).
  const templatesCacheRef = useRef<BindableAgentTemplate[] | null>(null);
  const searchTemplates = async (query: string) => {
    if (query.trim().length === 0 || templatesCacheRef.current === null) {
      const r = await listBindableAgentTemplatesAction(projectId);
      if (!r.ok) throw new Error(r.error);
      templatesCacheRef.current = r.items;
    }
    return {
      results: filterBindableTemplates(templatesCacheRef.current, query).map(
        (t): EntitySearchItem => ({
          id: t.agentTemplateId,
          name: t.humanReadableName,
          secondary: t.description,
        }),
      ),
    };
  };

  const onBind = () => {
    const tid = (manualMode ? manualTemplateId : selectedTemplate?.id ?? "").trim();
    if (!tid) {
      toast.error(
        manualMode
          ? "Enter an agent template id."
          : "Choose an agent template to bind.",
      );
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
        setManualTemplateId("");
        setSelectedTemplate(null);
        setNewVisibility("visible");
        setNewPinnedVersion("");
        setNewOverridesText("");
        templatesCacheRef.current = null; // the bound id left the candidate set
        router.refresh(); // surface the new row / re-derive candidates
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
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Bot />
              </EmptyMedia>
              <EmptyTitle>No agents bound yet</EmptyTitle>
              <EmptyDescription>
                Bind an installed agent template to curate which agents appear
                in this project, pin a version, and set per-project context
                overrides.
              </EmptyDescription>
            </EmptyHeader>
            {canEdit && !bindOpen && (
              <EmptyContent>
                <Button type="button" onClick={openPanel}>
                  <Plus data-icon="inline-start" />
                  Add agent
                </Button>
              </EmptyContent>
            )}
          </Empty>
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
                onMutated={() => {
                  templatesCacheRef.current = null;
                  router.refresh();
                }}
              />
            ))}
          </ul>
        )}

        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            Only project owners/admins can manage agent bindings — ask a
            project admin for access.
          </p>
        )}

        {canEdit && bindOpen && (
          <div
            data-testid="project-bind-form"
            className="soft-panel flex flex-col gap-3 p-4"
          >
            <p className="text-sm font-medium text-foreground">
              Bind a new agent template
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1 sm:col-span-2">
                {manualMode ? (
                  <>
                    <Label htmlFor="new-template-id">Agent template id</Label>
                    <Input
                      id="new-template-id"
                      value={manualTemplateId}
                      onChange={(e) => setManualTemplateId(e.target.value)}
                      placeholder="e.g. @cinatra-ai/agent-scrape"
                      disabled={pending}
                    />
                  </>
                ) : (
                  <>
                    <Label htmlFor="new-template-search">Agent template</Label>
                    <EntitySearchCombobox
                      id="new-template-search"
                      placeholder="Search installed agent templates…"
                      emptyText="No installed templates match."
                      onSearch={searchTemplates}
                      onPick={(item) =>
                        setSelectedTemplate({ id: item.id, name: item.name })
                      }
                      excludeIds={bindings.map((b) => b.agentTemplateId)}
                      renderRow={(item) => (
                        <span className="flex min-w-0 flex-col">
                          <span className="flex items-baseline gap-2">
                            <span className="text-foreground">{item.name}</span>
                            <span className="truncate font-mono text-xs text-muted-foreground">
                              {item.id}
                            </span>
                          </span>
                          {item.secondary ? (
                            <span className="truncate text-xs text-muted-foreground">
                              {item.secondary}
                            </span>
                          ) : null}
                        </span>
                      )}
                      disabled={pending}
                    />
                    {selectedTemplate && (
                      <p
                        data-testid="selected-template"
                        className="text-xs text-muted-foreground"
                      >
                        Selected:{" "}
                        <span className="text-foreground">
                          {resolveScopeEntityName(
                            "template",
                            selectedTemplate.id,
                            selectedTemplate.name,
                          )}
                        </span>{" "}
                        <span className="font-mono">{selectedTemplate.id}</span>
                      </p>
                    )}
                  </>
                )}
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto self-start px-0 text-xs"
                    onClick={() => setManualMode((m) => !m)}
                    disabled={pending}
                  >
                    {manualMode
                      ? "Choose from installed templates"
                      : "Enter ID manually"}
                  </Button>
                  <Link
                    href="/chat?mode=create-agent"
                    className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  >
                    Create new agent
                  </Link>
                </div>
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
                disabled={
                  pending || (manualMode ? !manualTemplateId.trim() : !selectedTemplate)
                }
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
  binding: ProjectAgentTemplateBindingView;
  pending: boolean;
  startTransition: (cb: () => void) => void;
  /** Called after a successful update/unbind so the parent can refresh the
   *  server-derived list + candidate cache. */
  onMutated: () => void;
};

function BindingRow({
  projectId,
  canEdit,
  binding,
  pending,
  startTransition,
  onMutated,
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
      if (r.ok) {
        toast.success(`Updated ${binding.agentTemplateId}.`);
        onMutated();
      } else {
        toast.error(`Could not update binding: ${r.error}`);
      }
    });
  };

  const onUnbind = () => {
    startTransition(async () => {
      const r = await deleteProjectAgentTemplateBindingAction(
        projectId,
        binding.agentTemplateId,
      );
      if (r.ok) {
        toast.success(`Unbound ${binding.agentTemplateId}.`);
        onMutated();
      } else {
        toast.error(`Could not unbind: ${r.error}`);
      }
    });
  };

  return (
    <li className="soft-panel flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        {/* Name-first, id-secondary (§3.2): the resolved template display
            name leads; the raw id is demoted to font-mono secondary. An
            unresolvable id reads "Unknown template" — never id-only. */}
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {resolveScopeEntityName(
              "template",
              binding.agentTemplateId,
              binding.templateName,
            )}
          </span>
          <code className="shrink-0 font-mono text-xs text-muted-foreground">
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
