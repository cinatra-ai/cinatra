"use server";
import {
  requireAuthSession,
  requireActorContext,
  isPlatformAdmin,
  resolveOrgRoleForSession,
} from "@/lib/auth-session";
import { AuthzError } from "@/lib/authz";
// cinatra#1939 wave 2 (§2a): every run-status transition here is grounded by the
// acting MEMBER's session (owner / org-admin, already checked above). A member
// mint fail-closes if membership was revoked — acceptable per the design.
import { verifySessionAuthority } from "@/lib/org-write/authority";
// cinatra#1940 P3 (Decision 1): the archived-org pre-check for the admin
// releaseTriggerNow fire path (routing/UX only — the kernel's run.execute
// ruling on the subsequent transition is the real backstop).
import { readOrgArchivedAtForDispatch } from "@/lib/org-write/dispatch-freeze";
import { resolveTemplateVisibilityActor } from "./auth-policy";
import type { ActorRoleHints } from "./auth-policy";
import { enqueueAgentRun, enqueueDepsForTemplate } from "@/lib/agent-run-enqueue";
import type { AgentTemplateRecord } from "./store";
import { asActionablePreflightError } from "./actionable-preflight-error";
import {
  readAgentRunById,
  readAgentRunMessages,
  readAgentTemplateBySlug,
  readAgentTemplateById,
  transitionRunStatus,
  RunTransitionError,
  clearAgentRunFailureMetadata,
  createAgentRunPendingInput,
  slugifyAgentTemplateName,
  readAllHitlPromptsForRun,
} from "./store";
import {
  deriveProducedOutputTitle,
  type RunOutputEvidence,
  type RunProducedOutput,
} from "./run-status";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { stepFiresRendererGate } from "./orchestrator-gate-predicate";
import {
  setRunTriggerForActor,
  deleteRunTriggerForActor,
  type SetTriggerForActorResult,
  type DeleteTriggerForActorResult,
} from "./trigger-service";
import type { TriggerType } from "./trigger-store";
import { readRunTriggerByRunId } from "./trigger-store";
import { markTriggerReleased } from "./trigger-gate";
import {
  maybeHoldRunForRecommendation,
  readRecommendationParkForRun,
} from "./recommendation-hold";
/** Stable code carried by AgentTemplateScopeError (cinatra#2485 C) — branch on
 *  the CODE, not `instanceof`, so a refusal is recognized across bundle /
 *  module-mock boundaries (the site-level pattern `project-dispatch.ts` uses
 *  for OBO_CEILING_DISJOINT_CODE). */
const AGENT_TEMPLATE_SCOPE_DENIED_CODE = "AGENT_TEMPLATE_SCOPE_DENIED";
const isScopeDenial = (err: unknown): err is { reason: string } =>
  (err as { code?: string } | null)?.code === AGENT_TEMPLATE_SCOPE_DENIED_CODE;

export type TriggerAgentRunArgs = {
  runId: string;
  templateSlug: string; // used for run/template consistency check
};

