"use server";
import { requireAuthSession } from "@/lib/auth-session";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";
import type { AgentTemplateRecord } from "./store";
import {
  readAgentRunById,
  readAgentTemplateBySlug,
  readAgentTemplateById,
  transitionRunStatus,
  RunTransitionError,
  clearAgentRunFailureMetadata,
  createAgentRunPendingInput,
  slugifyAgentTemplateName,
  readAllHitlPromptsForRun,
} from "./store";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  setRunTriggerForActor,
  deleteRunTriggerForActor,
  type SetTriggerForActorResult,
  type DeleteTriggerForActorResult,
} from "./trigger-service";
import type { TriggerType } from "./trigger-store";
import { readRunTriggerByRunId } from "./trigger-store";
import { markTriggerReleased } from "./trigger-gate";

export type TriggerAgentRunArgs = {
  runId: string;
  templateSlug: string; // used for run/template consistency check
};

export type TriggerAgentRunResult =
  | { ok: true }
  | { ok: false; error: string };

export async function triggerAgentRun(
  args: TriggerAgentRunArgs,
): Promise<TriggerAgentRunResult> {
  // 1. Auth
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };

  // 2. Load run
  const run = await readAgentRunById(args.runId);
  if (!run) return { ok: false, error: "run not found" };

  // 3. Ownership check
  if (run.runBy && run.runBy !== userId) {
    return { ok: false, error: "forbidden" };
  }

  // 4. State check (also enforced atomically in step 6, but we short-circuit
  //    here to give the client a clean error before any DB write).
  if (run.status !== "pending_input") {
    return { ok: false, error: "run is not in pending_input state" };
  }

  // 5. templateSlug consistency check — verify the run actually belongs to
  //    the template the client thinks it does. Prevents a malicious or
  //    confused client from triggering a run under the wrong template URL.
  const template = await readAgentTemplateById(run.templateId);
  // Accept: UUID, name-derived slug, or vendor/packageName (new package-name
  // routing — packageName stored with "@" prefix, agentId passed without it).
  const normalizedPkg = template?.packageName?.replace(/^@/, "") ?? "";
  if (
    !template ||
    (template.id !== args.templateSlug &&
      slugifyAgentTemplateName(template.name) !== args.templateSlug &&
      normalizedPkg !== args.templateSlug)
  ) {
    return { ok: false, error: "template mismatch" };
  }

  // 6. Atomic compare-and-swap: pending_input → queued. Returns false if
  //    a concurrent request already won the race.
  try {
    await transitionRunStatus(args.runId, "pending_input", "queued");
  } catch (err) {
    if (err instanceof RunTransitionError && err.code === "stale_from_status") {
      return { ok: false, error: "run is not in pending_input state" };
    }
    throw err;
  }

  // 7. Enqueue with jobId=runId for BullMQ-level dedup. If this throws,
  //    compensate by reverting to pending_input so the run does not get
  //    stuck in 'queued' forever.
  try {
    await enqueueAgentRun(
      { runId: args.runId },
      { jobId: args.runId },
    );
  } catch (err) {
    // Compensation: undo the queued transition. We use the conditional
    // helper again (queued → pending_input) so we never accidentally
    // revert a run that has already been picked up by a worker.
    await transitionRunStatus(
      args.runId,
      "queued",
      "pending_input",
    ).catch(() => {
      // Best-effort: log but do not mask the original error.
      console.error(
        "[triggerAgentRun] compensation revert failed for run",
        args.runId,
        err,
      );
    });
    return { ok: false, error: "enqueue failed" };
  }

  return { ok: true };
}

export type CreatePendingRunArgs = {
  templateSlug: string;
};

export type CreatePendingRunResult =
  | { ok: true; runId: string }
  | { ok: false; error: string };

/**
 * Creates an empty `pending_input` run for any template. The dispatcher's
 * setup-interrupt loop handles missing required fields at run time via AG-UI
 * INTERRUPT events — no pre-run wizard, no setup-nonce idempotency, no
 * zero-input guardrail.
 *
 * The exported name (`...ForZeroInputTemplate`) is preserved for the chat
 * package callers that import it.
 */
