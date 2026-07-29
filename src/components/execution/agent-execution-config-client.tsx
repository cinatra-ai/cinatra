"use client";

// The per-agent execution-config editor (exec-plane S3 slice B, cinatra#1708;
// epic #1705) — the interactive half of the §V settings "Execution" section.
//
// Presentational + local state only: the view model arrives fully resolved and
// the save action is injected, so this component never decides authority,
// validity, or dormancy — it renders them. What it DOES own:
//
//   - the tri-state posture control (inherit / on / off),
//   - the three per-manager entry boxes (one package per line),
//   - "start from a template" (a pure client-side prefill of those boxes —
//     nothing is stored until the human saves),
//   - the promotion affordance's one-click "add to the declared environment",
//     which likewise only PREFILLS the editor: the change still has to be
//     saved by the human, which is exactly the human-approved config change
//     epic D8 requires (no silent, model-driven mutation).
//
// Read-only mode renders the identical information with the editing
// affordances replaced by the reason it is not editable.

import { useState, useTransition } from "react";
import { AlertTriangle, PlusCircle, PowerOff } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type {
  AgentExecutionConfigView,
  ExecutionPostureValue,
} from "@/lib/execution/agent-execution-config-view";
import { EXECUTION_MANAGER_FIELDS } from "@/lib/execution/agent-execution-config-view";

export type SaveExecutionConfig = (input: {
  executionEnabled: ExecutionPostureValue;
  os: string;
  pip: string;
  npm: string;
}) => Promise<{ ok: true } | { ok: false; errors: string[] }>;

type ManagerText = { os: string; pip: string; npm: string };

