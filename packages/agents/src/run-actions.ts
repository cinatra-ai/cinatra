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
import { resolveTemplateVisibilityActor } from "./auth-policy";
import type { ActorRoleHints } from "./auth-policy";
import { enqueueAgentRun, enqueueDepsForTemplate } from "@/lib/agent-run-enqueue";
import type { AgentTemplateRecord } from "./store";
import { asActionablePreflightError } from "./actionable-preflight-error";
import { assertAgentPackageRunnable } from "./runtime-install-gate";
import {
  readAgentRunById,
  readAgentRunMessages,
  readAgentTemplateBySlug,
  readAgentTemplateById,
  transitionRunStatus,
  RunTransitionError,
  clearAgentRunFailureMetadata,
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
import {
  maybeHoldRunForRecommendation,
  readRecommendationParkForRun,
} from "./recommendation-hold";
import {
  advanceAgentRun,
  clearRunLifecycleMoment,
  launchAgentRun,
  runIdFromFailedLaunch,
} from "./lifecycle-coordinator";

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
  //
  // cinatra#2523: `pending_trigger` is the second pre-dispatch waiting state —
  // setup finished, the user is answering "When should this run?". A run parked
  // at the run-start recommendation interception from THERE is released through
  // this same canonical dispatcher, so refusing it outright would leave the
  // chip-row decision with nothing to do and no way to say so.
  //
  // But this is a PUBLIC server action, so "the owner asked" is not enough to
  // admit that state: it would let a run be dispatched straight past the trigger
  // step the state exists to wait for. Admit it only on the evidence that put it
  // here — a run-start recommendation park that has been DECIDED.
  //
  // "Decided" is checked HERE, not left to the live-park short-circuit below:
  // that read and the hold evaluation after it are both fail-OPEN, so a
  // truthiness test on the park row would let an undecided run through whenever
  // those reads failed (codex round-3 finding). A missing park, an unreadable
  // park, and a park still `parked` all refuse.
  if (run.status !== "pending_input") {
    const park =
      run.status === "pending_trigger"
        ? await readRecommendationParkForRun(args.runId).catch(() => null)
        : null;
    if (!park || park.status === "parked") {
      return { ok: false, error: "run is not in pending_input state" };
    }
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

  // 6. Atomic compare-and-swap onto `queued`. Returns false if a concurrent
  //    request already won the race.
  //
  // cinatra#2523 made this a two-rung ladder for the same reason as the state
  // check above: both pre-dispatch waiting states are legal dispatch sources,
  // and the rung that WINS is remembered so the compensation below reverts the
  // run to where it actually was rather than rewriting its state.
  //
  // CONTINUE IS ADVANCE (cinatra#2928). Both rungs go through the coordinator's
  // release entry. The rung ladder is unchanged, and the release is asked to
  // THROW on a lost race precisely so the losing rung stays distinguishable
  // from the winning one.
  //
  // THE MOMENT IS CLEARED AFTER THE ENQUEUE BELOW, not inside the release: this
  // frame owns the dispatch (`caller_dispatches`), so the release cannot see
  // whether the run really got a job, and a clear made before that answer is
  // lost the moment the compensation puts the run back at its wait — leaving a
  // parked run with nothing to say what it is waiting for.
  let dispatchedFrom: (typeof RUN_START_DISPATCH_FROM_STATUSES)[number] | null = null;
  for (const from of RUN_START_DISPATCH_FROM_STATUSES) {
    try {
      await advanceAgentRun({
        run,
        release: {
          reason: "continue",
          from,
          to: "queued",
          onLostRace: "throw",
          dispatch: {
            kind: "caller_dispatches",
            why: "the compensation below reverts to the rung that actually won, so this frame owns the enqueue",
          },
        },
        authority,
      });
      dispatchedFrom = from;
      break;
    } catch (err) {
      if (err instanceof RunTransitionError && err.code === "stale_from_status") continue;
      throw err;
    }
  }
  if (dispatchedFrom === null) {
    return { ok: false, error: "run is not in pending_input state" };
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
    // Revert to the state the run was ACTUALLY in (cinatra#2523) — reverting a
    // `pending_trigger` run to `pending_input` would silently undo its finished
    // setup step and send the user back through the form.
    await transitionRunStatus(
      args.runId,
      "queued",
      dispatchedFrom,
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

  // DISPATCHED — the moment is over (cinatra#2928). The clear is COMPARE-AND-
  // CLEAR ON THE MOMENT, not on a status: it takes off the moment it read, so a
  // run that has parked again in the meantime keeps whatever its new park
  // stated. A status guard would be the wrong shape here — the status this frame
  // dispatched into is left almost at once, as soon as a worker picks the run
  // up, and a clear pinned to it would miss the ordinary case.
  await clearRunLifecycleMoment(args.runId, authority);

  return { ok: true };
}

/**
 * The run statuses the canonical run-START dispatcher accepts (cinatra#2523).
 * Both are PRE-DISPATCH waiting states with a legal `→queued` edge:
 *   - `pending_input`   — created, never dispatched (or returned from `armed`);
 *   - `pending_trigger` — setup finished, awaiting the user's trigger choice.
 *
 * Declared next to `triggerAgentRun` because the run-start recommendation
 * chip-row releases its park through it: a run parked from `pending_trigger`
 * must dispatch on the decision, not be misread as "already advanced".
 */
const RUN_START_DISPATCH_FROM_STATUSES = ["pending_input", "pending_trigger"] as const;

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
  // Routed through the coordinator (cinatra#2928). This creates the run and
  // STOPS: the Run button triggers it later, and the moments that apply at a
  // run's start are decided when it starts. Presence is not asserted here
  // either — the coordinator derives it from this interactive claim together
  // with the session user, so a call with no resolvable owner is headless
  // rather than a stamp nobody can act on.
  const launched = await launchAgentRun({
    producer: "run_page_pending",
    frame: { userId },
    interactive: true,
    authority,
    create: {
      kind: "pre_dispatch",
      input: {
        templateId: template.id,
        runBy: userId,
        inputParams: {},
        orgId,
      },
    },
    dispatch: {
      kind: "await_trigger",
      why: "the run page creates the row and the Run button triggers it; the setup loop asks for its fields then",
    },
  });
  if (launched.carrier.kind !== "run") {
    return { ok: false, error: "the launch answered with a carrier that is not a run" };
  }

  return { ok: true, runId: launched.carrier.run.id };
}

// Create a run AND immediately trigger it so the user lands on the Setup tab
// and sees HITL interrupt forms without a second button click.

async function createAndTriggerRunCore(
  userId: string,
  orgId: string,
  template: AgentTemplateRecord,
): Promise<CreatePendingRunResult> {
  // RUNTIME-LIFECYCLE + PROVISIONING GATE (cinatra#659, cinatra#2605). This is
  // the run-start the /agents card's Run link lands on, so it must apply the
  // SAME verdict the card was built from — otherwise a bookmark or a typed
  // /agents/<package>/new URL starts exactly the run the picker refused to
  // offer. Same shared gate, same refusal texts, same fail-open semantics as
  // `agent_run`; ADDITIVE — the session/tenancy authority below is unchanged.
  const notRunnable = await assertAgentPackageRunnable(
    template.packageName,
    template.packageName ?? template.name,
    { packageVersion: template.packageVersion ?? null },
  );
  if (notRunnable) return { ok: false, error: notRunnable.error };
  // orgId is resolved by the caller (do NOT re-resolve session inside this
  // helper) and threaded through to createAgentRunPendingInput.
  // cinatra#1940 P3 (Decision 2): mint the member session authority ONCE, up
  // front — reused for BOTH the guarded create below and the subsequent
  // pending_input→queued transition (was previously minted only for the
  // transition, after the — then unguarded — create).
  const authority = await verifySessionAuthority(userId, orgId);

  // ONE ORDERING, IN ONE PLACE (cinatra#2928). This function used to carry its
  // own copy of create-parked → evaluate the recommendation → release-or-park →
  // enqueue → compensate, which is the same sequence the `agent_run` primitive
  // carried and the same one the coordinator now owns. The copy is gone; what
  // is left here is this surface's own reading of the answer.
  //
  // The compensation ladder that stood below is the coordinator's now, and it is
  // stricter: it reverts to `pending_input`, failing that fails the run with the
  // reason, and only then throws — so a run can no longer be left `queued` with
  // no job behind it. The actionable-preflight conversion this surface needs
  // stays here, where the caller can act on it.
  let launched;
  try {
    launched = await launchAgentRun({
      producer: "run_page_create_and_trigger",
      frame: { userId },
      interactive: true,
      authority,
      template: {
        packageName: template.packageName,
        lifecycleConfig: (template as { lifecycleConfig?: string | null }).lifecycleConfig,
      },
      create: {
        kind: "pre_dispatch",
        input: {
          templateId: template.id,
          runBy: userId,
          inputParams: {},
          orgId,
        },
      },
      dispatch: {
        kind: "enqueue",
        // cinatra#1056 connector edges + cinatra#1062 LLM-provider package identity.
        // The job id is the run's own, as it has always been — read off the run
        // the coordinator created, because the pre-dispatch creator mints it.
        options: (run) => ({ jobId: run.id, ...enqueueDepsForTemplate(template) }),
      },
    });
  } catch (enqueueErr) {
    // An actionable connector/LLM-provider preflight failure won't fix on retry
    // — surface it so the user can configure the provider (cinatra#1056/#1062),
    // rather than reporting a false success with a silently-pending run. The
    // run has already been compensated back to a decidable state by the
    // coordinator, so the retry the message asks for has somewhere to land.
    const actionable = asActionablePreflightError(enqueueErr);
    if (actionable) return { ok: false, ...actionable };
    throw enqueueErr;
  }
  if (launched.carrier.kind !== "run") {
    return { ok: false, error: "the launch answered with a carrier that is not a run" };
  }

  return { ok: true, runId: launched.carrier.run.id };
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

  // For vendor-scoped packages (@vendor/name), agentSlug becomes "vendor/name"
  // so router.push paths match /agents/[vendor]/[pkg]/... routing.
  const resolvedPkg = template.packageName ?? packageName;
  const resolvedMatch = resolvedPkg.match(/^@([^/]+)\/(.+)$/);
  const agentSlug = resolvedMatch ? `${resolvedMatch[1]}/${resolvedMatch[2]}` : fallbackSlug;
  const previewResult = (
    runId: string,
    heldForRecommendation: boolean,
  ): StartDevChildPreviewResult => ({
    ok: true,
    runId,
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
  // recommendations exist". It consults the SAME hold as every other
  // interactive run-start, and since cinatra#2928 it does so by taking the SAME
  // road: the coordinator's launch, which owns the ordering this function used
  // to repeat. Parked ⇒ return the panel metadata WITHOUT dispatching (the
  // embedded child panel renders the chip-row, whose decision releases the park
  // through the canonical trigger path).
  let launched;
  try {
    launched = await launchAgentRun({
      producer: "run_page_dev_preview",
      frame: { userId },
      interactive: true,
      authority,
      template: {
        packageName: template.packageName,
        lifecycleConfig: (template as { lifecycleConfig?: string | null }).lifecycleConfig,
      },
      create: {
        kind: "pre_dispatch",
        input: {
          templateId: template.id,
          runBy: userId,
          inputParams: {},
          orgId,
        },
      },
      dispatch: { kind: "enqueue", options: (run) => ({ jobId: run.id }) },
    });
  } catch (err) {
    // THE PREVIEW'S OWN POSTURE, UNCHANGED — and now the code says what the
    // comment always did (cinatra#2928 review, finding 2). A dispatch failure is
    // logged and the panel still opens ON THE RUN THAT EXISTS: this surface is
    // the only route a person has to that run, so discarding its id would leave
    // them a run created for them that nothing points at.
    //
    // The run is in BETTER shape than it was before this slice — the
    // coordinator's ladder has already returned it to `pending_input`, where it
    // is decidable and retryable, instead of the base's `queued` with no job
    // behind it — and it is not held for a recommendation, because the launch
    // got past the hold and failed at the dispatch.
    console.error("[startDevChildPreviewRun] launch failed", err);
    const createdRunId = runIdFromFailedLaunch(err);
    if (createdRunId !== null) return previewResult(createdRunId, false);
    // NO RUN WAS CREATED — the launch failed before there was one (a refused
    // create, a missing authority). There is nothing for a panel to open on, so
    // the caller gets the error, which is what it already did for every failure
    // ahead of this point.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (launched.carrier.kind !== "run") {
    return { ok: false, error: "the launch answered with a carrier that is not a run" };
  }
  return previewResult(launched.carrier.run.id, launched.moment === "recommendation");
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