export async function createPendingRunForZeroInputTemplate(
  args: CreatePendingRunArgs,
): Promise<CreatePendingRunResult> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };
  // orgId is required at agent_runs insert time. `?? null` here is a TS
  // narrowing aid; the `if (!orgId)` hard-fails so no NULL ever flows to the
  // insert.
  const orgId = session?.session?.activeOrganizationId ?? null;
  if (!orgId) return { ok: false, error: "no active organization" };

  const template = await readAgentTemplateBySlug(args.templateSlug, {
    actorUserId: userId,
    includeNonPublished: true,
  });
  if (!template) return { ok: false, error: "template not found" };

  // Create an empty pending_input run owned by the actor. The setup loop in
  // execution.ts will emit INTERRUPTs for any required fields when the user
  // triggers the run.
  const created = await createAgentRunPendingInput({
    templateId: template.id,
    runBy: userId,
    inputParams: {},
    orgId,
  });

  return { ok: true, runId: created.id };
}

// Create a run AND immediately trigger it so the user lands on the Setup tab
// and sees HITL interrupt forms without a second button click.

async function createAndTriggerRunCore(
  userId: string,
  orgId: string,
  template: AgentTemplateRecord,
): Promise<CreatePendingRunResult> {
  // orgId is resolved by the caller (do NOT re-resolve session inside this
  // helper) and threaded through to createAgentRunPendingInput.
  const created = await createAgentRunPendingInput({
    templateId: template.id,
    runBy: userId,
    inputParams: {},
    orgId,
  });

  // Atomically transition pending_input → queued then enqueue.
  try {
    await transitionRunStatus(created.id, "pending_input", "queued");
  } catch (err) {
    if (err instanceof RunTransitionError && err.code === "stale_from_status") {
      return { ok: true, runId: created.id }; // best-effort; run exists
    }
    throw err;
  }

  try {
    await enqueueAgentRun(
      { runId: created.id },
      { jobId: created.id },
    );
  } catch {
    // Revert to pending_input so the user can retry via the Run button.
    // Discriminate the compensation catch so illegal_transition (programmer
    // error) surfaces loudly while stale_from_status (benign race — worker
    // already advanced the row) is logged and tolerated.
    await transitionRunStatus(
      created.id,
      "queued",
      "pending_input",
    ).catch((err) => {
      if (err instanceof RunTransitionError && err.code === "stale_from_status") {
        console.warn(
          `[createAndTriggerRun] compensation skipped for ${created.id}: run already advanced past queued`,
        );
        return;
      }
      console.error(
        "[createAndTriggerRun] compensation revert failed for run",
        created.id,
        err,
      );
      // Do not rethrow — the enqueue error is the user-facing error.
    });
  }

  return { ok: true, runId: created.id };
}

export async function createAndTriggerRun(
  args: CreatePendingRunArgs,
): Promise<CreatePendingRunResult> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };
  const orgId = session?.session?.activeOrganizationId ?? null;
  if (!orgId) return { ok: false, error: "no active organization" };

  const template = await readAgentTemplateBySlug(args.templateSlug, {
    actorUserId: userId,
    includeNonPublished: true,
  });
  if (!template) return { ok: false, error: "template not found" };

  return createAndTriggerRunCore(userId, orgId, template);
}

/**
 * Variant for callers that already hold a verified userId and template record —
 * skips redundant session + template DB fetches.
 *
 * Caller MUST also supply `orgId` (resolved from
 * `session.session?.activeOrganizationId` on the caller side). The helper does
 * NOT re-resolve session.
 */
export async function createAndTriggerRunWithContext(
  userId: string,
  orgId: string,
  template: AgentTemplateRecord,
): Promise<CreatePendingRunResult> {
  return createAndTriggerRunCore(userId, orgId, template);
}