export type TriggerAgentRunResult =
  | { ok: true }
  // `code`/`settingsHref` carry an actionable run-preflight failure
  // (a missing/unconfigured connector or LLM provider) so the UI can
  // deep-link the fix instead of showing a generic "enqueue failed".
  | { ok: false; error: string; code?: string; settingsHref?: string };

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

  // 5b. Run-start recommendation HOLD (cinatra#2067, epic #2037 C3). A
  //     human-present run parks at the recommendation interception until the
  //     chip-row confirm/adjust/skip decision releases it. If a live park
  //     already exists, the run is awaiting that decision — the Run button must
  //     not re-dispatch (the run view shows the chip-row instead). If no
  //     decision yet AND the checkpoint fires with candidates, park now and
  //     return ok WITHOUT dispatching (the run stays pending_input; the run
  //     view renders the chip-row). Best-effort: any failure fails OPEN to a
  //     normal dispatch — a recommendation hold must never block a run.
  const livePark = await readRecommendationParkForRun(args.runId).catch(() => null);
  if (livePark?.status === "parked") {
    return { ok: true };
  }
  try {
    const hold = await maybeHoldRunForRecommendation({
      run,
      template: {
        packageName: template.packageName,
        lifecycleConfig: (template as { lifecycleConfig?: string | null }).lifecycleConfig,
      },
    });
    if (hold.held) {
      // Parked — the chip-row (via confirm/skipRunRecommendationAction) releases
      // it and dispatches. Do NOT transition or enqueue here.
      return { ok: true };
    }
  } catch (err) {
    // The run id is a request-controlled value; keep it OUT of the console
    // format-string position (pass it as a discrete argument) so a `%`-bearing
    // id can never be interpreted as a util.format specifier (CodeQL
    // js/tainted-format-string).
    console.warn(
      "[triggerAgentRun] recommendation hold evaluation failed for run",
      args.runId,
      "— dispatching normally:",
      err instanceof Error ? err.message : String(err),
    );
  }
  // Owner's member session grounds both the dispatch and its compensation.
  const authority = await verifySessionAuthority(userId, run.orgId);

  // 6. Atomic compare-and-swap: pending_input → queued. Returns false if
  //    a concurrent request already won the race.
  try {
    await transitionRunStatus(args.runId, "pending_input", "queued", undefined, authority);
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
      // cinatra#1056 connector edges + cinatra#1062 LLM-provider package identity,
      // projected so the run-start connector + LLM-provider preflights both fire.
      { jobId: args.runId, ...enqueueDepsForTemplate(template) },
    );
  } catch (err) {
    // Compensation: undo the queued transition. We use the conditional
    // helper again (queued → pending_input) so we never accidentally
    // revert a run that has already been picked up by a worker.
    await transitionRunStatus(
      args.runId,
      "queued",
      "pending_input",
      undefined,
      authority,
    ).catch(() => {
      // Best-effort: log but do not mask the original error.
      console.error(
        "[triggerAgentRun] compensation revert failed for run",
        args.runId,
        err,
      );
    });
    // Surface an actionable connector/LLM-provider preflight failure to the
    // user (cinatra#1056/#1062) instead of a generic "enqueue failed".
    const actionable = asActionablePreflightError(err);
    if (actionable) return { ok: false, ...actionable };
    return { ok: false, error: "enqueue failed" };
  }

  return { ok: true };
}

export type CreatePendingRunArgs = {
  templateSlug: string;
};

