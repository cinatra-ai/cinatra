"use client";

// ---------------------------------------------------------------------------
// Field renderers for @cinatra-ai/trigger-agent.
//
// Two renderer wrappers are exposed:
//
//   * TriggerConfigureFormRenderer
//       Wraps the existing TriggerScreenClient. Reuses every UX behaviour of
//       the standalone first-step form (radio choices, schedule pickers,
//       prompt-driven AI suggestions). On submit, calls onChange(values)
//       which the orchestrator-stepper-panel forwards to approveReviewTask
//       so the trigger-agent's run resumes with the values as the
//       INTERRUPT response.
//
//   * TriggerConfirmSummaryRenderer
//       Read-only summary of the configure step's output rendered inside a
//       .soft-panel, plus a single shadcn Button that calls
//       onChange({ confirmed: true }) to release the confirm gate.
//
// Both renderers must use shadcn UI components and semantic tokens only —
// no raw HTML controls, no hardcoded palette classes.
// ---------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { TriggerScreenClient, type TriggerScreenFormValues } from "./trigger-screen-client";
import type { FieldRendererProps } from "./field-renderer-registry";

// ---------------------------------------------------------------------------
// Configure renderer — reuses TriggerScreenClient inside the trigger-agent's
// HITL conversation. The standalone form is preserved verbatim so prompt-driven
// suggestions (the existing xRenderer: "trigger-config" POST) continue to work.
//
// TriggerScreenClient internally calls setRunTrigger(...) on submit which
// upserts agent_run_triggers AND advances the parent run; we still want that
// behaviour for the standalone /trigger tab path. When mounted inside the
// trigger-agent run we route the values back to the parent INTERRUPT via
// onChange(values), which approveReviewTask picks up. Both paths therefore
// share the same React component without forking the form code.
// ---------------------------------------------------------------------------

type TriggerConfigureValue = {
  agentId?: string;
  templateId?: string;
  isAdmin?: boolean;
};

export function TriggerConfigureFormRenderer({
  value,
  context,
  onChange,
  aiSuggestions,
}: FieldRendererProps) {
  // agentId / templateId / isAdmin can be passed via the INTERRUPT payload
  // (preferred for the trigger-agent run) or pulled from the FieldRendererContext
  // when this renderer is mounted in a non-HITL shell. Fall back to empty strings
  // so the inner form still mounts; the existing form-level guards skip
  // submission with empty refs.
  const v = (value as TriggerConfigureValue | null) ?? null;
  const agentId = v?.agentId ?? "";
  const templateId = v?.templateId ?? context.templateId ?? "";
  const runId = context.runId ?? "";
  const isAdmin = v?.isAdmin ?? false;

  // Canonical HITL renderer pattern: on submit, build the payload from the
  // form's RHF values and call onChange with the structured fields PLUS
  // userResponse (JSON.stringify of the original payload). Cinatra's
  // approveReviewTaskInternal forwards userResponse verbatim as the single
  // string output the OAS-spec InputMessageNode permits; downstream nodes parse
  // it. JSON.stringify runs on the original payload BEFORE adding the
  // userResponse key so the wire payload is not self-describing.
  const handleSubmit = useCallback(
    (values: TriggerScreenFormValues) => {
      const payload: Record<string, unknown> = {
        triggerType: values.triggerType,
        timezone: values.timezone,
        ...(values.triggerType === "scheduled" ? { scheduledAt: values.scheduledAt } : {}),
        ...(values.triggerType === "recurring" ? { cronExpression: values.cronExpression } : {}),
      };
      onChange({ ...payload, userResponse: JSON.stringify(payload) });
    },
    [onChange],
  );

  // When mounted as a HITL renderer inside HitlApprovalCard, that parent owns
  // the prompt UI and pushes suggestions via the standard `aiSuggestions`
  // prop. Pass the flag down so TriggerScreenClient hides its own
  // HitlConversationPanel (avoids two prompt windows portaling to the same
  // <main>) and consumes aiSuggestions via its useEffect to update RHF.
  // onSubmit replaces the standalone setRunTrigger + redirect side-effects
  // when embeddedAsRenderer is true — the WayFlow persist node owns storage
  // via trigger_config_set.
  return (
    <TriggerScreenClient
      agentId={agentId}
      instanceId={runId}
      templateId={templateId}
      isAdmin={isAdmin}
      embeddedAsRenderer
      aiSuggestions={aiSuggestions}
      onSubmit={handleSubmit}
    />
  );
}

// ---------------------------------------------------------------------------
// Confirm renderer — read-only summary of the configure step's output plus a
// single Confirm button. Approving this gate is the last step before the
// trigger-agent's persist node calls trigger_config_set.
// ---------------------------------------------------------------------------

type TriggerConfirmValue = {
  triggerType?: "immediate" | "scheduled" | "recurring";
  scheduledAt?: string | null;
  cronExpression?: string | null;
  timezone?: string;
  enabled?: boolean;
};

function formatTriggerSummary(v: TriggerConfirmValue): {
  label: string;
  detail: string | null;
} {
  const tz = v.timezone ?? "UTC";
  switch (v.triggerType) {
    case "immediate":
      return { label: "Run immediately", detail: `Timezone: ${tz}` };
    case "scheduled":
      return {
        label: "Run once at a scheduled time",
        detail: v.scheduledAt
          ? `Scheduled: ${v.scheduledAt} (${tz})`
          : `Scheduled time not set (${tz})`,
      };
    case "recurring":
      return {
        label: "Run on a recurring schedule",
        detail: v.cronExpression
          ? `Cron: ${v.cronExpression} (${tz})`
          : `Cron expression not set (${tz})`,
      };
    default:
      return { label: "Trigger pending configuration", detail: null };
  }
}

export function TriggerConfirmSummaryRenderer({
  value,
  onChange,
  disabled,
}: FieldRendererProps) {
  const v = (value as TriggerConfirmValue | null) ?? {};
  const summary = formatTriggerSummary(v);
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = useCallback(async () => {
    if (submitting || disabled) return;
    setSubmitting(true);
    try {
      await onChange({ ...v, confirmed: true });
    } finally {
      setSubmitting(false);
    }
  }, [onChange, submitting, disabled, v]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-foreground">
          Confirm trigger
        </span>
        <span className="text-sm text-foreground">{summary.label}</span>
        {summary.detail && (
          <span className="text-sm text-muted-foreground">
            {summary.detail}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={submitting || disabled}
          onClick={() => {
            void handleConfirm();
          }}
        >
          {submitting ? "Confirming…" : "Confirm"}
        </Button>
      </div>
    </div>
  );
}
