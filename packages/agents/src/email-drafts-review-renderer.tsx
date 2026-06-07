"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/cinatra-toast";
import type {
  FieldRendererCondition,
  FieldRendererProps,
} from "./field-renderer-registry";
import {
  fetchInitialDrafts,
  fetchChildInterruptOutput,
  updateInitialDraft,
  checkEmailOutreachAsyncStatus,
  type StageDraft,
} from "./email-outreach-stage-actions";
import { extractJsonFromText } from "./output-extract";

// ---------------------------------------------------------------------------
// Helper: extract StageDraft items from the email-drafts leaf LLM output.
// The agent outputs JSON with a draftedEmails array. Each entry has at minimum
// subject and body. recipientIdentifier / recipientEmail provide the display id.
// ---------------------------------------------------------------------------

function extractDraftsFromOutput(output: string): StageDraft[] | undefined {
  const parsed = extractJsonFromText(output);
  if (!parsed) return undefined;
  // Try all key patterns an LLM might use; order by most-expected first.
  // 'draftedEmails' is the canonical key enforced by the agent prompt;
  // the others handle LLM drift and alternate run payload shapes.
  const rawArray =
    (parsed.draftedEmails as Array<Record<string, unknown>> | undefined) ??
    (parsed.drafts as Array<Record<string, unknown>> | undefined) ??
    (parsed.emails as Array<Record<string, unknown>> | undefined) ??
    (parsed.emailDrafts as Array<Record<string, unknown>> | undefined);
  const items = Array.isArray(rawArray) ? rawArray : null;
  // null = unknown/unrecognized JSON structure → undefined triggers fallback to MCP fetch
  // empty array = valid response with zero drafts → return [] so renderer shows "no drafts" rather than falling back
  if (items === null) return undefined;
  if (items.length === 0) return [];
  return items.map((d, i): StageDraft => ({
    // recipientId is the agent's canonical field name; alternate keys are fallbacks.
    id: String(d.id ?? d.recipientId ?? d.recipientIdentifier ?? d.startupId ?? `draft-${i}`),
    recipientId: String(d.recipientId ?? d.recipientIdentifier ?? d.contactId ?? `recipient-${i}`),
    recipientEmail: (d.recipientEmail ?? d.contactEmail ?? d.email ?? null) as string | null,
    subject: String(d.subject ?? ""),
    body: String(d.body ?? ""),
    status: "draft",
  }));
}

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

export const isEmailDraftsReviewField: FieldRendererCondition = (_f, schema) =>
  // :output suffix is the canonical mid-run HITL ID.
  // Additional screen-specific IDs are accepted for compatibility with existing resume payloads.
  // @cinatra-ai/email-follow-up-agent:output is intentionally NOT listed here
  // because that ID has its own inline strict-equality condition in
  // register-default-renderers.ts. Including it here would cause the
  // email-drafts:output registry entry (same priority 80, registered first) to
  // win when resolving email-followups:output, making the follow-up registry
  // entry unreachable via resolve().
  ([
    "@cinatra-ai/email-drafting-agent:output",
    "@cinatra-ai/email-drafting-agent:email-drafts-review",
    "email-drafts-review",
  ] as string[]).includes((schema as { ["x-renderer"]?: string })["x-renderer"] ?? "");

// ---------------------------------------------------------------------------
// Renderer state machine
// ---------------------------------------------------------------------------

type Phase =
  | "cold"        // no campaignId resolved yet
  | "generating"  // draft generation in progress, polling
  | "loading"     // fetching draft list
  | "ready"       // drafts loaded
  | "error";

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

// The AI-assist prompt is owned by a sticky bottom-of-page portal in the parent panel
// (HitlApprovalCard / AgenticRunPanel). The renderer now consumes
// `aiSuggestions` (a stable payload that only changes on Suggest click,
// unlike `value` which re-references on every poll tick) and uses an effect
// to sync local edit state when an AI suggestion arrives.
type EmailDraftsReviewRendererProps = FieldRendererProps;