export type ResetAgentRunArgs = {
  runId: string;
};

export type ResetAgentRunResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Reset a failed run back to pending_input so the user can edit their
 * inputs in the Setup tab and re-trigger via triggerAgentRun.
 *
 * Atomic via transitionRunStatus(failed → pending_input).
 * Concurrent calls (or calls on a non-failed run) return { ok: false }.
 *
 * After this returns ok, the existing SetupScreen run-status gating will
 * automatically show the Run button again because RunAgentButton renders only
 * when runStatus === "pending_input".
 */
export async function resetAgentRun(
  args: ResetAgentRunArgs,
): Promise<ResetAgentRunResult> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };

  const run = await readAgentRunById(args.runId);
  if (!run) return { ok: false, error: "run not found" };

  if (run.runBy && run.runBy !== userId) {
    return { ok: false, error: "forbidden" };
  }

  if (run.status !== "failed") {
    return { ok: false, error: "run is not in failed state" };
  }

  try {
    await transitionRunStatus(args.runId, "failed", "pending_input");
  } catch (err) {
    if (err instanceof RunTransitionError && err.code === "stale_from_status") {
      return { ok: false, error: "run is not in failed state" };
    }
    throw err;
  }

  // Clear error + timestamps so the next run starts fresh.
  await clearAgentRunFailureMetadata(args.runId);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// setRunTrigger / deleteRunTrigger server actions.
//
// Thin wrappers that resolve the Better Auth session into a
// TriggerActorContext envelope, then delegate to the actor-aware service
// layer (trigger-service.ts). The same service is called by MCP handlers
// with `request.actor` directly — no business logic is duplicated.
// ---------------------------------------------------------------------------

export type SetRunTriggerArgs = {
  runId: string;
  triggerType: TriggerType;
  scheduledAt?: string;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
};

export type SetRunTriggerResult = SetTriggerForActorResult;

/**
 * Server-action entry point for the trigger UI. Resolves the Better Auth
 * session into an actor envelope, then delegates to setRunTriggerForActor.
 */
export async function setRunTrigger(
  args: SetRunTriggerArgs,
): Promise<SetRunTriggerResult> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };
  const role =
    (session?.user as { role?: string | null } | null | undefined)?.role ??
    null;
  return setRunTriggerForActor({ userId, role, source: "ui" }, args);
}

export type DeleteRunTriggerArgs = { runId: string };
export type DeleteRunTriggerResult = DeleteTriggerForActorResult;

/**
 * Server-action entry point to remove a trigger. Cancels the BullMQ
 * schedule, deletes the row, and flips run status armed → stopped for
 * scheduled/recurring trigger types.
 */
export async function deleteRunTrigger(
  args: DeleteRunTriggerArgs,
): Promise<DeleteRunTriggerResult> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };
  const role =
    (session?.user as { role?: string | null } | null | undefined)?.role ??
    null;
  return deleteRunTriggerForActor({ userId, role, source: "ui" }, args);
}

// ---------------------------------------------------------------------------
// admin-only releaseTriggerNow.
//
// Forces the trigger gate open immediately for `runId`. Used only when an
// operator needs to bypass the schedule (e.g. emergency send). Two-layer
// auth: the client component hides the button when isAdmin === false; this
// server action re-checks `session.user.role === "admin"`.
// ---------------------------------------------------------------------------

export type ReleaseTriggerNowArgs = { runId: string };
export type ReleaseTriggerNowResult =
  | { ok: true }
  | { ok: false; error: string };

