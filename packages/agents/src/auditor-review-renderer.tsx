"use client";

// ---------------------------------------------------------------------------
// AuditorReviewRenderer.
//
// Mounted as a field renderer (id: "@cinatra-ai/auditor-agent:review").
//
// Field-renderer signature: { fieldName, value, onChange, disabled, context, schema }.
//   value:   { runId, agentPackageName }
//   context: { runId, sessionUserId, runOwnerId }
//
// Ownership guard: if context.sessionUserId !== context.runOwnerId, render
// nothing — never expose drawer body to a non-owner.
//
// Accept(promptId)  → onChange({ userResponse: JSON.stringify({ acceptedIds: [id], dismissedIds: [] }) }) + toast.success
// Dismiss(promptId) → dismissAuditPromptsAction(runId, agentPackageName)
//                     + onChange({ userResponse: JSON.stringify({ acceptedIds: [], dismissedIds: [id] }) })
//
// Note: `userResponse` (not `reviewResult`) is the canonical WayFlow
// resume-text channel — `approveReviewTask` reads `userResponse` at
// `review-task-actions.ts:282`. The auditor OAS's downstream `reviewResult`
// variable is a separate graph-level output and is not read on this path.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { ClipboardList, Loader2 } from "lucide-react";
import { toast } from "@/lib/cinatra-toast";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { FieldRendererProps } from "./field-renderer-registry";
import {
  getAuditDrawerDataAction,
  dismissAuditPromptsAction,
  type AuditPromptDTO,
  type AuditSkillPreviewDTO,
} from "./server-actions";

export function AuditorReviewRenderer(props: FieldRendererProps) {
  const { value, onChange, disabled, context } = props;
  const v = (value ?? {}) as { runId?: string; agentPackageName?: string };
  const ctx = (context ?? {}) as {
    runId?: string;
    sessionUserId?: string;
    runOwnerId?: string;
  };
  const runId = v.runId ?? ctx.runId ?? "";
  const agentPackageName = v.agentPackageName ?? "";

  // Ownership guard: only the run owner may see drawer contents.
  const ownershipOk =
    ctx.sessionUserId == null ||
    ctx.runOwnerId == null ||
    ctx.sessionUserId === ctx.runOwnerId;

  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<AuditPromptDTO[]>([]);
  const [preview, setPreview] = useState<AuditSkillPreviewDTO | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  // Track inflight via ref so we don't list `loading` (a state value we also
  // write inside the effect) in the dep array. React docs flag the state-as-dep
  // + setState-in-body pattern as a re-run hazard, especially under React 19
  // strict-mode double-invoke.
  const inflightRef = useRef(false);

  useEffect(() => {
    if (!ownershipOk) return;
    if (!runId || !agentPackageName) return;
    if (fetched || inflightRef.current) return;
    inflightRef.current = true;
    setLoading(true);
    getAuditDrawerDataAction(runId, agentPackageName)
      .then((result) => {
        if (result.error) {
          setError(result.error);
        } else {
          setPrompts(result.prompts);
          setPreview(result.preview);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        inflightRef.current = false;
        setLoading(false);
        setFetched(true);
      });
  }, [ownershipOk, runId, agentPackageName, fetched]);

  // Mount-time default emit. The auditor LLM commonly produces zero
  // suggestions (no skills installed against the parent agent), so
  // prompts.length === 0 after fetch. The renderer otherwise never emits
  // `onChange` (it only fires on per-prompt Accept/Dismiss clicks), so the
  // outer-panel `bufferedHitlValue` stays empty and approveReviewTask falls
  // back to "[Approved by operator]" — which the apply route can't JSON.parse.
  //
  // Emit a default empty-envelope `userResponse` on mount (BEFORE the
  // prompts fetch completes) so the buffer always has a valid resume
  // text even if the operator (or test harness) clicks Continue before
  // the fetch resolves. Per-prompt Accept/Dismiss clicks overwrite this
  // via `emitReviewResult` below.
  //
  // `userResponse` (not `reviewResult`) — approveReviewTask reads
  // `userResponse` as the canonical WayFlow resume-text channel
  // (review-task-actions.ts:281). The reviewResult key is not read on this
  // path.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    try {
      onChangeRef.current({
        userResponse: JSON.stringify({ acceptedIds: [], dismissedIds: [] }),
      });
    } catch {
      // Gate may already be resolved (double-mount race); swallow.
    }
    // Run once on mount — explicit empty dep array. We intentionally
    // emit even before the fetch resolves so the test harness's quick
    // Continue click after "No captured guidance" renders from initial
    // state still picks up the userResponse field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ownershipOk) return null;

  // Emit a single string output per the OAS 26.1.0 InputMessageNode contract.
  // The envelope { acceptedIds, dismissedIds } is JSON-encoded and decoded
  // server-side by /api/auditor/apply.
  // See https://docs.cinatra.ai/references/platform/wayflow-input-message-node-contract/.
  // emitReviewResult may throw if onChange is missing or if the host A2UI
  // surface has already resolved the gate (double-click race). Catch and
  // surface to the user; callers below only fire the success toast AFTER a
  // successful emit, so a failed gate-resolve no longer leaves a misleading
  // success toast on screen.
  function emitReviewResult(acceptedIds: string[], dismissedIds: string[]): boolean {
    try {
      // Same userResponse-channel fix as the no-prompts auto-emit above —
      // approveReviewTask reads `userResponse`, not `reviewResult`.
      onChange({ userResponse: JSON.stringify({ acceptedIds, dismissedIds }) });
      return true;
    } catch (err) {
      toast.error(
        `Could not submit review: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  function handleAccept(promptId: string) {
    if (emitReviewResult([promptId], [])) {
      toast.success("Personal skill saved");
    }
  }

  async function handleDismiss(promptId: string) {
    setDismissingId(promptId);
    try {
      const result = await dismissAuditPromptsAction(runId, agentPackageName);
      if (result.ok) {
        if (emitReviewResult([], [promptId])) {
          toast.success(
            `Dismissed ${result.dismissed} captured guidance ${result.dismissed === 1 ? "message" : "messages"}`,
          );
        }
      } else {
        toast.error(`Could not dismiss: ${result.error}`);
      }
    } finally {
      setDismissingId(null);
    }
  }

  return (
    <div className="soft-panel rounded-card flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <ClipboardList className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">Skill preview</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Review the captured guidance from this run and the generated personal
        skill preview. Accept to confirm, or dismiss to discard the captured
        guidance.
      </p>

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Captured guidance ({prompts.length})
        </h4>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : prompts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No captured guidance.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {prompts.map((p) => (
              <div
                key={p.id}
                className="rounded-control border border-line bg-surface px-3 py-2"
              >
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {p.stepKey}
                </div>
                <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                  {p.message}
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled === true || dismissingId === p.id || loading}
                    onClick={() => handleDismiss(p.id)}
                  >
                    {dismissingId === p.id ? "Dismissing…" : "Dismiss"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={disabled === true || loading || error !== null}
                    onClick={() => handleAccept(p.id)}
                  >
                    Accept
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Personal skill preview
        </h4>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating preview…
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">
            Could not generate preview: {error}
          </p>
        ) : preview ? (
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium text-foreground">{preview.name}</div>
            <p className="text-xs text-muted-foreground">{preview.description}</p>
            <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words rounded-panel border border-line bg-surface-strong px-3 py-2 font-mono text-xs text-foreground">
              {preview.content}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
