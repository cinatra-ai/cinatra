"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fieldRendererRegistry } from "./field-renderer-registry";
import type { FieldRendererProps } from "./field-renderer-registry";
import {
  fetchCampaignRecipients,
  fetchInitialDrafts,
} from "./email-outreach-stage-actions";

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

// Condition: registered from the manifest bindings (kind "send-confirmation"
// — the :output canonical ID, the legacy screen-specific ID, and the bare
// alias) with strict matching — see register-default-renderers.ts.

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

// The AI-assist prompt is owned by the parent panel's sticky bottom-of-page portal.
// The renderer consumes `aiSuggestions` (stable payload that only changes
// on Suggest click) and uses an effect to sync `senderEmail` when AI returns one.
type SendConfirmationRendererProps = FieldRendererProps;

// Preloaded summary shape from mid-run interrupt payload.
type SendSummary = { recipientCount?: number; draftCount?: number; scheduledAt?: string };

export function SendConfirmationRenderer({
  value,
  onChange,
  disabled,
  context,
  aiSuggestions,
}: SendConfirmationRendererProps) {
  // Stable ref for onChange so the sync effect never captures a stale closure
  // when AgenticRunPanel recreates the callback on re-render.
  const onChangeRef = useRef(onChange);
  // Tracks the last senderEmail synced from the parent so poll-tick reference
  // churn (same content, new object) does not reset a user-typed value.
  const lastSyncedEmailRef = useRef<string>((value as { senderEmail?: string } | null)?.senderEmail ?? "");
  onChangeRef.current = onChange;

  // Preloaded summary from interrupt payload skips MCP fetch when present.
  const preloaded = (value as { summary?: SendSummary } | null)?.summary;

  const staticCampaignId = (value as { campaignId?: string } | null)?.campaignId;
  // The runId → campaignId lookup lived in the removed campaign-email-outreach
  // package. It is only used for deep-linking to the campaign detail page,
  // which no longer exists. Use the static campaignId if the interrupt payload
  // supplied one; otherwise leave undefined and skip the deep-link rather than
  // calling into a deleted package.
  const campaignId = staticCampaignId;
  // Recipient fetches are keyed by runId. The onChange wire format below still
  // emits campaignId for in-flight resume back-compat.
  const runId = (context as { runId?: string } | undefined)?.runId;

  const [recipientCount, setRecipientCount] = useState<number | null>(preloaded?.recipientCount ?? null);
  const [draftCount, setDraftCount] = useState<number | null>(preloaded?.draftCount ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [senderEmail, setSenderEmail] = useState<string>((value as { senderEmail?: string } | null)?.senderEmail ?? "");

  const loadSummary = useCallback(async () => {
    // Preloaded summary from interrupt payload skips MCP fetch.
    if (preloaded) {
      setRecipientCount(preloaded.recipientCount ?? null);
      setDraftCount(preloaded.draftCount ?? null);
      return;
    }
    if (!campaignId && !runId) return;
    setLoading(true);
    setError(null);
    try {
      // Recipients fetch by runId; drafts fetch by campaignId.
      const recipientsPromise = runId
        ? fetchCampaignRecipients(runId)
        : Promise.resolve({ items: [], total: 0 });
      const draftsPromise = campaignId
        ? fetchInitialDrafts(campaignId)
        : Promise.resolve({ items: [], total: 0 });
      const [recipientsResult, draftsResult] = await Promise.all([
        recipientsPromise,
        draftsPromise,
      ]);
      setRecipientCount(recipientsResult.total);
      setDraftCount(draftsResult.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaign summary");
    } finally {
      setLoading(false);
    }
  }, [campaignId, runId, preloaded]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  // Keep approval payload in sync with campaignId + senderEmail.
  // Read through onChangeRef so the effect always calls the latest callback
  // without adding onChange to the dep array, avoiding stale-closure re-fires.
  useEffect(() => {
    if (campaignId) onChangeRef.current({ campaignId, senderEmail: senderEmail || undefined });
  }, [campaignId, senderEmail]);

  // Sync `senderEmail` when an AI suggestion arrives from the parent's sticky
  // bottom prompt. `aiSuggestions` is a stable payload — it only changes when
  // the user submits a prompt — so this effect fires exactly once per Suggest
  // click and does not wipe in-progress user edits between polls.
  useEffect(() => {
    if (!aiSuggestions) return;
    if (typeof aiSuggestions.senderEmail === "string") {
      setSenderEmail(aiSuggestions.senderEmail);
    }
  }, [aiSuggestions]);

  // Sync `senderEmail` when the parent rewrites `value` externally (AI suggestion,
  // form.reset). Guard with lastSyncedEmailRef so poll-tick reference churn
  // (same content, new object spread) does not reset a user-typed address. This
  // mirrors EmailDraftsReviewRenderer's fingerprint-guard pattern.
  useEffect(() => {
    const v = value as { senderEmail?: string } | null | undefined;
    const incoming = v?.senderEmail ?? "";
    if (typeof v?.senderEmail === "string" && incoming !== lastSyncedEmailRef.current) {
      lastSyncedEmailRef.current = incoming;
      setSenderEmail(incoming);
    }
  }, [value]);

  if (!campaignId) {
    return (
      <p className="text-sm text-muted-foreground">
        No campaign selected yet. Complete the previous setup steps first.
      </p>
    );
  }

  // Sender picker — resolved through the field-renderer REGISTRY (cinatra#1625,
  // eng#548): the gmail-sender COMPONENT migrated into @cinatra-ai/email-artifacts,
  // so it can no longer be imported directly here. resolve() returns the migrated
  // binding's ExtensionFieldRenderer wrapper when the host-owned gmail-sender
  // condition activates (gmail connected + aliases present) — the wrapper mounts
  // the pack-shipped From-address dropdown (its Select commits the selection
  // eagerly via onChange, matching the retired host component).
  //
  // When the condition does NOT activate (no gmail), resolve() returns null. We
  // do NOT floor to SchemaOnlyFloorRenderer here: that floor BUFFERS text in
  // local state and only commits via registerFlush/Continue, so a typed address
  // could be lost when the outer approval fires (codex 2026-07-21). Instead we
  // render an EAGER inline email input that commits every keystroke to
  // senderEmail immediately — never blank, and the approval payload always
  // carries what the user typed, preserving the original Select's commit contract.
  const senderSchema: Record<string, unknown> = {
    type: "string",
    title: "Sender email",
    "x-renderer": "gmail-sender",
  };
  const senderEntry = fieldRendererRegistry.resolve("senderEmail", senderSchema, context);
  const ResolvedSenderRenderer = senderEntry?.renderer ?? null;

  return (
    <div className="soft-panel flex flex-col gap-4 p-4">
      {/* Campaign summary */}
      <div className="soft-panel flex flex-col gap-2 p-3">
        <span className="text-sm font-medium text-foreground">Campaign Summary</span>
        {loading && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}
        {error && !loading && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        {!loading && !error && (
          <div className="flex flex-col gap-1 text-sm text-foreground">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Campaign ID</span>
              <span>{campaignId}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Recipients</span>
              <span>{recipientCount ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Drafts</span>
              <span>{draftCount ?? "—"}</span>
            </div>
          </div>
        )}
      </div>

      {/* Sender email — registry-resolved (see senderEntry above). When the
          gmail-sender condition activates, the pack-shipped Select renders (via
          the ExtensionFieldRenderer wrapper); hideSubmit suppresses the wrapper's
          degrade-floor Continue button. Otherwise an eager inline input renders. */}
      {ResolvedSenderRenderer ? (
        <ResolvedSenderRenderer
          fieldName="senderEmail"
          schema={senderSchema}
          value={senderEmail}
          onChange={(v) => setSenderEmail(typeof v === "string" ? v : "")}
          disabled={disabled}
          required
          hideSubmit
          label="Sender email"
          context={context}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="field-senderEmail" className="text-foreground">
            Sender email *
          </Label>
          <Input
            id="field-senderEmail"
            type="email"
            className="border-line"
            value={senderEmail}
            disabled={disabled}
            placeholder="you@example.com"
            onChange={(e) => setSenderEmail(e.target.value)}
          />
        </div>
      )}

      {/* Warning */}
      <p className="text-sm text-destructive font-medium">
        Approving will send real emails to all recipients and cannot be undone.
      </p>

    </div>
  );
}
