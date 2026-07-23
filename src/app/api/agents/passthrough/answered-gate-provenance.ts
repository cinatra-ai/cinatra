import "server-only";

/**
 * #1987 (F1 deferred from #1960) — the SHARED-SEAM answered-gate-submission
 * provenance binding for run-scoped PERSIST primitives.
 *
 * The #1794 run-scoped seam authorizes a persist on the verified run frame +
 * declaring package + a `respondToHitl` run-access operation — scope properties
 * that hold for the WHOLE agent-run OBO context, NOT for the individual gate
 * answer. Nothing in that model binds a persisted payload to the SPECIFIC
 * ANSWERED approval-gate submission that authorized it. This module supplies the
 * missing invariant, ONCE, at the seam: every run-scoped persist primitive must
 * present valid, unconsumed answered-gate provenance for its OWN gate + payload
 * or FAIL CLOSED.
 *
 * It is a SEAM property, not a per-member one: a persist primitive is bound iff
 * it is in {@link RUN_SCOPED_PERSIST_TOOLS}, so a new #1946-template member
 * inherits the binding by construction (add it to the set — no per-member authz
 * code) and a persist primitive NOT covered is a detectable mis-registration
 * (the parity test), not a silent gap. The provenance is minted only at the
 * operator's answer (approveReviewTaskInternal) and consumed atomically here, so
 * it is single-use (replay-safe), non-transferable across gates (keyed by the
 * exact gate a2a task id, re-derived from the trusted frame's
 * `verifiedSubmissionId`, never caller input), and cannot be presented for a
 * mutated payload (the canonical payload digest must match).
 */

// The run-scoped PERSIST primitives whose write must originate from an ANSWERED
// gate submission. Members of the #1794 RUN_SCOPED_CONTEXT_TOOLS set that carry
// the operator's edits post-resume; the read/shape run-scoped primitives
// (agent_run_hitl_prompts_list / _exclude) are NOT persists and carry no binding.
// A future #1946-template persist member is bound the instant it is added HERE —
// the route gates on set membership, so the binding is inherited by construction.
export const RUN_SCOPED_PERSIST_TOOLS: ReadonlySet<string> = new Set<string>([
  // #1959 — persists the operator's reviewed per-recipient subject/body edits
  // (RECOVERABLE draft edit).
  "email_outreach_initial_drafts_update",
  // #1960 — removes exactly the recipients the operator explicitly removed
  // (DESTRUCTIVE recipient removal — the higher-stakes write).
  "email_outreach_recipients_update",
]);

export function isRunScopedPersistTool(tool: string): boolean {
  return RUN_SCOPED_PERSIST_TOOLS.has(tool);
}

export type ProvenanceDecision =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Enforce answered-gate-submission provenance for a run-scoped PERSIST call.
 * Called by the passthrough route AFTER `bindBridgeRunId` proves the run and the
 * seam resolves `verifiedSubmissionId` from the authoritative Redis latest-task
 * map, BEFORE the handler runs. Fail-closed on every uncertainty:
 *   - no `verifiedSubmissionId` on the frame (missing/unreadable substrate) — the
 *     operator's answered gate cannot be established → DENY, never a run-frame-
 *     only decision (AC7, mirroring `resolveRunScopedSubmissionId`);
 *   - no resume payload string to bind — DENY;
 *   - the answered-gate record is absent (never answered / already applied /
 *     expired) — DENY (AC1/AC2/replay);
 *   - the record's canonical digest ≠ the presented payload's — DENY without
 *     consuming (payload substitution/mutation — AC3);
 *   - the provenance store throws (Redis unreadable) — DENY (AC7).
 * Only a `consumed` result (record present AND digest matches) authorizes the
 * persist, exactly once.
 */
export async function enforceAnsweredGateProvenance(args: {
  tool: string;
  runId: string;
  verifiedSubmissionId: string | undefined;
  resumePayloadJson: unknown;
}): Promise<ProvenanceDecision> {
  const { tool, runId } = args;

  // AC7 — the frame carries no verified answered-gate submission id (the run-bound
  // pre-interrupt seam omits it on an absent/unreadable substrate). Deny; never
  // fall back to a run-frame-only decision.
  if (!args.verifiedSubmissionId) {
    return {
      ok: false,
      status: 403,
      error:
        `${tool}: no verified answered-gate submission id on the invocation frame — ` +
        `refusing to persist (the operator's answer to this gate cannot be established). ` +
        `Failing closed.`,
    };
  }
  const verifiedSubmissionId = args.verifiedSubmissionId;

  const resumePayloadJson =
    typeof args.resumePayloadJson === "string" ? args.resumePayloadJson : "";
  if (!resumePayloadJson) {
    return {
      ok: false,
      status: 403,
      error:
        `${tool}: the resume payload is absent — cannot bind the persist to the ` +
        `operator's answered-gate submission. Failing closed.`,
    };
  }

  let result: "consumed" | "mismatch" | "absent";
  try {
    const { consumeAnsweredGateSubmission } = await import("@cinatra-ai/a2a");
    result = await consumeAnsweredGateSubmission(
      runId,
      verifiedSubmissionId,
      resumePayloadJson,
    );
  } catch {
    // AC7 — the provenance store is unreadable. Deny; never a run-frame-only
    // decision.
    return {
      ok: false,
      status: 403,
      error:
        `${tool}: the answered-gate provenance store is unreadable — failing closed.`,
    };
  }

  if (result === "consumed") return { ok: true };
  if (result === "mismatch") {
    return {
      ok: false,
      status: 403,
      error:
        `${tool}: the persisted payload does not match the operator's answered-gate ` +
        `submission for this gate — refusing (payload substitution/mutation).`,
    };
  }
  // absent
  return {
    ok: false,
    status: 403,
    error:
      `${tool}: no unconsumed answered-gate submission authorizes this persist ` +
      `(the gate was not answered, or its answer was already applied) — refusing.`,
  };
}
