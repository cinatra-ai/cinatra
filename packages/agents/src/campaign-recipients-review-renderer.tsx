"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Trash2, Undo2, Redo2 } from "lucide-react";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import { LoadingSpinner, type ProcessProgressStep } from "@cinatra-ai/sdk-ui";
import type { FieldRendererCondition, FieldRendererProps } from "./field-renderer-registry";
import {
  fetchCampaignRecipients,
  fetchChildInterruptOutput,
  confirmCampaignRecipients,
  checkEmailOutreachAsyncStatus,
  removeEmailOutreachRecipients,
  type StageRecipient,
} from "./email-outreach-stage-actions";
import { useEditHistory } from "./use-edit-history";
import { extractJsonFromText } from "./output-extract";
import { toast } from "@/lib/cinatra-toast";

// ---------------------------------------------------------------------------
// Helper: extract proposed recipients from LLM output JSON (handles both
// confirmedRecipients and reviewPayload.proposedRecipients shapes).
// ---------------------------------------------------------------------------

type RecipientsExtractionResult = {
  recipients: StageRecipient[];
  /** Agent explanation forwarded from the LLM output (e.g. why 0 results). */
  agentMessage?: string;
};

function extractRecipientsFromOutput(output: string): RecipientsExtractionResult | undefined {
  // Use the shared extractor — handles LLM responses that mix prose with JSON
  // by walking backwards through '}' positions to find the last balanced
  // object. Returns null when no {...} can be parsed from the text.
  const parsed = extractJsonFromText(output);
  if (!parsed) return undefined;
  const rv = parsed.reviewPayload as Record<string, unknown> | undefined;
  // Prefer confirmedRecipients only if non-empty; at HITL time the LLM sets
  // confirmedRecipients: [] and proposedRecipients: [...], so ?? alone would
  // short-circuit on the empty array and never reach proposedRecipients.
  const confirmedItems = parsed.confirmedRecipients as unknown[] | undefined;
  const rawItems =
    (Array.isArray(confirmedItems) && confirmedItems.length > 0 ? confirmedItems : undefined) ??
    parsed.proposedRecipients ??
    rv?.proposedRecipients ??
    (Array.isArray(parsed.reviewPayload) ? parsed.reviewPayload : undefined);
  const items = rawItems as Array<Record<string, unknown>> | undefined;
  const agentMessage = typeof parsed.summary === "string" && parsed.summary.length > 0
    ? parsed.summary
    : undefined;
  if (!Array.isArray(items) || items.length === 0) {
    // Return a result only when the output is a recognised agent response (has
    // a confirmedRecipients key or an agentMessage), so callers can distinguish
    // "LLM ran and found 0" from "no parseable data → fall back to MCP".
    return (Array.isArray(confirmedItems) || agentMessage)
      ? { recipients: [], agentMessage }
      : undefined;
  }
  return {
    recipients: items.map((r): StageRecipient => ({
      // `startupId` is the account/company link target — keep it on accountId
      // (falls back to the row's own startupId; NOT contactId, so the company
      // link and the contact link stay distinct).
      startupId: String(r.accountId ?? r.startupId ?? ""),
      startupName: (r.accountName ?? r.startupName) as string | null,
      contactName: (r.name ?? r.contactName) as string | null,
      contactEmail: (r.email ?? r.contactEmail) as string | null,
      contactTitle: (r.title ?? r.contactTitle) as string | null,
      // Carry the bundle's own contactId (CRM provider-native id) straight
      // through — the contact-name link uses it directly, so no email→id
      // re-resolution against cinatra.objects is needed.
      contactId: (r.contactId as string | null | undefined) ?? null,
    })),
    agentMessage,
  };
}

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