export function EmailDraftsReviewRenderer({
  value,
  onChange,
  disabled,
  context,
  schema,
  aiSuggestions,
  onHitlContextChange,
}: EmailDraftsReviewRendererProps) {
  // Preloaded drafts from the mid-run interrupt payload.
  // When non-empty, skip the MCP fetch and render immediately in "ready" phase.
  const preloaded = (value as { drafts?: StageDraft[] } | null)?.drafts;

  // campaignId resolution order:
  // 1. Direct in value
  // 2. previousStepApprovals["2"] — orchestrator recipients approval (step 2)
  // 3. allFieldValues.recipientsApproval — setup_collector flow field key
  const _prevApprovals = (value as Record<string, unknown> | null)?.previousStepApprovals as Record<string, Record<string, unknown>> | undefined;
  const staticCampaignId =
    (value as Record<string, unknown> | null)?.campaignId as string | undefined ??
    (_prevApprovals?.["2"]?.campaignId as string | undefined) ??
    ((context.allFieldValues?.recipientsApproval as Record<string, unknown> | undefined)?.campaignId as string | undefined);

  const runId = context.runId;
  const xRenderer = context.xRenderer ?? (schema as { "x-renderer"?: string } | undefined)?.["x-renderer"];

  // Fall back to the static campaignId only; if the interrupt payload does not
  // supply one and runId is available, start in "loading" so loadDrafts can
  // fetch via runId.
  const campaignId = staticCampaignId;

  const [phase, setPhase] = useState<Phase>(
    preloaded && preloaded.length > 0 ? "ready" : (staticCampaignId ?? runId) ? "loading" : "cold",
  );
  const [drafts, setDrafts] = useState<StageDraft[]>([]);
  const [edits, setEdits] = useState<Record<string, { subject: string; body: string }>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  // Track the last fingerprint we synced from `value` so the parent's poll
  // cycle (which re-references `value` every interval; see the comment on the
  // aiSuggestions effect below) does NOT clobber the user's in-progress edits.
  // Re-seeding only fires when the (id, subject, body) content actually differs
  // from the last sync.
  const lastSyncedFingerprintRef = useRef<string | null>(null);

  // Sync drafts + edits from `value` when the CONTENT changes (subject/body
  // fingerprint differs). Identity-only re-references from the parent's poll
  // cycle are skipped, preserving the user's in-progress typing. Updates BOTH
  // `drafts` and `edits` so a change in draft IDs (rare, but possible if AI
  // rewrites the entire set) is reflected. Runs alongside the existing
  // aiSuggestions effect below: that effect handles the explicit Suggest-click
  // path; this effect handles the case where the parent's `value` itself
  // contains updated drafts (e.g. form.reset / external mutation outside the AI
  // path).
  useEffect(() => {
    const incoming =
      (value as { drafts?: Array<{ id: string; subject?: string; body?: string; recipientEmail?: string | null }> } | null | undefined)
        ?.drafts ?? [];
    const fingerprint = JSON.stringify(
      incoming.map((d) => ({
        id: d.id,
        subject: d.subject ?? "",
        body: d.body ?? "",
      })),
    );
    if (fingerprint === lastSyncedFingerprintRef.current) return; // no content change → preserve edits
    lastSyncedFingerprintRef.current = fingerprint;

    // Re-seed drafts (full StageDraft shape) — coerce the incoming entries,
    // preserving recipientEmail so draft cards don't fall back to "Unknown recipient".
    const newDrafts: StageDraft[] = incoming.map((d) => ({
      id: d.id,
      recipientId: d.id,
      recipientEmail: d.recipientEmail ?? null,
      subject: d.subject ?? "",
      body: d.body ?? "",
      status: "draft",
    }));
    setDrafts(newDrafts);

    // Re-seed edits in lockstep with drafts.
    const newEdits: Record<string, { subject: string; body: string }> = {};
    for (const d of newDrafts) {
      newEdits[d.id] = { subject: d.subject ?? "", body: d.body ?? "" };
    }
    setEdits(newEdits);
  }, [value]);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const loadDrafts = useCallback(async (cId: string | undefined) => {
    setPhase("loading");
    try {
      const result = await fetchInitialDrafts(cId, runId, xRenderer);
      setDrafts(result.items);
      const initialEdits: Record<string, { subject: string; body: string }> = {};
      for (const draft of result.items) {
        initialEdits[draft.id] = { subject: draft.subject, body: draft.body };
      }
      setEdits(initialEdits);
      setPhase("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load drafts");
      setPhase("error");
    }
  }, []);

  const startPolling = useCallback((cId: string) => {
    setPhase("generating");
    pollRef.current = window.setInterval(async () => {
      try {
        const { status } = await checkEmailOutreachAsyncStatus({ campaignId: cId, kind: "initial_generation" });
        if (status === "completed" || status === "succeeded" || status === "saved") {
          stopPolling();
          await loadDrafts(cId);
        } else if (status === "failed" || status === "error") {
          stopPolling();
          setErrorMsg("Draft generation failed. Please try again.");
          setPhase("error");
        }
      } catch {
        // Keep polling on transient errors
      }
    }, 3000);
  }, [stopPolling, loadDrafts]);

  // Auto-trigger on mount
  useEffect(() => {
    // Preloaded drafts from interrupt payload: skip MCP fetch.
    if (preloaded && preloaded.length > 0) {
      setDrafts(preloaded);
      const initialEdits: Record<string, { subject: string; body: string }> = {};
      for (const draft of preloaded) {
        initialEdits[draft.id] = { subject: draft.subject, body: draft.body };
      }
      setEdits(initialEdits);
      setPhase("ready");
      return;
    }

    // When the orchestrator fires HITL on behalf of a paused child email-drafts agent,
    // it passes childRunId in currentValues. Fetch the child run's interrupt state
    // to get the LLM-generated drafts directly (same pattern as recipients renderer).
    const childRunId = (value as { childRunId?: string } | null)?.childRunId;
    if (childRunId) {
      setPhase("loading");
      void fetchChildInterruptOutput(childRunId).then((output) => {
        if (output) {
          const mapped = extractDraftsFromOutput(output);
          if (mapped) {
            setDrafts(mapped);
            const initialEdits: Record<string, { subject: string; body: string }> = {};
            for (const draft of mapped) {
              initialEdits[draft.id] = { subject: draft.subject, body: draft.body };
            }
            setEdits(initialEdits);
            setPhase("ready");
            return;
          }
        }
        // Child interrupt had no parseable drafts — fall back to DB/stub fetch.
        if (campaignId) {
          loadDrafts(campaignId);
        } else {
          setPhase("ready");
        }
      }).catch(() => {
        if (campaignId) loadDrafts(campaignId);
        else setPhase("ready");
      });
      return stopPolling;
    }

    if (!campaignId && !runId) {
      // No campaign or runId yet — nothing we can do
      return;
    }
    // Load drafts; if none exist, trigger generation
    (async () => {
      setPhase("loading");
      try {
        const result = await fetchInitialDrafts(campaignId, runId, xRenderer);
        if (result.items.length > 0) {
          setDrafts(result.items);
          const initialEdits: Record<string, { subject: string; body: string }> = {};
          for (const draft of result.items) {
            initialEdits[draft.id] = { subject: draft.subject, body: draft.body };
          }
          setEdits(initialEdits);
          setPhase("ready");
        } else {
          // No drafts yet: generation is running. Show message and poll.
          if (campaignId) startPolling(campaignId);
        }
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : "Failed to load drafts");
        setPhase("error");
      }
    })();
    return stopPolling;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The renderer loads drafts from the static campaignId supplied by the
  // interrupt payload.

  // Seed onChange whenever drafts load (or edits change) so the global Approve
  // button has all draft IDs and the parent flow's predicate node receives
  // the edit signal (edited boolean + editedIds[]).
  // The run panel merges { approved: true } on top when user clicks Approve.
  // Must be declared before early returns to satisfy Rules of Hooks.
  useEffect(() => {
    if (drafts.length === 0) return;
    const editedIds = drafts
      .filter((d) => {
        const e = edits[d.id];
        if (!e) return false;
        return e.subject !== d.subject || e.body !== d.body;
      })
      .map((d) => d.id);
    const edited = editedIds.length > 0;
    const payload = {
      campaignId,
      approvedDraftIds: drafts.map((d) => d.id),
      edited,
      editedIds,
    };
    onChange({ ...payload, userResponse: JSON.stringify(payload) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts.length, edits]);

  // Sync local edit state when an AI suggestion arrives from the parent's
  // sticky bottom prompt. `aiSuggestions` is a stable payload: it only changes
  // when the user submits a prompt, so this effect fires exactly once per
  // Suggest click and does not wipe in-progress user text between polls
  // (unlike an effect keyed on `value`).
  useEffect(() => {
    if (!aiSuggestions) return;
    const incomingDrafts = aiSuggestions.drafts as
      | Array<{ id: string; subject?: string; body?: string }>
      | undefined;
    if (incomingDrafts && Array.isArray(incomingDrafts)) {
      setEdits((prev) => {
        const next = { ...prev };
        for (const d of incomingDrafts) {
          if (d.id) {
            next[d.id] = {
              subject: d.subject ?? prev[d.id]?.subject ?? "",
              body: d.body ?? prev[d.id]?.body ?? "",
            };
          }
        }
        return next;
      });
    }
  }, [aiSuggestions]);

  // Publish effective draft data so the hitl-assist LLM sees current content.
  // Mirrors campaign-recipients-review-renderer's onHitlContextChange pattern.
  useEffect(() => {
    if (drafts.length === 0) return;
    onHitlContextChange?.({
      drafts: drafts.map((d) => ({
        id: d.id,
        recipientEmail: d.recipientEmail,
        subject: edits[d.id]?.subject ?? d.subject,
        body: edits[d.id]?.body ?? d.body,
      })),
    });
  }, [drafts, edits, onHitlContextChange]);

  // --- Loading / generating states ---
  if (phase === "cold") {
    return (
      <p className="text-sm text-muted-foreground">
        Waiting for the agent to generate email drafts…
      </p>
    );
  }
  if (phase === "generating") {
    return <p className="text-sm text-muted-foreground">Draft generation is in progress. The agent will notify you when ready.</p>;
  }
  if (phase === "loading") {
    return <p className="text-sm text-muted-foreground">Loading drafts…</p>;
  }

  // --- Error state ---
  if (phase === "error") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-destructive">{errorMsg ?? "An error occurred."}</p>
        <Button variant="outline" size="sm" onClick={() => campaignId && loadDrafts(campaignId)}>
          Retry
        </Button>
      </div>
    );
  }

  // --- Ready state ---
  const handleFieldChange = (draftId: string, field: "subject" | "body", val: string) => {
    setEdits((prev) => ({
      ...prev,
      [draftId]: { ...prev[draftId], [field]: val },
    }));
  };

  const handleSave = async (draftId: string) => {
    if (!campaignId) return;
    setSaving((prev) => new Set(prev).add(draftId));
    try {
      const e = edits[draftId];
      if (!e) return;
      await updateInitialDraft({
        campaignId,
        draftId,
        subject: e.subject,
        body: e.body,
      });
      toast.success("Draft saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(draftId);
        return next;
      });
    }
  };

  return (
    <div className="soft-panel flex flex-col gap-4 p-4">
      {/* Heading */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">
          Review drafts ({drafts.length})
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => campaignId && loadDrafts(campaignId)}
          disabled={disabled}
        >
          Refresh
        </Button>
      </div>

      {/* Empty state */}
      {drafts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No drafts found for this campaign.
        </p>
      )}

      {/* Draft cards */}
      {drafts.map((draft) => {
        const isSaving = saving.has(draft.id);
        const edit = edits[draft.id] ?? { subject: draft.subject, body: draft.body };

        return (
          <div key={draft.id} className="soft-panel flex flex-col gap-3 p-3">
            {/* Card header */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground truncate">
                {draft.recipientEmail ?? "Unknown recipient"}
              </span>
            </div>

            {/* Subject */}
            <div className="flex flex-col gap-1">
              <Label className="text-foreground">Subject</Label>
              <Input
                value={edit.subject}
                onChange={(e) => handleFieldChange(draft.id, "subject", e.target.value)}
                disabled={disabled}
                className="border-line"
              />
            </div>

            {/* Body */}
            <div className="flex flex-col gap-1">
              <Label className="text-foreground">Body</Label>
              <Textarea
                value={edit.body}
                onChange={(e) => handleFieldChange(draft.id, "body", e.target.value)}
                disabled={disabled}
                rows={6}
                className="border-line"
              />
            </div>

            {/* Card footer actions */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSave(draft.id)}
                disabled={isSaving || disabled}
              >
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        );
      })}

    </div>
  );
}