export type CreatePendingRunResult =
  | { ok: true; runId: string }
  // See TriggerAgentRunResult — actionable preflight failure fields.
  | { ok: false; error: string; code?: string; settingsHref?: string };

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

  // admin-parity P4 (cinatra#1129): a platform_admin / owning-org admin can run
  // a non-published template, not just its creator.
  const template = await readAgentTemplateBySlug(
    args.templateSlug,
    await resolveTemplateVisibilityActor(session),
  );
  if (!template) return { ok: false, error: "template not found" };

  // cinatra#1940 P3 (Decision 2): the creation-perimeter conversion — every
  // agent_runs INSERT now runs guarded (capability run.execute). This
  // function never mints one today (it stays pending_input, no later
  // transition), so mint the member session authority up front.
  const authority = await verifySessionAuthority(userId, orgId);

  // Create an empty pending_input run owned by the actor. The setup loop in
  // execution.ts will emit INTERRUPTs for any required fields when the user
  // triggers the run.
  const created = await createAgentRunPendingInput(
    {
      templateId: template.id,
      runBy: userId,
      inputParams: {},
      orgId,
      // Interactive UI/chat run-start → human-present (cinatra#2067).
      humanPresent: true,
    },
    authority,
  );

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
  // cinatra#1940 P3 (Decision 2): mint the member session authority ONCE, up
  // front — reused for BOTH the guarded create below and the subsequent
  // pending_input→queued transition (was previously minted only for the
  // transition, after the — then unguarded — create).
  const authority = await verifySessionAuthority(userId, orgId);
  const created = await createAgentRunPendingInput(
    {
      templateId: template.id,
      runBy: userId,
      inputParams: {},
      orgId,
      // Interactive UI/chat run-start → human-present (cinatra#2067). This run may
      // park at the recommendation chip-row before it dispatches.
      humanPresent: true,
    },
    authority,
  );

  // Run-start recommendation HOLD (cinatra#2067). A human-present run parks at
  // the recommendation interception before dispatch; the chip-row decision
  // releases it. Best-effort — a hold failure fails OPEN to normal dispatch.
  try {
    const hold = await maybeHoldRunForRecommendation({
      run: created,
      template: {
        packageName: template.packageName,
        lifecycleConfig: (template as { lifecycleConfig?: string | null }).lifecycleConfig,
      },
    });
    if (hold.held) {
      // Parked — do NOT transition/enqueue. The run view shows the chip-row.
      return { ok: true, runId: created.id };
    }
  } catch (err) {
    console.warn(
      `[createAndTriggerRun] recommendation hold evaluation failed for run ${created.id}; dispatching normally:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  // `authority` (minted above, before the create) grounds both the dispatch
  // and its compensation revert.

  // Atomically transition pending_input → queued then enqueue.
  try {
    await transitionRunStatus(created.id, "pending_input", "queued", undefined, authority);
  } catch (err) {
    if (err instanceof RunTransitionError && err.code === "stale_from_status") {
      return { ok: true, runId: created.id }; // best-effort; run exists
    }
    throw err;
  }

  try {
    await enqueueAgentRun(
      { runId: created.id },
      // cinatra#1056 connector edges + cinatra#1062 LLM-provider package identity.
      { jobId: created.id, ...enqueueDepsForTemplate(template) },
    );
  } catch (enqueueErr) {
    // Revert to pending_input so the user can retry via the Run button.
    // Discriminate the compensation catch so illegal_transition (programmer
    // error) surfaces loudly while stale_from_status (benign race — worker
    // already advanced the row) is logged and tolerated.
    await transitionRunStatus(
      created.id,
      "queued",
      "pending_input",
      undefined,
      authority,
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
    // An actionable connector/LLM-provider preflight failure won't fix on retry
    // — surface it so the user can configure the provider (cinatra#1056/#1062),
    // rather than reporting a false success with a silently-pending run.
    const actionable = asActionablePreflightError(enqueueErr);
    if (actionable) return { ok: false, ...actionable };
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

  // admin-parity P4 (cinatra#1129): a platform_admin / owning-org admin can run
  // a non-published template, not just its creator.
  const template = await readAgentTemplateBySlug(
    args.templateSlug,
    await resolveTemplateVisibilityActor(session),
  );
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

  const authority = await verifySessionAuthority(userId, run.orgId);
  try {
    await transitionRunStatus(args.runId, "failed", "pending_input", undefined, authority);
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

  // cinatra#1940 P3 (Decision 1): refuse BEFORE any side-effect (the gate
  // flag, the transition) when the org is archived. Fail-open on `null`
  // (unknown) — this is a pre-check, not the enforcement point; the guarded
  // transition below refuses regardless.
  if ((await readOrgArchivedAtForDispatch(run.orgId)) === true) {
    return {
      ok: false,
      error: "This organization is archived — agents cannot start new work.",
    };
  }

  // cinatra#2485 C: this is the ONE interactive dispatch that starts SOMEONE
  // ELSE's run, so the shared dispatch guard's default (authorize the run's
  // owner) is not enough — the releasing admin must ALSO be inside the agent's
  // install scope. Admin standing counts at ORG scope only; an org admin who is
  // not in the owning team/project cannot force-start work that scope reserves
  // for its members. Asserted BEFORE `markTriggerReleased`, which is a
  // monotonic gate write that no later refusal can undo.
  try {
    const { assertAgentRunDispatchAuthorized } = await import(
      "./agent-run-serde"
    );
    await assertAgentRunDispatchAuthorized({
      runId: args.runId,
      stage: "dispatch",
      actingUserId: userId,
    });
  } catch (err) {
    if (isScopeDenial(err)) {
      return { ok: false, error: "forbidden — this agent's scope does not include you" };
    }
    throw err;
  }

  await markTriggerReleased(args.runId);

  // Admin (org-role admin, checked above) acts as a member of the run's org.
  const authority = await verifySessionAuthority(userId, run.orgId);

  // Transition armed → queued so the dispatcher can pick up the run.
  // Swallow stale_from_status: the run may already be queued (race with the
  // scheduled release job) or in a terminal state.
  try {
    await transitionRunStatus(args.runId, "armed", "queued", undefined, authority);
  } catch (err) {
    if (
      !(err instanceof RunTransitionError && err.code === "stale_from_status")
    ) {
      throw err;
    }
  }

  // Enqueue an execution job now that the gate is open. Idempotent on jobId.
  //
  // cinatra#2485 C — COMPENSATION on a scope denial. The run is already `queued`
  // at this point, and `enqueueAgentRun` re-asserts the dispatch guard: if the
  // agent's scope changed in the window between the transition's own guard and
  // this one, the enqueue throws and the run would otherwise sit `queued`
  // forever with no job to run it and no operator signal.
  //
  // The failure is landed HERE rather than inside the enqueue chokepoint because
  // this frame already holds a member session `authority` for the run, whereas
  // the chokepoint would have to mint an org-wide run authority it is
  // deliberately not allowed to hold (org-write-boundary-gate R2/R5).
  //
  // `stale_from_status` is swallowed for the same reason as the transition
  // above: another writer already moved the run off `queued`.
  try {
    await enqueueAgentRun(
      { runId: args.runId },
      { jobId: `agent-builder-${args.runId}` },
    );
  } catch (err) {
    if (!isScopeDenial(err)) throw err;
    try {
      await transitionRunStatus(
        args.runId,
        "queued",
        "failed",
        {
          error:
            `run refused: the agent's scope no longer authorizes this run (${err.reason})`,
        },
        authority,
      );
    } catch (compErr) {
      if (
        !(compErr instanceof RunTransitionError && compErr.code === "stale_from_status")
      ) {
        console.error(
          "[releaseTriggerNow] run",
          args.runId,
          "was refused by the install-scope gate but could not be failed — it stays queued with no job:",
          compErr instanceof Error ? compErr.message : String(compErr),
        );
      }
    }
    return { ok: false, error: "forbidden — this agent's scope does not include you" };
  }

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
      /** cinatra#2148 finding 2: TRUE when the preview run PARKED at the
       * run-start recommendation interception. The caller renders the chip-row
       * (the decision releases the park and dispatches) and treats the run as
       * `pending_input`, not `queued`. */
      heldForRecommendation: boolean;
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

  // admin-parity P4 (cinatra#1129): a platform_admin / owning-org admin can run
  // a non-published template, not just its creator.
  const templateVisibilityActor = await resolveTemplateVisibilityActor(session);
  let template = await readAgentTemplateBySlug(lookupSlug, templateVisibilityActor);
  if (!template && fallbackSlug !== lookupSlug) {
    template = await readAgentTemplateBySlug(fallbackSlug, templateVisibilityActor);
  }
  if (!template) return { ok: false, error: "template not found" };

  // cinatra#1940 P3 (Decision 2): mint the member session authority ONCE, up
  // front — reused for the guarded create below AND the transition later in
  // this function (the mint at the former call site, after creation, is
  // removed to avoid a duplicate membership read).
  const authority = await verifySessionAuthority(userId, orgId);
  const created = await createAgentRunPendingInput(
    {
      templateId: template.id,
      runBy: userId,
      inputParams: {},
      orgId,
      // Dev Stepper preview is an interactive, present-human run (cinatra#2067).
      humanPresent: true,
    },
    authority,
  );

  // For vendor-scoped packages (@vendor/name), agentSlug becomes "vendor/name"
  // so router.push paths match /agents/[vendor]/[pkg]/... routing.
  const resolvedPkg = template.packageName ?? packageName;
  const resolvedMatch = resolvedPkg.match(/^@([^/]+)\/(.+)$/);
  const agentSlug = resolvedMatch ? `${resolvedMatch[1]}/${resolvedMatch[2]}` : fallbackSlug;
  const previewResult = (heldForRecommendation: boolean): StartDevChildPreviewResult => ({
    ok: true,
    runId: created.id,
    templateId: template.id,
    agentSlug,
    templateName: template.name,
    packageName: resolvedPkg,
    agUiEnabled: true,
    heldForRecommendation,
  });

  // Run-start recommendation HOLD (cinatra#2148 finding 2). The Dev Stepper
  // preview marks its run humanPresent and used to transition + enqueue
  // DIRECTLY, so under the default-on chip-row it was the one interactive
  // run-start that never paused — contradicting "a human-present run pauses when
  // recommendations exist". It now consults the SAME hold as every other
  // interactive run-start: parked ⇒ return the panel metadata WITHOUT
  // dispatching (the embedded child panel renders the chip-row, whose
  // confirm/adjust/skip releases the park and dispatches through the canonical
  // `triggerAgentRun`). Best-effort — a hold failure fails OPEN to the previous
  // direct dispatch.
  try {
    const hold = await maybeHoldRunForRecommendation({
      run: created,
      template: {
        packageName: template.packageName,
        lifecycleConfig: (template as { lifecycleConfig?: string | null }).lifecycleConfig,
      },
    });
    if (hold.held) return previewResult(true);
  } catch (err) {
    console.warn(
      "[startDevChildPreviewRun] recommendation hold evaluation failed for run",
      created.id,
      "— dispatching normally:",
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    await transitionRunStatus(created.id, "pending_input", "queued", undefined, authority);
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

  return previewResult(false);
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
    firesRendererGate?: boolean;
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

  const allPrompts = await readAllHitlPromptsForRun(runId, agentId); // capturedAt asc
  // #824: context-selection gate approvals are persisted as prompt rows, but a
  // context step carries NO xRenderer so `gatedSteps` (below) excludes it. If we
  // kept those rows the promptCursor would advance for a step the walk never
  // visits, shifting every subsequent prompt→step mapping by one. Drop context
  // submissions here — mirrors the interrupt-side shape detection in execution.ts
  // (a context submission's userResponse is the {slotId,resolutionMode,selectedRefs}
  // envelope; some paths spread the raw context values instead). Shape-only.
  const isContextSubmission = (v: Record<string, unknown> | null): boolean => {
    if (!v) return false;
    const ur = v["userResponse"];
    if (typeof ur === "string") {
      try {
        const p = JSON.parse(ur) as Record<string, unknown>;
        return (
          typeof p?.["slotId"] === "string" &&
          typeof p?.["resolutionMode"] === "string" &&
          Array.isArray(p?.["selectedRefs"])
        );
      } catch {
        return false;
      }
    }
    const slotMeta = v["slotMeta"] as { slotId?: unknown } | undefined;
    return typeof slotMeta?.slotId === "string" && Array.isArray(v["selectedRefs"]);
  };
  const prompts = allPrompts.filter((p) => !isContextSubmission(p.submittedValues));

  // Align this filter with the canonical hitlSteps predicate in
  // instance-screens.tsx via the shared stepFiresRendererGate helper. Write
  // paths only fire on user-visible HITL gates (steps with an xRenderer that
  // are NOT #839 metadata-only phantom gateSteps), so widening here would
  // advance the promptCursor for steps that hitlSteps does NOT include,
  // silently shifting every subsequent mapping by one slot. Keeping all three
  // renderer-gate walks identical guarantees the gateCount cursor and the
  // stepper-index lookup stay in lockstep.
  const gatedSteps = policySteps.filter(stepFiresRendererGate);

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

// ---------------------------------------------------------------------------
// Terminal-run OUTPUT evidence (folded in from run-output-actions.ts,
// cinatra#2482 — route-graph ratchet: the locked routes already carry this
// module, so the read lives with the run's other server actions rather than in
// a net-new module)
// ---------------------------------------------------------------------------
//
// The completion card needs to know, at the moment it renders, whether the run
// left anything behind: provenance-linked output objects (`objects.run_id`),
// a transcript (messages / accumulated streamed text), or step results. It is
// read HERE rather than threaded down from the server render because the run
// frequently completes while the user is watching — an SSR snapshot taken while
// the run was still `queued` would make a run that DID produce output report
// "no output".
//
// Authorization: the run is re-read through `readAgentRunById` with the caller's
// actor + role hints (the same door the run screens use), so a caller who
// cannot see the run gets `run not found`. The object read is then scoped to
// that run's `orgId` AND handed the caller's `ActorContext`, so
// `buildOwnershipFilter` applies the canonical ownership vocabulary — this
// surface can never widen what its caller may already read.
// ---------------------------------------------------------------------------

export type ReadRunOutputEvidenceResult =
  | ({ ok: true } & RunOutputEvidence)
  | { ok: false; error: string };

/** How many produced outputs the completion card will link. */
const MAX_LINKED_OUTPUTS = 10;

/**
 * How many run-produced objects to CONSIDER before selecting the linkable ones.
 *
 * Deliberately larger than {@link MAX_LINKED_OUTPUTS}: the provenance read is
 * ordered `created_at DESC` and knows nothing about artifact types or read
 * authority, so limiting it to 10 would let ten newer non-artifact (or
 * read-denied) rows hide an older artifact — the card would then report "this
 * run produced no output" about a run that did, which is precisely the false
 * claim this whole fix exists to prevent. Scan a wide window, classify, THEN
 * take the first {@link MAX_LINKED_OUTPUTS} that survive.
 *
 * Bounded rather than unbounded: `listObjectsByFilter` caps at 1000, one run's
 * own output set is small, and each survivor costs one `readArtifactForDetail`.
 */
const MAX_OUTPUT_SCAN = 100;

export async function readRunOutputEvidence(args: {
  runId: string;
}): Promise<ReadRunOutputEvidenceResult> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };

  const isAdmin = isPlatformAdmin(session);
  const actor: PrimitiveActorContext = {
    actorType: "human",
    source: "ui",
    userId,
  };
  const roles: ActorRoleHints = {
    platformRole: isAdmin ? "platform_admin" : "member",
    orgRole: session
      ? await resolveOrgRoleForSession({ user: { id: session.user.id }, session: session.session })
      : undefined,
    actorOrganizationId: session?.session?.activeOrganizationId ?? undefined,
  };

  let run: Awaited<ReturnType<typeof readAgentRunById>>;
  try {
    run = await readAgentRunById(args.runId, actor, roles);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: "run not found" };
    throw err;
  }
  if (!run) return { ok: false, error: "run not found" };

  const hasStepResults = Array.isArray(run.stepResults) && run.stepResults.length > 0;
  const hasStreamedText = (run.streamedText ?? "") !== "";
  const messages = hasStreamedText ? [] : await readAgentRunMessages(run.id);
  const hasTranscript = hasStreamedText || messages.length > 0;

  // Provenance-linked outputs. Dynamic imports keep the host objects/artifact
  // module graphs off this module's synchronous load (same precedent as
  // `lifecycle-review-orchestration-store.ts`). Fail SOFT: a read error must
  // not turn a completed run's card into an error — the transcript/step-result
  // evidence above still names the outcome correctly.
  //
  // TWO stages, and the second is load-bearing. The indexed `objects.run_id`
  // read finds everything the run wrote, but the card links each row to
  // `/artifacts/<id>`, and that route serves ARTIFACT-typed objects only: it
  // 404s a non-artifact object and shows the not-authorized panel for a
  // list-visible-but-read-denied one. Linking straight off the provenance read
  // would therefore trade one dead end for another. So every candidate is put
  // through `readArtifactForDetail` — the route's OWN resolution, registry
  // predicate and `object.read` gate included — and only a `kind: "ok"` row is
  // ever linked. (Verified live: a `blog_post` object produced by a run linked
  // to a 404 before this gate.)
  let outputs: RunProducedOutput[] = [];
  let outputsUnavailable = false;
  let unlinkableOutputs = false;
  try {
    const viewer = await requireActorContext();
    const { listObjectsByFilter } = await import("@/lib/objects-store");
    const { readArtifactForDetail } = await import("@/lib/artifacts/artifact-service");
    const produced = listObjectsByFilter(
      { orgId: run.orgId, runId: run.id, limit: MAX_OUTPUT_SCAN },
      viewer,
    );
    for (const row of produced) {
      if (outputs.length >= MAX_LINKED_OUTPUTS) break;
      const access = readArtifactForDetail({
        artifactId: row.id,
        orgId: run.orgId,
        actor: viewer,
      });
      if (access.kind !== "ok") continue;
      outputs.push({
        id: row.id,
        type: access.artifact.artifactType || row.type,
        title:
          access.artifact.title?.trim() ||
          deriveProducedOutputTitle({ data: row.data, type: row.type, id: row.id }),
      });
    }
    // CONFIRMATION-ROUND FINDING. The artifact gate above is deliberately
    // strict, so a run whose every provenance row is non-artifact-typed or
    // read-denied (and whose scan window filled with such rows) came out of
    // this block with `outputs: []` and no flag — indistinguishable from a run
    // that wrote nothing at all. The card then told the user "nothing was
    // returned and nothing was saved" about a run that demonstrably SAVED rows.
    // That is the same false claim the artifact gate itself was added to
    // prevent, arriving from the other side. Rows existed but none survived ⇒
    // say so; the resolver takes the conservative branch.
    unlinkableOutputs = produced.length > 0 && outputs.length === 0;
  } catch (err) {
    console.warn(
      "[readRunOutputEvidence] produced-output read failed for run",
      args.runId,
      "— reporting the outputs as UNAVAILABLE, not as absent:",
      err instanceof Error ? err.message : String(err),
    );
    outputs = [];
    // Codex round-2 finding: swallowing this and returning an empty list told
    // the card "this run produced no output" whenever the objects/artifact read
    // was merely broken. Say "could not look" instead — the resolver then takes
    // the conservative branch.
    outputsUnavailable = true;
  }

  return {
    ok: true,
    outputs,
    hasTranscript,
    hasStepResults,
    outputsUnavailable,
    unlinkableOutputs,
  };
}
