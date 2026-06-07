"use client";

/**
 * EmailTestDeliveryFormRenderer
 *
 * HITL renderer for `@cinatra-ai/email-test-delivery-agent:input`. Implements the
 * test-email form fields (recipientEmail, selectionMode,
 * specificInitialDraftIds, specificFollowUpDraftIds, dev-mode banner).
 *
 * Multi-action HITL contract:
 *   - "Send test email" button POSTs to /api/test-delivery/send and updates
 *     a local banner. It does NOT call onChange — the gate must remain
 *     unresolved so the user can re-send.
 *   - "Continue" button calls onChange({ continueRequested: true, lastSendResult })
 *     to resolve the InputMessageNode interrupt and advance the flow.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MailIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
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
};

type SendResult = { ok: boolean; message: string; sentTo?: string };

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

  // Banner / send state
  const [lastSendResult, setLastSendResult] = useState<SendResult | null>(null);
  const lastSendResultRef = useRef<SendResult | null>(null);
  lastSendResultRef.current = lastSendResult;
  const [sending, setSending] = useState(false);

  // WR-01: reset form + banner state if the parent supplies a different
  // campaignId (e.g., the HITL surface re-mounts within the same React tree
  // for a different campaign). Without this, the `useState` initializer's
  // first-mount values would leak across campaign switches.
  // WR-02: re-syncs `recipientEmail` to the effective default whenever the
  // dev-mode toggle or development recipient changes, so toggling dev-mode
  // off mid-session does not leave a stale value the user has not seen.
  useEffect(() => {
    setLastSendResult(null);
    setSending(false);
    setRecipientEmail(effectiveDefaultRecipient);
    setSelectionMode(v.defaultSelectionMode ?? "random_initial");
    setSelectedInitialIds(v.defaultSpecificInitialDraftIds ?? []);
    setSelectedFollowUpIds(v.defaultSpecificFollowUpDraftIds ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, developmentModeEnabled, developmentRecipientEmail]);

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

  async function handleSend() {
    if (sending) return;
    setSending(true);
    setLastSendResult(null);
    const recipient =
      developmentModeEnabled && developmentRecipientEmail
        ? developmentRecipientEmail
        : recipientEmail;
    try {
      const body = {
        campaignId,
        recipientEmail: recipient,
        selectionMode,
        ...(selectionMode === "specific_initial"
          ? { specificInitialDraftIds: selectedInitialIds }
          : {}),
        ...(selectedFollowUpIds.length > 0
          ? { specificFollowUpDraftIds: selectedFollowUpIds }
          : {}),
      };
      const res = await fetch("/api/test-delivery/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        sentTo?: string;
        error?: string;
      };
      if (res.ok && json.ok) {
        setLastSendResult({
          ok: true,
          message: `Test email sent to ${json.sentTo ?? recipient}.`,
          sentTo: json.sentTo ?? recipient,
        });
      } else {
        setLastSendResult({
          ok: false,
          message: json.error ?? `Send failed (HTTP ${res.status})`,
        });
      }
    } catch (err) {
      setLastSendResult({
        ok: false,
        message: err instanceof Error ? err.message : "Send failed",
      });
    } finally {
      setSending(false);
    }
  }

  // Emit a single string output `testResult` per the InputMessageNode contract.
  // The envelope { userResponse, lastSendResult } is JSON-encoded; downstream
  // consumers JSON.parse on entry.
  // See https://docs.cinatra.ai/references/platform/wayflow-input-message-node-contract/.
  function handleContinue() {
    const envelope = {
      userResponse: "continue",
      lastSendResult: lastSendResultRef.current,
    };
    onChange({ testResult: JSON.stringify(envelope) });
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
              disabled={disabled || (developmentModeEnabled && Boolean(developmentRecipientEmail))}
            />
          </InputGroup>
        </Field>

        <Label className="grid gap-2 text-sm font-medium">
          What to send
          <Select
            value={selectionMode}
            onValueChange={(value: string) => setSelectionMode(value as SelectionMode)}
            disabled={disabled}
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
                disabled={disabled}
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
                        disabled={disabled}
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
                  disabled={disabled || followUpDraftOptions.length === 0}
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
                        disabled={disabled}
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

        {/* Inline status banner */}
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

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button type="button" onClick={handleSend} disabled={disabled || sending}>
            {sending ? "Sending…" : "Send test email"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleContinue}
            disabled={disabled}
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