export const isCampaignRecipientsReviewField: FieldRendererCondition = (_f, schema) =>
  // :output suffix is the canonical mid-run HITL ID.
  // Screen-specific IDs remain accepted for persisted resume runs.
  (["@cinatra-ai/email-recipient-selection-agent:output","@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review","campaign-recipients-review"] as string[]).includes((schema as { ["x-renderer"]?: string })["x-renderer"] ?? "");

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type Phase =
  | "waiting"     // no runId in context yet — agent is preparing run, no side effects
  | "generating"  // polling for recipient generation
  | "loading"     // loading recipient list
  | "ready"       // showing recipients
  | "error";

// ---------------------------------------------------------------------------
// Op type
// ---------------------------------------------------------------------------

type RecipientOp = {
  type: "remove_recipient";
  startupId: string;
  snapshot: StageRecipient;
};

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

// The AI-assist prompt lives in a sticky bottom-of-page portal owned by the
// parent panel.
// The renderer now consumes `aiSuggestions` (a stable payload that only
// changes on Suggest click, unlike `value` which re-references on every poll
// tick) and uses an effect to sync the recipients list when AI suggests one.
type CampaignRecipientsReviewRendererProps = FieldRendererProps;

export function CampaignRecipientsReviewRenderer({
  value,
  onChange,
  context,
  onBusyChange,
  saveNow,
  mode = "edit",
  registerFlush,
  aiSuggestions,
  onHitlContextChange,
}: CampaignRecipientsReviewRendererProps) {
  // Preloaded recipients from the mid-run interrupt payload.
  // When non-empty, skip the MCP fetch and render immediately in "ready" phase.
  const preloadedDirect = (value as { recipients?: StageRecipient[] } | null)?.recipients;

  // Parse LLM output from value.output (forwarded by orchestrator from Stage 0 output —
  // rarely contains recipients, but keep as fallback when childRunId is absent).
  const preloadedFromOutput = (() => {
    const raw = (value as { output?: string } | null)?.output;
    if (!raw) return undefined;
    return extractRecipientsFromOutput(raw);
  })();

  const preloaded = preloadedDirect
    ? { recipients: preloadedDirect }
    : preloadedFromOutput;

  // The fetch trigger is context.runId, the single source of truth for run data.
  // persistedCampaignId is still derived from value.campaignId so the deeper
  // onChange({ campaignId, ... }) payloads preserve the in-flight wire format.
  const runId = (context as { runId?: string } | undefined)?.runId;
  const persistedCampaignId = (value as { campaignId?: string } | null)?.campaignId;

  const [phase, setPhase] = useState<Phase>(
    preloaded && preloaded.recipients.length > 0 ? "ready" : runId ? "loading" : "waiting",
  );
  const campaignId = persistedCampaignId;
  const [generationPhase, setGenerationPhase] = useState<string | undefined>(undefined);
  // serverRecipients is the canonical fetched list — ONLY set by the initial fetch.
  // Trash clicks, undo, redo, and AI assist must NEVER call setServerRecipients.
  const [serverRecipients, setServerRecipients] = useState<StageRecipient[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [agentMessage, setAgentMessage] = useState<string | null>(null);
  // Bundle-level list provenance — surfaced when the recipient bundle was
  // materialized from a saved list. Absent when provenance is unavailable.
  const [source, setSource] = useState<
    | {
        listId: string;
        listName: string;
        memberType?: string;
        snapshotAt?: string;
      }
    | undefined
  >(undefined);
  const pollRef = useRef<number | null>(null);
  const pollStartedAtRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Ref to break circular dependency: loadRecipients ↔ startPolling
  const startPollingRef = useRef<((cId: string) => void) | null>(null);
  const emptyToastFiredRef = useRef(false);

  // campaignIdRef for use in callbacks without re-registering them
  const campaignIdRef = useRef<string | undefined>(persistedCampaignId);
  campaignIdRef.current = persistedCampaignId;

  // ---------------------------------------------------------------------------
  // Undo/redo history
  // ---------------------------------------------------------------------------

  const history = useEditHistory<RecipientOp>();

  // Mirror pendingOps to a ref so flush callback always sees latest value
  // (avoids stale closure trap — flush is registered once on mount)
  const pendingOpsRef = useRef<RecipientOp[]>([]);
  useEffect(() => {
    pendingOpsRef.current = history.pendingOps;
  }, [history.pendingOps]);

  // Sync local recipients list when an AI suggestion arrives from the parent's
  // sticky bottom prompt. `aiSuggestions`
  // is a stable payload — it only changes when the user submits a prompt — so
  // this effect fires exactly once per Suggest click. Replacing the canonical
  // server list this way means we must clear the undo/redo history so prior
  // pendingOps (referencing the OLD recipient list) cannot replay against the
  // new list and corrupt state. The user can re-edit + re-undo from the AI
  // baseline.
  useEffect(() => {
    if (!aiSuggestions || !Array.isArray(aiSuggestions.recipients)) return;
    setServerRecipients(aiSuggestions.recipients as unknown as StageRecipient[]);
    history.clearAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSuggestions]);

  // Push live recipients into the parent's hitl-assist context so the LLM sees
  // the current array (not the empty interrupt
  // payload) and can edit it. The parent's handleHitlContextChange merges
  // this object into currentValue before sending to /hitl-assist.
  useEffect(() => {
    if (serverRecipients.length > 0) {
      onHitlContextChange?.({ recipients: serverRecipients });
    }
  }, [serverRecipients, onHitlContextChange]);

  // ---------------------------------------------------------------------------
  // Derived visible state
  // ---------------------------------------------------------------------------

  const visibleRecipients = useMemo(() => {
    const removedIds = new Set(
      history.pendingOps
        .filter((op) => op.type === "remove_recipient")
        .map((op) => op.startupId),
    );
    return serverRecipients.filter((r) => !removedIds.has(r.startupId));
  }, [serverRecipients, history.pendingOps]);

  const visibleTotal = useMemo(() => {
    const removedCount = history.pendingOps.filter(
      (op) => op.type === "remove_recipient",
    ).length;
    return Math.max(0, serverTotal - removedCount);
  }, [serverTotal, history.pendingOps]);

  // ---------------------------------------------------------------------------
  // Polling helpers
  // ---------------------------------------------------------------------------

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Loads recipients and auto-confirms them. If 0 are returned but generation
  // is still running (race condition on first visit), switches to polling mode.
  // The fetch is keyed by runId from context rather than the `cId` arg.
  // `cId` (campaignId) is still threaded through for the onChange wire-format
  // payload that downstream renderers consume.
  const loadRecipients = useCallback(async (cId?: string) => {
    setPhase("loading");
    try {
      const result = runId
        ? await fetchCampaignRecipients(runId)
        : ({ items: [], total: 0 } as Awaited<
            ReturnType<typeof fetchCampaignRecipients>
          >);

      // Race condition: navigated to step 3 before generation finished.
      if (result.total === 0) {
        try {
          if (cId !== undefined) {
            const { status } = await checkEmailOutreachAsyncStatus({ campaignId: cId, kind: "recipient_generation" });
            if (status === "running") {
              startPollingRef.current?.(cId);
              return;
            }
          }
        } catch {
          // Status check failed — show 0 results rather than a spinner.
        }
        // Generation is done but produced no recipients — surface a toast so
        // the user knows something went wrong rather than seeing a silent empty list.
        if (!emptyToastFiredRef.current) {
          emptyToastFiredRef.current = true;
          toast.warning("No recipients were generated. The agent may have failed to save results — please retry or start a new run.");
        }
      }

      setServerRecipients(result.items);
      setServerTotal(result.total);
      // Capture bundle-level list provenance when present; leave state
      // undefined when provenance is unavailable.
      setSource(result.source);

      // Contact-name links use each recipient row's own `contactId` (carried
      // straight from the recipients bundle — CRM provider-native id). No
      // email→id re-resolution against cinatra.objects is needed.

      onBusyChange?.(false);
      setPhase("ready");

      // Auto-confirm: proceeding to "Save & continue" IS the approval.
      // Only auto-confirm when cId is truthy. cId may be empty when a
      // value-less mount hasn't yet received a persistedCampaignId — fall back
      // to runId so the downstream drafts renderer always receives a
      // campaignId it can use to look up the run.
      const effectiveCId = cId ?? runId;
      if (result.total > 0 && effectiveCId !== undefined) {
        if (cId !== undefined) {
          try {
            await confirmCampaignRecipients(cId);
          } catch {
            // Non-fatal — confirm failed but we can still proceed.
          }
        }
        // onChange must run even if confirm throws — otherwise the approval
        // value stays {} and the step blocks. campaignId is the load-bearing
        // field so downstream email-drafts can find the campaign.
        const payload = { campaignId: effectiveCId, approved: true, approvedAt: new Date().toISOString() };
        onChange({ ...payload, userResponse: JSON.stringify(payload) });
      }
    } catch (e) {
      onBusyChange?.(false);
      setErrorMsg(e instanceof Error ? e.message : "Failed to load recipients");
      setPhase("error");
    }
  }, [onChange, onBusyChange, runId]);

  const startPolling = useCallback((cId: string) => {
    setPhase("generating");
    setGenerationPhase(undefined);
    pollStartedAtRef.current = Date.now();
    onBusyChange?.(true);
    pollRef.current = window.setInterval(async () => {
      // 10-minute hard timeout — prevents infinite spinner on stuck jobs or silent errors.
      if (pollStartedAtRef.current !== null && Date.now() - pollStartedAtRef.current > 10 * 60 * 1000) {
        stopPolling();
        onBusyChange?.(false);
        setErrorMsg("Recipient generation is taking too long. Please refresh and try again.");
        setPhase("error");
        return;
      }
      try {
        const { status, phase: gPhase } = await checkEmailOutreachAsyncStatus({ campaignId: cId, kind: "recipient_generation" });
        if (gPhase) setGenerationPhase(gPhase);
        if (status === "completed" || status === "succeeded" || status === "saved") {
          stopPolling();
          await loadRecipients(cId);
        } else if (status === "failed" || status === "error") {
          stopPolling();
          onBusyChange?.(false);
          setErrorMsg("Recipient generation failed. Please try again.");
          setPhase("error");
        }
      } catch {
        // Keep polling on transient errors
      }
    }, 3000);
  }, [stopPolling, loadRecipients, onBusyChange]);

  // Keep ref in sync so loadRecipients can call startPolling without a circular dep.
  startPollingRef.current = startPolling;

  // Auto-trigger on mount
  useEffect(() => {
    // Preloaded recipients from interrupt payload — skip MCP fetch.
    if (preloaded && preloaded.recipients.length > 0) {
      setServerRecipients(preloaded.recipients);
      setServerTotal(preloaded.recipients.length);
      setPhase("ready");
      // Seed the parent buffer with campaignId so handleContinue can pass it
      // through the approval payload. The preloaded path skips loadRecipients,
      // so onChange must be called here or the resume payload loses campaignId.
      if (persistedCampaignId) {
        onChange({ campaignId: persistedCampaignId });
      }
      return;
    }

    // When the orchestrator fires HITL on behalf of a paused child agent, it
    // passes childRunId in currentValues. Fetch the child's interrupt state to
    // get the LLM's proposed recipients directly.
    const childRunId = (value as { childRunId?: string } | null)?.childRunId;
    if (childRunId) {
      setPhase("loading");
      void fetchChildInterruptOutput(childRunId).then(async (output) => {
        if (output) {
          const result = extractRecipientsFromOutput(output);
          if (result) {
            setServerRecipients(result.recipients);
            setServerTotal(result.recipients.length);
            setAgentMessage(result.agentMessage ?? null);
            setPhase("ready");
            // Mirror loadRecipients auto-confirm: confirm in DB so email-drafts
            // can find recipients. LLM may skip email_outreach_recipients_confirm
            // when campaign context is sparse (inferred/proposed list case).
            if (result.recipients.length > 0 && persistedCampaignId) {
              try {
                await confirmCampaignRecipients(persistedCampaignId);
              } catch {
                // Non-fatal — confirm failed but we can still proceed.
              }
              // onChange must run even if confirm throws — otherwise the
              // approval value stays {} and the step blocks. campaignId is
              // the load-bearing field for downstream email-drafts lookup.
              const payload = { campaignId: persistedCampaignId, approved: true, approvedAt: new Date().toISOString() };
              onChange({ ...payload, userResponse: JSON.stringify(payload) });
            }
            return;
          }
        }
        // Child interrupt had no recognised output yet — fall back to MCP fetch.
        if (persistedCampaignId) {
          loadRecipients(persistedCampaignId);
        } else {
          setPhase("ready");
        }
      }).catch(() => {
        if (persistedCampaignId) loadRecipients(persistedCampaignId);
        else setPhase("ready");
      });
      return stopPolling;
    }

    // Fetch trigger keyed by runId. persistedCampaignId is still forwarded as
    // the cId arg for the onChange({ campaignId }) wire format to preserve
    // in-flight resume compatibility.
    if (runId) {
      loadRecipients(persistedCampaignId);
    }
    return stopPolling;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Post-mount transition from "waiting" → "loading" when runId arrives after
  // mount (browser refresh during poll interval race). Keyed by runId, not
  // persistedCampaignId.
  useEffect(() => {
    if (phase === "waiting" && runId) {
      loadRecipients(persistedCampaignId);
    }
  }, [runId, persistedCampaignId, phase, loadRecipients]);

  // ---------------------------------------------------------------------------
  // Register flush callback (deferred batch remove on Save)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!registerFlush) return;
    registerFlush(async () => {
      const cId = campaignIdRef.current;
      if (!cId) return;
      // Read pending ops from the ref — never from a closed-over variable.
      const ops = pendingOpsRef.current;
      const startupIds = Array.from(
        new Set(
          ops
            .filter((op) => op.type === "remove_recipient")
            .map((op) => op.startupId),
        ),
      );
      if (startupIds.length === 0) {
        // Nothing staged — nothing to flush, nothing to clear.
        return;
      }
      try {
        await removeEmailOutreachRecipients({ campaignId: cId, startupIds });
      } catch (err) {
        // Partial-failure policy:
        // - DO NOT clear history — the user may retry Save.
        // - Surface the failure immediately so the user knows Save did not complete.
        // - Re-throw so SetupWorkspace's flush loop aborts before calling onSaveStep.
        toast.error("Could not save recipient changes.");
        throw err;
      }
      // Success path: clear history so stale ops don't re-flush on a later Save.
      history.clearAll();
    });
  }, [registerFlush, history]);

  // ---------------------------------------------------------------------------
  // The prompt-portal-driven removal path no longer exists; direct user trash
  // clicks still flow through the undo stack unchanged.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Trash handler — deferred, no server call
  // ---------------------------------------------------------------------------

  const handleRemove = useCallback((startupId: string) => {
    const snapshot = serverRecipients.find((r) => r.startupId === startupId);
    if (!snapshot) return;
    // Guard: don't push a duplicate removal for an already-pending startupId
    const alreadyPending = history.pendingOps.some(
      (op) => op.type === "remove_recipient" && op.startupId === startupId,
    );
    if (alreadyPending) return;
    history.push({ type: "remove_recipient", startupId, snapshot });
  }, [serverRecipients, history]);

  // ---------------------------------------------------------------------------
  // Loading / generating states
  // ---------------------------------------------------------------------------

  if (phase === "waiting") {
    return <p className="text-sm text-muted-foreground">Agent is preparing the campaign…</p>;
  }
  if (phase === "generating") {
    const progressSteps: ProcessProgressStep[] = [
      {
        id: "selecting-recipients",
        label: "Selecting the recipients",
        status: generationPhase === "selecting_recipients"
          ? "running"
          : generationPhase === "saving_recipients"
            ? "completed"
            : "pending",
        detail: "Choosing one recipient per account from the selected audience.",
      },
      {
        id: "saving-results",
        label: "Saving the recipients list",
        status: generationPhase === "saving_recipients" ? "running" : "pending",
        detail: "Writing selected recipients back into the campaign.",
      },
    ];
    return (
      <div className="grid gap-4">
        {progressSteps.map((step) => (
          <div key={step.id} className="flex items-start gap-3">
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
              {step.status === "running" ? (
                <LoadingSpinner className="h-5 w-5 text-foreground" />
              ) : step.status === "completed" ? (
                <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 text-foreground" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" fill="currentColor" />
                  <path d="m8 12.5 2.5 2.5L16.5 9" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 text-muted-foreground" aria-hidden="true">
                  <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="3 3.6" />
                </svg>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-medium leading-6 text-foreground">{step.label}</div>
              {step.detail && <p className="mt-0.5 text-sm leading-6 text-muted-foreground">{step.detail}</p>}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (phase === "loading") {
    return <p className="text-sm text-muted-foreground">Loading recipients…</p>;
  }

  // --- Error state ---
  if (phase === "error") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-destructive">{errorMsg ?? "An error occurred."}</p>
        {persistedCampaignId && (
          <Button variant="outline" size="sm" onClick={() => loadRecipients(persistedCampaignId)}>Retry</Button>
        )}
      </div>
    );
  }

  // --- Ready state ---
  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="soft-panel flex flex-col gap-4 p-4 outline-none"
      onKeyDown={(e) => {
        if (mode !== "edit") return;
        const isMac = navigator.platform.startsWith("Mac");
        const modKey = isMac ? e.metaKey : e.ctrlKey;
        if (modKey && e.key === "z" && !e.shiftKey) {
          e.preventDefault();
          history.undo();
        } else if (modKey && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
          e.preventDefault();
          history.redo();
        }
      }}
    >
      <span className="text-sm font-medium text-foreground">
        {visibleTotal > 0 ? `${visibleTotal} recipient${visibleTotal !== 1 ? "s" : ""}` : "No recipients found"}
      </span>

      {source ? (
        <p className="text-sm text-muted-foreground">
          Sourced from list{" "}
          <span className="font-medium text-foreground">{source.listName}</span>
        </p>
      ) : null}

      {visibleTotal === 0 && agentMessage && (
        <p className="text-sm text-muted-foreground">{agentMessage}</p>
      )}

      {mode === "edit" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Button
            variant="ghost"
            size="sm"
            onClick={history.undo}
            disabled={!history.canUndo}
            aria-label="Undo"
          >
            <Undo2 className="h-4 w-4" />
            Undo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={history.redo}
            disabled={!history.canRedo}
            aria-label="Redo"
          >
            <Redo2 className="h-4 w-4" />
            Redo
          </Button>
          {history.pendingOps.length > 0 && (
            <span className="ml-1 text-xs text-muted-foreground">
              · {history.pendingOps.length} unsaved change{history.pendingOps.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      )}

      {visibleRecipients.length > 0 && (
        <PaginatedTable>
          <TableHeader>
            <TableRow>
              <TableHead>Contact</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Company</TableHead>
              {mode === "edit" && <TableHead className="w-px" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRecipients.map((r, i) => {
              return (
                <TableRow key={`${i}::${r.startupId}::${r.contactEmail ?? ""}`}>
                  <TableCell className="text-foreground font-medium">
                    {r.contactName ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{r.contactTitle ?? "—"}</TableCell>
                  <TableCell className="text-foreground">{r.contactEmail ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {r.startupName ?? r.startupId}
                  </TableCell>
                  {mode === "edit" && (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemove(r.startupId)}
                        aria-label="Remove recipient"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </PaginatedTable>
      )}

    </div>
  );
}