export async function releaseTriggerNow(
  args: ReleaseTriggerNowArgs,
): Promise<ReleaseTriggerNowResult> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  const role =
    (session?.user as { role?: string | null } | null | undefined)?.role ??
    null;
  if (!userId) return { ok: false, error: "unauthorized" };
  if (role !== "admin") return { ok: false, error: "forbidden — admin only" };

  const run = await readAgentRunById(args.runId);
  if (!run) return { ok: false, error: "run not found" };

  const trigger = await readRunTriggerByRunId(args.runId);
  if (!trigger) return { ok: false, error: "no trigger configured for this run" };

  await markTriggerReleased(args.runId);

  // Transition armed → queued so the dispatcher can pick up the run.
  // Swallow stale_from_status: the run may already be queued (race with the
  // scheduled release job) or in a terminal state.
  try {
    await transitionRunStatus(args.runId, "armed", "queued");
  } catch (err) {
    if (
      !(err instanceof RunTransitionError && err.code === "stale_from_status")
    ) {
      throw err;
    }
  }

  // Enqueue an execution job now that the gate is open. Idempotent on jobId.
  await enqueueAgentRun(
      { runId: args.runId },
      { jobId: `agent-builder-${args.runId}` },
    );

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dev Stepper View — child agent preview run
// ---------------------------------------------------------------------------

export type StartDevChildPreviewResult =
  | {
      ok: true;
      runId: string;
      templateId: string;
      agentSlug: string;
      templateName: string;
      packageName: string;
      agUiEnabled: boolean;
    }
  | { ok: false; error: string };

/**
 * Spawns a fresh run of a child agent for the Dev Stepper View, returning all
 * the data the OrchestratorStepperPanel needs to render the child's stage card
 * inline. Behaves like createAndTriggerRun but bundles template metadata so the
 * client can render the embedded panel without a second round-trip.
 */
export async function startDevChildPreviewRun(
  packageName: string,
): Promise<StartDevChildPreviewResult> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };
  const orgId = session?.session?.activeOrganizationId ?? null;
  if (!orgId) return { ok: false, error: "no active organization" };

  // readAgentTemplateBySlug accepts vendor/packageName (no "@" prefix),
  // bare-name slug, or UUID. For "@cinatra/foo" we want "cinatra/foo".
  const pkgMatch = packageName.match(/^@([^/]+)\/(.+)$/);
  const lookupSlug = pkgMatch ? `${pkgMatch[1]}/${pkgMatch[2]}` : packageName;
  const fallbackSlug = pkgMatch ? pkgMatch[2] : packageName;

  let template = await readAgentTemplateBySlug(lookupSlug, {
    actorUserId: userId,
    includeNonPublished: true,
  });
  if (!template && fallbackSlug !== lookupSlug) {
    template = await readAgentTemplateBySlug(fallbackSlug, {
      actorUserId: userId,
      includeNonPublished: true,
    });
  }
  if (!template) return { ok: false, error: "template not found" };

  const created = await createAgentRunPendingInput({
    templateId: template.id,
    runBy: userId,
    inputParams: {},
    orgId,
  });

  try {
    await transitionRunStatus(created.id, "pending_input", "queued");
  } catch (err) {
    if (!(err instanceof RunTransitionError && err.code === "stale_from_status")) {
      throw err;
    }
  }

  try {
    await enqueueAgentRun(
      { runId: created.id },
      { jobId: created.id },
    );
  } catch (err) {
    console.error("[startDevChildPreviewRun] enqueue failed", err);
  }

  // For vendor-scoped packages (@vendor/name), agentSlug becomes "vendor/name"
  // so router.push paths match /agents/[vendor]/[pkg]/... routing.
  const resolvedPkg = template.packageName ?? packageName;
  const resolvedMatch = resolvedPkg.match(/^@([^/]+)\/(.+)$/);
  const agentSlug = resolvedMatch ? `${resolvedMatch[1]}/${resolvedMatch[2]}` : fallbackSlug;

  return {
    ok: true,
    runId: created.id,
    templateId: template.id,
    agentSlug,
    templateName: template.name,
    packageName: resolvedPkg,
    agUiEnabled: true,
  };
}

