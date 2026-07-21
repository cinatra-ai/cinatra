"use client";

/**
 * EmailTestDeliveryFormRenderer
 *
 * HITL renderer for `@cinatra-ai/email-test-delivery-agent:input`. A PURE
 * snapshot → onChange surface (DESIGN-V3 contract (8), the #1794 action-boundary
 * doctrine): the renderer COLLECTS input and RESOLVES the gate; the RUN performs
 * the send. The renderer NEVER performs a send itself — there is no client
 * fetch, no `/api/test-delivery/send` call (that route is deleted).
 *
 * Two actions both resolve the InputMessageNode gate by emitting a JSON-encoded
 * envelope at TOP-LEVEL `userResponse` (consumed by the WayFlow resume bridge,
 * `review-task-actions.ts:406`) AND `testResult` (the declared node output,
 * DESIGN-V3 contract (2)):
 *   - "Send test email" → `{ action:"send", recipientEmail, selectionMode,
 *      specificInitialDraftIds?, specificFollowUpDraftIds? }`. The workflow's
 *      `parse_action` → `perform_test_send` primitives perform the real
 *      server-side send under the run owner's authority, then RE-ENTER this gate
 *      feeding `lastSendResult` + prior selections + a fresh `gateCycle`.
 *   - "Continue" → `{ action:"continue" }` → the flow reaches End.
 *
 * Latency is honest (DESIGN-V3 contract (8)): clicking Send immediately disables
 * both buttons and shows a pending state; the REAL result returns on gate
 * re-entry as inbound `value.lastSendResult`. Rehydration is driven by the
 * server-produced `value.gateCycle` (the ledger send ordinal wired back via a
 * DataFlowEdge) — a monotonic token, so stale pending/selection state cannot
 * survive a re-entry, remount or not. The banner reflects ONLY the inbound
 * server-observed result (absent/null on first entry → no banner).
 *
 * See https://docs.cinatra.ai/references/platform/wayflow-input-message-node-contract/.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MailIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FieldRendererProps } from "./field-renderer-registry";

// ---------------------------------------------------------------------------
// Field-payload types — what the InputMessageNode hands to the renderer.
// ---------------------------------------------------------------------------

type SelectionMode = "random_initial" | "specific_initial" | "all_initial";

type InitialDraftOption = { id: string; label: string; subject: string };
type FollowUpDraftOption = { id: string; stepNumber: number; subject: string; label?: string };

// The REAL server-side send result the run observed, fed back into the gate
// value on re-entry (DESIGN-V3 contract (8)). Absent/null on first entry.
type SendResult = { ok: boolean; message: string; sentTo?: string };

type TestDeliveryValue = {
  campaignId?: string;
  defaultRecipientEmail?: string;
  defaultSelectionMode?: SelectionMode;
  defaultSpecificInitialDraftIds?: string[];
  defaultSpecificFollowUpDraftIds?: string[];
  initialDraftOptions?: InitialDraftOption[];
  followUpDraftOptions?: FollowUpDraftOption[];
  developmentModeEnabled?: boolean;
  developmentRecipientEmail?: string;
  // Inbound, workflow-supplied on gate re-entry (DESIGN-V3 contract (8)):
  lastSendResult?: SendResult | null; // the REAL result of the run's last send
  gateCycle?: number; // server-produced ledger send ordinal; rehydration token
};

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function EmailTestDeliveryFormRenderer({
  value,
  onChange,
  disabled,
}: FieldRendererProps) {
  const v = (value ?? {}) as TestDeliveryValue;
  const campaignId = v.campaignId ?? "";
  const initialDraftOptions = v.initialDraftOptions ?? [];
  const followUpDraftOptions = v.followUpDraftOptions ?? [];
  const developmentModeEnabled = Boolean(v.developmentModeEnabled);
  const developmentRecipientEmail = v.developmentRecipientEmail ?? "";
  const effectiveDefaultRecipient =
    developmentModeEnabled && developmentRecipientEmail
      ? developmentRecipientEmail
      : v.defaultRecipientEmail ?? "";
  // Banner is driven SOLELY by the inbound server-observed result — never a
  // client fetch. Absent/null on first entry → no banner.
  const lastSendResult = v.lastSendResult ?? null;
  // Server-produced rehydration token; first entry (no send yet) → 0.
  const gateCycle = typeof v.gateCycle === "number" ? v.gateCycle : 0;

  // Form state
  const [recipientEmail, setRecipientEmail] = useState<string>(effectiveDefaultRecipient);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>(
    v.defaultSelectionMode ?? "random_initial",
  );
  const [searchValue, setSearchValue] = useState("");
  const [selectedInitialIds, setSelectedInitialIds] = useState<string[]>(
    v.defaultSpecificInitialDraftIds ?? [],
  );
  const [selectedFollowUpIds, setSelectedFollowUpIds] = useState<string[]>(
    v.defaultSpecificFollowUpDraftIds ?? [],
  );

  // Submit state. `submittingAction` drives the disabled/pending UI (both
  // buttons disable the moment either action resolves the gate); `submitRef` is
  // the SYNCHRONOUS double-click dedupe guard that blocks a second `onChange`
  // before the gate resolves (DESIGN-V3 contract (8); the primitive's durable
  // idempotency ledger is the authoritative backstop if one still slips through).
  const [submittingAction, setSubmittingAction] = useState<"send" | "continue" | null>(null);
  const submitRef = useRef(false);

  // Re-hydrate on a fresh gate entry. Keyed on the server-produced `gateCycle`
  // (contract (8)) so a re-entry after a send ALWAYS clears the local pending
  // state and re-syncs the form to the workflow-fed prior selections (the user
  // does not re-pick to send again) — remount or not, a stale token cannot
  // survive. Also re-syncs on a campaign switch / dev-mode toggle so the
  // first-mount initializer values never leak across those changes.
  useEffect(() => {
    submitRef.current = false;
    setSubmittingAction(null);
    setRecipientEmail(effectiveDefaultRecipient);
    setSelectionMode(v.defaultSelectionMode ?? "random_initial");
    setSelectedInitialIds(v.defaultSpecificInitialDraftIds ?? []);
    setSelectedFollowUpIds(v.defaultSpecificFollowUpDraftIds ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, developmentModeEnabled, developmentRecipientEmail, gateCycle]);

  const filteredInitialDrafts = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    if (!query) return initialDraftOptions;
    return initialDraftOptions.filter((d) =>
      `${d.label} ${d.subject}`.toLowerCase().includes(query),
    );
  }, [initialDraftOptions, searchValue]);

  const allFollowUpsSelected =
    followUpDraftOptions.length > 0 &&
    selectedFollowUpIds.length === followUpDraftOptions.length;

  const isSubmitting = submittingAction !== null;
  const controlsDisabled = disabled || isSubmitting;

  function toggleInitial(id: string) {
    setSelectedInitialIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  }

  function toggleFollowUp(id: string) {
    setSelectedFollowUpIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  }

  // "Send test email" — resolve the gate with the send envelope. The RUN
  // performs the send (via parse_action → perform_test_send); the real result
  // returns on re-entry as `value.lastSendResult`. Immediately disable both
  // buttons + show a pending state (DESIGN-V3 contract (8)).
  function handleSend() {
    if (submitRef.current || disabled) return;
    submitRef.current = true;
    setSubmittingAction("send");
    const recipient =
      developmentModeEnabled && developmentRecipientEmail
        ? developmentRecipientEmail
        : recipientEmail;
    const envelope = JSON.stringify({
      action: "send",
      recipientEmail: recipient,
      selectionMode,
      ...(selectionMode === "specific_initial"
        ? { specificInitialDraftIds: selectedInitialIds }
        : {}),
      ...(selectedFollowUpIds.length > 0
        ? { specificFollowUpDraftIds: selectedFollowUpIds }
        : {}),
    });
    onChange({ userResponse: envelope, testResult: envelope });
  }

  // "Continue" — resolve the gate with the continue envelope; the flow reaches
  // End. Guarded by the same synchronous dedupe ref.
  function handleContinue() {
    if (submitRef.current || disabled) return;
    submitRef.current = true;
    setSubmittingAction("continue");
    const envelope = JSON.stringify({ action: "continue" });
    onChange({ userResponse: envelope, testResult: envelope });
  }

  return (
    <div className="soft-panel rounded-card flex flex-col gap-4 p-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Send a test email</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Choose the initial-email scope for the test send and optionally include any follow-up
          emails below.
        </p>
      </div>

      {developmentModeEnabled && developmentRecipientEmail ? (
        <div className="rounded-control border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          Cinatra is currently in development mode. All selected test emails will be sent to{" "}
          {developmentRecipientEmail}.
        </div>
      ) : null}

      <div className="grid gap-4">
        <Field className="min-w-[18rem] flex-1">
          <FieldLabel>Test recipient email</FieldLabel>
          <InputGroup>
            <InputGroupAddon>
              <MailIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              name="recipientEmail"
              type="email"
              value={
                developmentModeEnabled && developmentRecipientEmail
                  ? developmentRecipientEmail
                  : recipientEmail
              }
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setRecipientEmail(e.target.value)
              }
              disabled={
                controlsDisabled || (developmentModeEnabled && Boolean(developmentRecipientEmail))
              }
            />
          </InputGroup>
        </Field>

        <Label className="grid gap-2 text-sm font-medium">
          What to send
          <Select
            value={selectionMode}
            onValueChange={(value: string) => setSelectionMode(value as SelectionMode)}
            disabled={controlsDisabled}
          >
            <SelectTrigger className="rounded-control border-line bg-surface-strong disabled:bg-surface-muted disabled:text-muted-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="random_initial">One random initial email</SelectItem>
              <SelectItem value="specific_initial">Selected initial emails</SelectItem>
              <SelectItem value="all_initial">All initial emails</SelectItem>
            </SelectContent>
          </Select>
        </Label>

        {selectionMode === "specific_initial" ? (
          <Label className="grid gap-2 text-sm font-medium">
            Selected initial emails
            <div className="rounded-panel grid gap-3 border border-line bg-surface-strong p-4">
              <Input
                type="search"
                value={searchValue}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setSearchValue(e.target.value)
                }
                placeholder="Search recipient or subject"
                disabled={controlsDisabled}
                className="rounded-control border-line bg-surface-strong disabled:bg-surface-muted disabled:text-muted-foreground"
              />
              <div className="rounded-control max-h-72 overflow-y-auto border border-line">
                <div className="grid gap-2 p-3">
                  {filteredInitialDrafts.map((draft) => (
                    <Label
                      key={draft.id}
                      className="flex items-start gap-3 text-sm font-normal text-foreground"
                    >
                      <Checkbox
                        name="specificInitialDraftIds"
                        value={draft.id}
                        checked={selectedInitialIds.includes(draft.id)}
                        onCheckedChange={() => toggleInitial(draft.id)}
                        disabled={controlsDisabled}
                        className="mt-1"
                      />
                      <span>
                        <span className="font-semibold text-foreground">{draft.label}</span>
                        <span className="block text-muted-foreground">{draft.subject}</span>
                      </span>
                    </Label>
                  ))}
                  {filteredInitialDrafts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No matching recipients.</p>
                  ) : null}
                </div>
              </div>
            </div>
          </Label>
        ) : null}

        {followUpDraftOptions.length > 0 ? (
          <fieldset className="grid gap-2 text-sm font-medium">
            <legend className="text-sm font-medium">Selected follow-up emails</legend>
            <div className="rounded-panel border border-line bg-surface-strong p-4">
              <div className="flex items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setSelectedFollowUpIds(
                      allFollowUpsSelected ? [] : followUpDraftOptions.map((d) => d.id),
                    )
                  }
                  disabled={controlsDisabled || followUpDraftOptions.length === 0}
                  className="text-sm font-medium text-foreground underline-offset-4 hover:underline disabled:text-muted-foreground"
                >
                  {allFollowUpsSelected ? "Deselect all" : "Select all"}
                </Button>
              </div>
              <div className="mt-3 grid gap-2">
                {followUpDraftOptions.map((draft) => {
                  const checked = selectedFollowUpIds.includes(draft.id);
                  return (
                    <Label
                      key={draft.id}
                      className="flex items-start gap-3 text-sm font-normal text-foreground"
                    >
                      <Checkbox
                        name="specificFollowUpDraftIds"
                        value={draft.id}
                        checked={checked}
                        onCheckedChange={() => toggleFollowUp(draft.id)}
                        disabled={controlsDisabled}
                        className="mt-1"
                      />
                      <span>
                        <span className="font-semibold text-foreground">
                          Follow-up {draft.stepNumber}
                          {draft.label ? ` · ${draft.label}` : ""}
                        </span>
                        <span className="block text-muted-foreground">{draft.subject}</span>
                      </span>
                    </Label>
                  );
                })}
              </div>
            </div>
          </fieldset>
        ) : null}

        {/* Inline status banner — driven SOLELY by the inbound server-observed
            result the run supplied on re-entry (never a client fetch). */}
        {lastSendResult ? (
          <div
            data-testid="test-delivery-banner"
            data-status={lastSendResult.ok ? "success" : "error"}
            className={
              lastSendResult.ok
                ? "rounded-control border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
                : "rounded-control border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            }
          >
            {lastSendResult.message}
          </div>
        ) : null}

        {/* Pending indicator — honest latency while the run performs the send. */}
        {submittingAction === "send" ? (
          <div
            data-testid="test-delivery-pending"
            className="rounded-control border border-line bg-surface-muted px-4 py-3 text-sm text-muted-foreground"
          >
            Sending test…
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button type="button" onClick={handleSend} disabled={controlsDisabled}>
            {submittingAction === "send" ? "Sending test…" : "Send test email"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleContinue}
            disabled={controlsDisabled}
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