export function AgentExecutionConfigClient({
  view,
  save,
}: {
  view: AgentExecutionConfigView;
  save?: SaveExecutionConfig;
}) {
  const [posture, setPosture] = useState<ExecutionPostureValue>(view.posture);
  const [text, setText] = useState<ManagerText>({
    os: view.editorText.os,
    pip: view.editorText.pip,
    npm: view.editorText.npm,
  });
  // SAVE errors only. Problems with the STORED declaration (an invalid recipe,
  // an unreadable manifest) are a different thing and are rendered under their
  // own heading — labelling a load-time problem "not saved" would be wrong.
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const editable = view.editable && Boolean(save);

  function applySpec(spec: { os?: string[]; pip?: string[]; npm?: string[] }) {
    setSaved(false);
    setText({
      os: (spec.os ?? []).join("\n"),
      pip: (spec.pip ?? []).join("\n"),
      npm: (spec.npm ?? []).join("\n"),
    });
  }

  function addEntry(manager: "os" | "pip" | "npm", entry: string) {
    setSaved(false);
    setText((prev) => {
      const lines = prev[manager].split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.includes(entry)) return prev;
      return { ...prev, [manager]: [...lines, entry].join("\n") };
    });
  }

  function onSave() {
    if (!save) return;
    setErrors([]);
    setSaved(false);
    startTransition(async () => {
      const result = await save({ executionEnabled: posture, ...text });
      if (result.ok) setSaved(true);
      else setErrors(result.errors);
    });
  }

  return (
    <div data-slot="agent-execution-config" className="flex flex-col gap-4">
      {/* Dormancy is STATED, never hidden — the plane is off by default and a
          surface that implied otherwise would be lying about what is running. */}
      <Alert variant={view.dormancy.dormant ? "warning" : "info"}>
        {view.dormancy.dormant ? <PowerOff aria-hidden="true" /> : null}
        <AlertTitle data-slot="execution-dormancy-headline">
          {view.dormancy.headline}
        </AlertTitle>
        <AlertDescription>{view.dormancy.detail}</AlertDescription>
      </Alert>

      {view.errors.length > 0 ? (
        <Alert variant="destructive" data-slot="execution-declaration-errors">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>This environment declaration is not usable</AlertTitle>
          <AlertDescription>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {view.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {view.readOnlyReason ? (
        <p
          data-slot="execution-readonly-reason"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {view.readOnlyReason}
        </p>
      ) : null}

      {view.localDeclarationNote ? (
        <p
          data-slot="execution-local-declaration-note"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {view.localDeclarationNote}
        </p>
      ) : null}

      {/* Posture */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="execution-posture" className="text-sm font-semibold text-foreground">
          Execution
        </Label>
        <NativeSelect
          id="execution-posture"
          data-slot="execution-posture"
          className="h-9 w-full max-w-[280px] rounded-[8px] border border-line bg-surface px-2.5 text-sm text-foreground"
          value={posture}
          disabled={!editable || pending}
          onChange={(e) => {
            setSaved(false);
            setPosture(e.target.value as ExecutionPostureValue);
          }}
        >
          <option value="inherit">Follow the instance default</option>
          <option value="on">On for this agent</option>
          <option value="off">Off for this agent</option>
        </NativeSelect>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {view.postureSummary}
        </p>
      </div>

      {/* Declared environment */}
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Declared environment</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Packages this agent cannot work without. They are installed once into an
            immutable, content-addressed layer and mounted read-only into every run —
            never re-installed per run. One package per line.
          </p>
        </div>

        {editable ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Start from a template:</span>
            {view.starterTemplates.map((template) => (
              <Button
                key={template.id}
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                title={template.description}
                data-slot="execution-starter-template"
                data-template-id={template.id}
                onClick={() => applySpec(template.spec)}
              >
                {template.label}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="flex flex-col gap-3">
          {EXECUTION_MANAGER_FIELDS.map(({ manager, label, hint }) => (
            <div key={manager} className="flex flex-col gap-1.5">
              <Label
                htmlFor={`execution-env-${manager}`}
                className="text-sm font-medium text-foreground"
              >
                {label}
              </Label>
              <Textarea
                id={`execution-env-${manager}`}
                data-slot={`execution-env-${manager}`}
                rows={3}
                spellCheck={false}
                readOnly={!editable}
                disabled={pending}
                value={text[manager]}
                placeholder={editable ? "One package per line" : "None declared"}
                onChange={(e) => {
                  setSaved(false);
                  setText((prev) => ({ ...prev, [manager]: e.target.value }));
                }}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Promotion affordance */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold text-foreground">Suggested from recent runs</p>
        {view.promotionCandidates.length === 0 ? (
          <p
            data-slot="execution-promotion-empty"
            className="text-xs leading-relaxed text-muted-foreground"
          >
            {view.promotionEmptyNote}
          </p>
        ) : (
          <ul data-slot="execution-promotion-list" className="flex flex-col">
            {view.promotionCandidates.map((candidate, index) => (
              <li
                key={`${candidate.manager}:${candidate.packageName}`}
                className={[
                  "flex items-center justify-between gap-4 py-2.5",
                  index === view.promotionCandidates.length - 1 ? "" : "border-b border-line",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <div className="max-w-[56ch]">
                  <div className="text-sm text-foreground">
                    <span className="font-semibold">{candidate.packageName}</span>{" "}
                    <span className="text-muted-foreground">({candidate.manager})</span>
                  </div>
                  <div className="text-xs leading-relaxed text-muted-foreground">
                    Installed ad hoc on {candidate.runCount} of the last {candidate.windowRuns}{" "}
                    runs. Declaring it builds it once instead of every run.
                  </div>
                </div>
                {editable ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="flex-none"
                    disabled={pending}
                    data-slot="execution-promote"
                    onClick={() => addEntry(candidate.manager, candidate.packageName)}
                  >
                    <PlusCircle data-icon="inline-start" />
                    Add
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {errors.length > 0 ? (
        <Alert variant="destructive" data-slot="execution-config-errors">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>This configuration was not saved</AlertTitle>
          <AlertDescription>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {editable ? (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            className="flex-none"
            disabled={pending}
            data-slot="execution-config-save"
            onClick={onSave}
          >
            {pending ? "Saving…" : "Save execution config"}
          </Button>
          {saved ? (
            <span data-slot="execution-config-saved" className="text-xs text-success">
              Saved. It applies to the next version of this agent.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