// ---------------------------------------------------------------------------
// Submission-map builder. Walks approvalPolicy.steps + gateCount accumulator
// and aligns the i-th persisted hitl-prompt row to the i-th gate in capture
// order. Returns Map<stepIndex, { submittedValues, stepKey }>.
//
// Row-order invariant: writes happen exactly once per approveReviewTaskInternal
// / handleAgentBuilderRunResume invocation, BullMQ is single-worker per run, so
// capturedAt-ascending row position == gate index. MUST use
// readAllHitlPromptsForRun (no excluded filter) — bare-approval rows are part
// of the gate sequence even if autosave skips them.
// ---------------------------------------------------------------------------
export type SubmissionMapEntry = {
  submittedValues: Record<string, unknown> | null;
  schemaSnapshot: Record<string, unknown> | null;    // schema snapshot for completed gate
  stepKey: string;
};

// Serializable form of the submission map — used as RSC prop and server-action
// return value. Map<number, SubmissionMapEntry> is not reliably preserved across
// the RSC/server-action boundary in Next.js; a plain array of tuples is.
export type SubmissionMapEntries = Array<[number, SubmissionMapEntry]>;

export async function buildSubmissionMapByStepIndex(
  runId: string,
  agentId: string,
  policySteps: ReadonlyArray<{
    stepNumber: number;
    gateCount?: number;
    hitlOwnedBy?: string;
    xRenderer?: string;
  }>,
  hitlSteps: ReadonlyArray<{ index: number; stepNumber: number }>,
): Promise<SubmissionMapEntries> {
  // This server action is exposed as a browser-callable RPC by the top-of-file
  // "use server" directive, so it must not return submittedValues for
  // arbitrary runId/agentId pairs to any authenticated session.
  //
  // Mirror the pattern used by every other action in this file:
  //   1. requireAuthSession() — reject unauthenticated calls.
  //   2. readAgentRunById(runId, actor, roles) — internally calls
  //      enforceRunAccess(run, actor, "read", roles), which throws
  //      AuthzError(404 hidden) for non-existent or non-readable runs and
  //      AuthzError(403) for cross-org leaks. Owner + co-owner short-circuits
  //      both fire, so legitimate read access is preserved.
  //
  // We catch AuthzError-shaped throws and degrade to an empty Map so the
  // stepper still renders (it just shows the empty-state for every completed
  // step) — matching the behavior the caller already handles for missing or
  // mid-flight runs.
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return [];
  const actor: PrimitiveActorContext = {
    actorType: "human",
    source: "ui",
    userId,
  };
  const run = await readAgentRunById(runId, actor).catch(() => null);
  if (!run) return [];

  const prompts = await readAllHitlPromptsForRun(runId, agentId); // capturedAt asc

  // Align this filter with the canonical hitlSteps predicate in
  // instance-screens.tsx (xRenderer-only). Write paths only fire on
  // user-visible HITL gates (i.e. steps with an xRenderer), so widening here
  // would advance the promptCursor for steps that hitlSteps does NOT include,
  // silently shifting every subsequent mapping by one slot. Keeping both
  // filters identical guarantees the gateCount cursor and the stepper-index
  // lookup stay in lockstep.
  const gatedSteps = policySteps.filter((s) => Boolean(s.xRenderer));

  const entries: SubmissionMapEntries = [];
  let promptCursor = 0;

  for (const step of gatedSteps) {
    const gateCount =
      typeof step.gateCount === "number" && step.gateCount > 0
        ? step.gateCount
        : 1;
    for (let g = 0; g < gateCount; g++) {
      if (promptCursor >= prompts.length) return entries; // run still in progress — stop walking
      const stepperEntry = hitlSteps.find(
        (h) => h.stepNumber === step.stepNumber,
      );
      // Known: gateCount > 1 — multiple gates at the same stepNumber share the same stepper index;
      // only the last gate's data is kept in the map.
      if (stepperEntry) {
        entries.push([stepperEntry.index, {
          submittedValues: prompts[promptCursor].submittedValues,
          schemaSnapshot: prompts[promptCursor].schemaSnapshot ?? null,
          stepKey: prompts[promptCursor].stepKey,
        }]);
      }
      promptCursor++;
    }
  }
  return entries;
}
