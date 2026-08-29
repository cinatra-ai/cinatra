import "server-only";

// ---------------------------------------------------------------------------
// Actor-aware trigger CRUD service.
//
// Single source of truth for trigger configuration's auth + business logic.
// Server-action wrappers in run-actions.ts resolve the Better Auth session
// into a TriggerActorContext, then delegate here. MCP handlers in
// mcp/handlers.ts construct the same envelope from `request.actor` and
// delegate. Both surfaces hit identical enforcement code — no drift.
//
// Design rule: this module NEVER touches the Better Auth session.
// Programmatic MCP clients have no browser session, only the actor envelope
// on the request. The server-action wrapper is the ONLY place that
// translates the session into an actor.
// ---------------------------------------------------------------------------

import {
  createOrUpdateRunTrigger,
  readRunTriggerByRunId,
  deleteRunTriggerByRunId,
  stopRunTriggerInDb,
  type TriggerType,
  type TriggerRecord,
} from "./trigger-store";
import { scheduleTrigger, cancelTriggerSchedule } from "./trigger-schedule";
// Run-start recommendation hold (cinatra#2067 C3 / #2148 finding 3) — the
// immediate-trigger transition is a run-START dispatch and must consult the same
// hold every other interactive run-start does.
import { maybeHoldRunForRecommendation } from "./recommendation-hold";
import {
  advanceAgentRun,
  clearRunLifecycleMoment,
} from "./lifecycle-coordinator";
import {
  transitionRunStatus,
  RunTransitionError,
  readAgentRunById,
  readAgentTemplateById,
} from "./store";
// cinatra#1939 wave 2 (§2a): the acting owner/org-admin member session grounds
// the trigger's run-status flips. A member mint fail-closes for a non-member
// principal (e.g. a cross-org platform admin) — the design's deliberate
// member-session choice for trigger ops (not a §2d′ non-member site).
import { verifySessionAuthority } from "@/lib/org-write/authority";
import { markTriggerReleased } from "./trigger-gate";
// SAVE CHANGES translates §VI's selections into the scheduler's fields with the
// SAME `buildCron` the scheduling step and the proposal producer submit with, so
// a schedule saved from the card and one armed from the form cannot differ.
import { buildCron, type RecurringConfig } from "./trigger-recurrence";
// cinatra#2981 — the ONE serialization this service, **Cancel schedule** and the
// release job's fire decision all take. See trigger-claim.ts for what a claim
// guarantees and where the BullMQ/Redis boundary limits it.
import {
  withTriggerClaim,
  TriggerClaimUnavailableError,
} from "./trigger-claim";

/** Stable code carried by AgentTemplateScopeError (cinatra#2485 C) — branch on
 *  the CODE, not `instanceof`, so a refusal is recognized across the dynamic
 *  import boundary the dispatch guard is reached through. */
const AGENT_TEMPLATE_SCOPE_DENIED_CODE = "AGENT_TEMPLATE_SCOPE_DENIED";
const isScopeDenial = (err: unknown): err is { reason: string } =>
  (err as { code?: string } | null)?.code === AGENT_TEMPLATE_SCOPE_DENIED_CODE;

// Schedule↔PM-task sync (cinatra#317). packages/agents calls OUT to the
// host-owned PM provider bridge via the Next.js "@/lib/*" alias (Option 2 / the
// host-owned PM provider bridge); it NEVER imports the SDK PM registry or any
// Plane code. Both functions are fail-open — the trigger lifecycle is
// authoritative for the LOCAL schedule and never throws on a PM outage.
// trigger-service.ts is server-only and compiles inside the host bundle, so
// "@/lib/*" resolves at runtime (the same indirection list-picker-actions.ts /
// external-mcp-caller.ts use for host-resolved outbound integration).
import {
  syncRunTriggerPmTask,
  deleteRunTriggerPmTask,
} from "@/lib/pm-integration-providers";
// cinatra#2523: the immediate trigger must put a JOB on the queue, not only
// write a status. `enqueueAgentRun` is the single sanctioned dispatch
// chokepoint (scripts/audit/agent-builder-enqueue-gate.mjs) and re-asserts the
// install-scope guard — the same call the trigger release job makes, with the
// same compensation shape.
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";
import { asActionablePreflightError } from "./actionable-preflight-error";

/**
 * Terminal run statuses (cinatra#2482). A run in one of these has no legal edge
 * back into dispatch, so an IMMEDIATE trigger against it is refused rather than
 * silently swallowed. Kept local — importing the run-status module here would
 * pull the store/bullmq chain into every trigger call site.
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Actor envelope accepted by the service layer. Mirrors the MCP request
 * actor shape; server-action callers construct an equivalent envelope from
 * the Better Auth session.
 *
 * - `userId` MUST be present for any non-public operation. The service
 *   refuses requests with empty userId (defense in depth: even if a
 *   handler somehow forwards an empty actor, the service still rejects).
 * - `role === "admin"` enables ownership bypass for read/cancel paths
 *   (operations support). For setRunTrigger this is a no-op — admins
 *   there is no override: plan (A) §7.2 as amended 2026-08-25 withdrew Run now
 *   from every surface (cinatra#2972).
 * - `source` is for audit logging only and is not interpreted by this
 *   layer ("ui" | "mcp" | "worker" | "scheduler" | etc).
 */
export type TriggerActorContext = {
  userId: string;
  role?: string | null;
  source?: string;
};

export type SetTriggerForActorArgs = {
  runId: string;
  triggerType: TriggerType;
  scheduledAt?: string;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
};

export type SetTriggerForActorResult =
  | { ok: true; runId: string; jobSchedulerId: string | null }
  | { ok: false; error: string };

/**
 * OPT-IN REPLACE STRICTNESS for `setRunTriggerForActor` (cinatra#2788).
 *
 * WHY IT IS A MODE AND NOT THE DEFAULT. The ordinary callers of this function —
 * the MCP handlers, `run-actions.ts`, the proposal service's install — are
 * ARMING a trigger, and for them a prior scheduler that refuses to cancel is a
 * warning on the way to the arm they asked for. The SAVE path is different: it
 * is a REPLACEMENT of a schedule the reader is already looking at, so an
 * uncancelled predecessor is not a blemish on the result — it IS a second live
 * scheduler for the same run, and the reader was told there is one. Making the
 * strictness the default would change the arming callers' behaviour, so the
 * save path selects it and nobody else's contract moves.
 */
export type SetTriggerReplaceStrictness = {
  /**
   * Refuse the whole operation when the prior scheduler cannot be cancelled,
   * rather than logging and installing a replacement beside it. Nothing is
   * written when this fires: the refusal happens BEFORE the upsert, so the
   * schedule the reader already has stays exactly as it was.
   */
  failClosedOnCancelFailure: boolean;
  /**
   * Re-run the caller's own guard against the row THIS function reads
   * immediately before the cancel — the same row the cancel and the upsert act
   * on. Returning a string refuses with it; `null` proceeds.
   *
   * This is the "pass the verified snapshot through and refuse on mismatch"
   * half: a caller that checked released/fired state against an EARLIER read
   * has an open window between its check and this write, and re-asking here
   * closes it against the read that actually matters.
   */
  reverify?: (existing: TriggerRecord | null) => string | null;
};

export type GetTriggerForActorResult =
  | { ok: true; trigger: TriggerRecord | null }
  | { ok: false; error: string };

export type DeleteTriggerForActorResult =
  | { ok: true }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a timezone-naive "YYYY-MM-DDTHH:MM" (or "YYYY-MM-DDTHH:MM:SS")
 * string — as produced by an HTML datetime-local input — to a UTC epoch ms
 * value, interpreting the wall-clock time in the given IANA timezone.
 *
 * Why not `new Date(naive)`? Node.js parses naive strings in local time
 * (UTC on servers), ignoring the user-selected timezone. This helper uses
 * the Intl.DateTimeFormat API (no external dependency) to resolve the
 * offset at the exact moment, handling DST transitions correctly.
 */
/**
 * `cron-parser` module shapes the recurring-trigger validator accepts.
 * See the resolution note at the call site in {@link setRunTriggerForActor}.
 */
type ParsedCronExpression = { next: () => unknown };
type CronParser = {
  parse: (expression: string, options?: { tz?: string }) => ParsedCronExpression;
};
type CronParserModule = {
  CronExpressionParser?: Partial<CronParser>;
  default?: Partial<CronParser> & { CronExpressionParser?: Partial<CronParser> };
};

function resolveCronParser(mod: CronParserModule): CronParser | null {
  const candidates = [mod.CronExpressionParser, mod.default?.CronExpressionParser, mod.default];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.parse === "function") {
      return candidate as CronParser;
    }
  }
  return null;
}

function naiveDatetimeToUtcMs(naive: string, timezone: string): number {
  // Normalise to full seconds precision.
  const padded = naive.length === 16 ? naive + ":00" : naive;
  // Treat the string as UTC to get a reference epoch.
  const asUtcMs = new Date(padded + "Z").getTime();
  if (Number.isNaN(asUtcMs)) return NaN;
  // Re-format that reference epoch in the target timezone to find its
  // wall-clock representation there.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(asUtcMs));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const tzYear = get("year");
  const tzMonth = get("month");
  const tzDay = get("day");
  const rawHour = get("hour");
  // hour12: false can return "24" for midnight — normalise to "00".
  const tzHour = rawHour === "24" ? "00" : rawHour;
  const tzMinute = get("minute");
  const tzSecond = get("second");
  // Treat the reformatted parts as UTC to get the timezone's interpretation
  // of the reference epoch.
  const inTzMs = new Date(
    `${tzYear}-${tzMonth}-${tzDay}T${tzHour}:${tzMinute}:${tzSecond}Z`,
  ).getTime();
  // The offset is the difference; adding it back converts the naive input
  // (interpreted as that timezone) to a true UTC epoch.
  const offsetMs = asUtcMs - inTzMs;
  return asUtcMs + offsetMs;
}

function isOwnerOrAdmin(
  actor: TriggerActorContext,
  runOwnerId: string | null,
): boolean {
  if (actor.role === "admin") return true;
  // Unowned runs (runBy: null) require admin — any authenticated user should
  // NOT be able to schedule or delete triggers on runs they did not create.
  // The old "bypass for legacy runs" rationale does not apply to trigger ops
  // which have permanent schedule effects.
  if (!runOwnerId) return false;
  return runOwnerId === actor.userId;
}

/**
 * Fail-closed configuration-needs check for the IMMEDIATE trigger surface
 * (cinatra #1057 ruling (b)). An immediate trigger transitions the run straight
 * to `queued` for the dispatcher, bypassing the fire-time gate that
 * trigger-release-job applies to scheduled/recurring fires — so the immediate
 * surface needs its OWN check. Resolves the run's agent package from its
 * template and asks the shared run-readiness predicate whether every REQUIRED
 * connector is configured **for the RUN OWNER** (`run.runBy`), returning a human
 * error naming each still-unconfigured connector (by displayName) when the
 * dispatch must be refused, or `null` when the agent may run (out of scope /
 * untracked / fully configured).
 *
 * Keys on `run.runBy`, NOT the acting principal — an admin may trigger another
 * user's run (`isOwnerOrAdmin`), and readiness must reflect the OWNER's
 * connector state (exactly as trigger-release-job's fire gate does), never the
 * admin's. For the ordinary owner-triggers-own-run path the two coincide.
 *
 * Posture mirrors trigger-release-job's fire gate: a DETERMINATE unconfigured
 * result blocks (the readiness derivation is itself fail-soft→blocking at the
 * probe boundary), while a thrown INFRA error is non-determinate and left to the
 * downstream backstops rather than stranding the trigger call (fail-open).
 */
async function immediateTriggerConfigBlock(
  templateId: string,
  runOwnerUserId: string | null,
): Promise<string | null> {
  try {
    const template = await readAgentTemplateById(templateId);
    if (!template?.packageName) return null;
    const { assertAgentRunReadyByPackage } = await import(
      "@/lib/agent-run-readiness"
    );
    const block = await assertAgentRunReadyByPackage(
      template.packageName,
      template.packageName,
      { userId: runOwnerUserId ?? null },
    );
    return block ? block.error : null;
  } catch (err) {
    console.warn(
      "[setRunTriggerForActor] immediate config-needs gate errored — allowing (fail-open):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * The run statuses an immediate trigger may legally dispatch FROM, in the order
 * they are attempted (cinatra#2523). Every one of these is an existing legal
 * `→queued` edge:
 *
 *   - `pending_trigger` — the wizard's setup-success hand-off (execution.ts):
 *     setup is done and the user is answering "When should this run?". This is
 *     the documented main path this issue was filed about.
 *   - `pending_input`  — a run created but never dispatched (the zero-input
 *     create path, a run returned from `armed` when its trigger was removed).
 *   - `armed`          — a run holding a scheduled/recurring trigger that the
 *     user has just re-configured to "run now". Its old schedule was cancelled
 *     higher up, so without this rung nothing would ever fire it.
 */
const IMMEDIATE_DISPATCH_FROM_STATUSES = [
  "pending_trigger",
  "pending_input",
  "armed",
] as const;

/**
 * Human-readable refusal for a run an immediate trigger cannot dispatch.
 * Every arm names the state AND the action that clears it — the honesty half of
 * cinatra#2523: a refusal the user cannot act on is barely better than the
 * silent success it replaces.
 */
function immediateRefusalCopy(status: string): string {
  if (TERMINAL_RUN_STATUSES.has(status)) {
    return "This run has already finished — it can't be run again. Start a new run instead.";
  }
  if (status === "pending_approval") {
    return "This run is still waiting for an answer in its setup form. Finish setup — it will run as soon as you do.";
  }
  if (status === "waiting_trigger") {
    return "This run is already in progress and paused at a trigger step inside its flow. It resumes on its own — it can't be restarted from here.";
  }
  return `This run can't be started right now (it is ${status}). Reload the run and try again.`;
}

/**
 * Perform an immediate trigger's ACTUAL dispatch (cinatra#2523).
 *
 * The gate is already open (`scheduleTrigger` marked it released), so this is
 * the whole of "Run now": move the run onto `queued` through a legal edge, and
 * put a job on the queue for it.
 *
 * Two things here are load-bearing and neither was true before:
 *
 *  1. NO SWALLOW. A refused transition used to be caught, logged and followed by
 *     `{ok:true}` — which is how the documented main path came to report success
 *     having dispatched nothing. Now every refusal that is still logically
 *     possible is returned as `{ok:false}` with copy the user can act on. The one
 *     honest exception is a run ALREADY on its way: `running` (executing right
 *     now) or `queued` (a job is enqueued below) both satisfy "run it now".
 *
 *  2. THE ENQUEUE. `transitionRunStatus` writes a row; it does not put anything
 *     on a queue. Before this, the immediate branch transitioned and stopped, and
 *     the run only ever ran when some OTHER job happened to be parked on the
 *     trigger gate — for a run that never parked (every ungated agent, every
 *     `pending_input` run) nothing ever picked it up.
 *
 * Scope denials keep the existing compensation: the trigger row and the released
 * gate are already durable, so a refused run must not be left holding an armed
 * immediate trigger no dispatch will consume.
 */
async function dispatchImmediateNow(
  runId: string,
  actor: TriggerActorContext,
  authority: Awaited<ReturnType<typeof verifySessionAuthority>>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  /** Unwind the durable half of the gate this call already opened. */
  const unwindTrigger = async () => {
    await deleteRunTriggerByRunId(runId).catch((cleanupErr) => {
      console.error(
        "[setRunTriggerForActor] cleanup after refused immediate dispatch failed",
        runId,
        cleanupErr,
      );
    });
    // Deleting the row clears only the DURABLE half of the gate. The immediate
    // path already called `markTriggerReleased`, whose Redis flag is read FIRST
    // and outlives the row for up to 7 days — leaving it would make a later
    // re-trigger on this run fire immediately instead of on its new schedule.
    const { clearTriggerReleased } = await import("./trigger-gate");
    await clearTriggerReleased(runId);
  };

  let transitionedFrom: (typeof IMMEDIATE_DISPATCH_FROM_STATUSES)[number] | null = null;
  for (const from of IMMEDIATE_DISPATCH_FROM_STATUSES) {
    try {
      // cinatra#2485 C — thread the DISPATCHING human into the `→queued` guard.
      // `isOwnerOrAdmin` admits `role === "admin"`, i.e. an actor who is NOT the
      // run's owner; without this the guard would evaluate only `run_by` and let
      // an admin outside the agent's team/project fire an in-scope owner's run.
      // Same rule as the trigger release job and the two HITL gates: both the ACTOR
      // and the run OWNER must be inside scope.
      await transitionRunStatus(runId, from, "queued", undefined, authority, {
        actingUserId: actor.userId,
      });
      transitionedFrom = from;
      break;
    } catch (err) {
      // cinatra#2485 C — a SCOPE DENIAL from the `→queued` guard is a decision,
      // not a fault: map it to this function's documented opaque result instead
      // of letting the raw AgentTemplateScopeError (which names the template id,
      // reason and level) escape to the caller.
      if (isScopeDenial(err)) {
        await unwindTrigger();
        return { ok: false, error: "forbidden" };
      }
      // Not this `from` — try the next legal one.
      if (err instanceof RunTransitionError && err.code === "stale_from_status") {
        continue;
      }
      throw err;
    }
  }

  if (transitionedFrom === null) {
    // No legal edge from wherever the run actually is. Say what is true.
    const current = await readAgentRunById(runId);
    if (!current) return { ok: false, error: "run not found" };
    if (current.status === "running") {
      // Already executing — the user's "run it now" is satisfied.
      return { ok: true };
    }
    if (current.status !== "queued") {
      // Deliberately NOT unwound: the run is mid-lifecycle (e.g. still in its
      // setup form, or paused at an in-flow trigger wait) and the trigger row is
      // the user's standing configuration, which other machinery reads. Removing
      // it here would break the very flow the copy tells them to finish.
      return { ok: false, error: immediateRefusalCopy(current.status) };
    }
    // `queued` already — fall through and make sure it actually has a job.
  }

  // Enqueue the execution job now that the run is queued and the gate is open.
  // Idempotent on jobId, and identical in shape to the release job's enqueue.
  try {
    await enqueueAgentRun({ runId }, { jobId: `agent-builder-${runId}` });
  } catch (err) {
    // The run is already `queued` at this point; leaving it there with no job is
    // the exact stranding this function exists to stop. EVERY enqueue failure is
    // compensated, not just the authorization one (codex round-3 finding) — a
    // connector/LLM preflight refusal or a Redis blip would otherwise leave a
    // permanently queued run behind an `ok:false`.
    //
    // A SCOPE DENIAL is terminal for the run (the cinatra#2485 C contract: a
    // denied run fails, it is never parked), so it lands `failed` with the
    // authority this frame holds — the chokepoint deliberately may not mint one
    // (org-write-boundary-gate R2/R5). Every other failure is transient, so the
    // run goes back to where it came from and stays retryable.
    const denial = isScopeDenial(err);
    // `transitionedFrom === null` means the run was ALREADY `queued` when this
    // call arrived (we only ensured it had a job), so there is nothing of ours to
    // revert — the writer that queued it owns its state.
    const compensateTo = denial ? ("failed" as const) : transitionedFrom;
    await (compensateTo === null
      ? Promise.resolve()
      : transitionRunStatus(
          runId,
          "queued",
          compensateTo,
          denial
            ? { error: `run refused: the agent's scope no longer authorizes this run (${err.reason})` }
            : undefined,
          authority,
        )
    ).catch((compErr) => {
      if (!(compErr instanceof RunTransitionError && compErr.code === "stale_from_status")) {
        console.error(
          "[setRunTriggerForActor] immediate dispatch failed but the run could not be compensated — it stays queued with no job:",
          runId,
          compErr instanceof Error ? compErr.message : String(compErr),
        );
      }
    });
    await unwindTrigger();
    if (denial) {
      return { ok: false, error: "forbidden — this agent's scope does not include you" };
    }
    // Surface an actionable connector / LLM-provider preflight refusal
    // (cinatra#1056/#1062) instead of a generic failure, exactly as the
    // canonical run-start dispatcher does.
    const actionable = asActionablePreflightError(err);
    return {
      ok: false,
      error:
        actionable?.error ??
        "This run could not be started just now — please try again.",
    };
  }

  // THE MOMENT IS OVER (cinatra#2928). This is the OTHER Continue: choosing
  // "run right after setup" on the schedule screen releases a run parked at
  // `pending_trigger` exactly as the run page's Continue does, so it has to
  // clear what the run says it is waiting at. Without it a run could begin
  // executing while still stating the schedule moment, and every host would keep
  // mounting that card.
  //
  // LAST, after the enqueue, for the reason `advanceAgentRun` clears last: every
  // failure above compensates the run BACK to where it came from, and a run
  // returned to its wait with nothing left to say what it is waiting for is a
  // park with no card. Reaching this line means the run really is dispatched.
  //
  // The helper compares before it clears, so a run that has already reached a
  // NEW moment — a worker fast enough to pick it up and park it again — keeps
  // that one rather than having it taken off by this call.
  //
  // Best-effort by construction — the helper swallows and logs — so a
  // bookkeeping write can never strand a run that is already on its way.
  await clearRunLifecycleMoment(runId, authority);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// setRunTriggerForActor — configure a trigger for `runId` on behalf of `actor`.
// ---------------------------------------------------------------------------
/**
 * Configure a trigger for `runId` on behalf of `actor`.
 *
 * Enforces ownership; validates cron/scheduledAt server-side; cancels any
 * prior schedule BEFORE upserting (no orphan jobs); flips run status
 * pending_input → armed (with pending_trigger → armed fallback) for
 * scheduled/recurring trigger types.
 *
 * Same code path is used by server actions and MCP handlers — the actor
 * envelope is the only auth input.
 */
export async function setRunTriggerForActor(
  actor: TriggerActorContext,
  args: SetTriggerForActorArgs,
  strictness?: SetTriggerReplaceStrictness,
): Promise<SetTriggerForActorResult> {
  if (!actor.userId) return { ok: false, error: "unauthorized" };

  const run = await readAgentRunById(args.runId);
  if (!run) return { ok: false, error: "run not found" };
  if (!isOwnerOrAdmin(actor, run.runBy ?? null)) {
    return { ok: false, error: "forbidden" };
  }

  // IMMEDIATE TERMINAL-RUN GATE (cinatra#2482, closed by cinatra#2523).
  //
  // An immediate trigger's entire contract is "dispatch NOW". A terminal run has
  // no legal edge back into dispatch, so this call must refuse and name the real
  // next action rather than rewrite the trigger row and report success.
  //
  // This gate used to carry ONE carve-out: `completed` with no trigger row was
  // read as cinatra#580's setup-success first arm and let through — whereupon the
  // `→queued` CAS below failed and the failure was SWALLOWED, so the documented
  // main path returned `{ok:true}` having dispatched nothing (cinatra#2523).
  // Remedy (c) removed the premise: setup no longer ENDS in `completed` (the
  // hand-off in execution.ts lands the run on `pending_trigger`), so the
  // exemption has nothing left to exempt and every terminal status is refused
  // alike. A genuinely finished run is never resurrected.
  //
  // Scheduled/recurring are never gated here: their row is a future-fire
  // schedule, meaningful independently of this run's own outcome.
  if (args.triggerType === "immediate" && TERMINAL_RUN_STATUSES.has(run.status)) {
    return {
      ok: false,
      error:
        "This run has already finished — it can't be run again. Start a new run instead.",
    };
  }

  // IMMEDIATE IN-FLIGHT-WAIT GATE (cinatra#2523, codex round-1 finding).
  //
  // `waiting_trigger` is an IN-FLIGHT run paused at a TriggerWaitNode inside its
  // own flow: the trigger-release job resumes it by sending an A2A message into
  // its held context, using THIS row. Refusing it late — after the cancel +
  // upsert below — would cancel the scheduler that owns the resume and overwrite
  // the row with an immediate trigger that enqueues no release job, stranding a
  // live run. Refuse before any write instead.
  if (args.triggerType === "immediate" && run.status === "waiting_trigger") {
    return {
      ok: false,
      error:
        "This run is already in progress and paused at a trigger step inside its flow. It resumes on its own — it can't be restarted from here.",
    };
  }

  // CONFIGURATION-NEEDS RUN GATE — IMMEDIATE trigger surface (cinatra #1057
  // ruling (b)): an immediate trigger dispatches NOW (transitions the run to
  // `queued` below), so refuse it fail-closed BEFORE any trigger row or schedule
  // is created when the agent's REQUIRED connectors are not yet configured for
  // this user, naming each unconfigured connector. Scheduled/recurring are NOT
  // gated at arm time — a connection may be configured before the future fire,
  // which the fire path (trigger-release-job) re-checks.
  if (args.triggerType === "immediate") {
    const notReady = await immediateTriggerConfigBlock(run.templateId, run.runBy ?? null);
    if (notReady) return { ok: false, error: notReady };
  }

  // Server-side validation — defence in depth + consistency between
  // server-action and MCP entry points.
  if (args.triggerType === "recurring") {
    if (!args.cronExpression) {
      return {
        ok: false,
        error: "cronExpression is required for recurring triggers",
      };
    }
    if (args.cronExpression.length > 256) {
      return {
        ok: false,
        error: "cronExpression too long (max 256 chars)",
      };
    }
    try {
      // PARSER API. `cron-parser` exposes the parser as the
      // `CronExpressionParser` class (also the module default); `parse` is a
      // STATIC method, so it is called on the class and never detached. The
      // resolution accepts the named export, a default-wrapped namespace
      // (CJS/ESM interop), and a default that IS the class — the three shapes
      // a bundler or interop wrapper can hand back for the same module. If
      // none resolves we fail CLOSED rather than arm a schedule whose
      // expression was never validated.
      const mod = (await import("cron-parser")) as unknown as CronParserModule;
      const parser = resolveCronParser(mod);
      if (!parser) {
        return { ok: false, error: "cron-parser unavailable" };
      }
      const parsed = parser.parse(args.cronExpression, { tz: args.timezone ?? "UTC" });
      // Take ONE iteration step as part of validation. `parse()` alone accepts
      // an unknown IANA zone and defers the failure to the first iteration —
      // i.e. to the moment the schedule is due, long after this call returned
      // "ok". Stepping once refuses it at ARM time instead, which is the
      // contract both call surfaces already assume.
      //
      // This is NOT a satisfiability guarantee: the parser's own
      // iteration-limit check is unreliable, and an expression that can never
      // match may return a non-matching date here rather than throwing. The
      // step exists to surface the LAZY failures (bad zone, un-iterable field
      // syntax), not to prove the schedule will ever fire.
      parsed.next();
    } catch (err) {
      return {
        ok: false,
        error: `invalid cron expression: ${(err as Error).message}`,
      };
    }
  }
  const tz = args.timezone ?? "UTC";

  if (args.triggerType === "scheduled") {
    if (!args.scheduledAt) {
      return {
        ok: false,
        error: "scheduledAt is required for scheduled triggers",
      };
    }
    // Interpret the naive datetime-local string in the user's selected
    // timezone rather than the server's local time (UTC on Node servers).
    const ts = naiveDatetimeToUtcMs(args.scheduledAt, tz);
    if (Number.isNaN(ts)) {
      return { ok: false, error: "scheduledAt is not a valid ISO datetime" };
    }
    if (ts <= Date.now()) {
      return { ok: false, error: "scheduledAt must be in the future" };
    }
  }

  // A ONE-OFF THAT HAS FIRED CANNOT BE CHANGED (cinatra#2928).
  //
  // A one-off schedule is a single instant, and once that instant has passed the
  // run it named has already been let go. Rewriting the row afterwards is not a
  // reschedule — it is a claim about a moment that is over. The screen refuses
  // it, and so does every server path that changes a trigger, which is what this
  // check makes true: the run page's form, the server action and the tool path
  // all arrive here.
  //
  // FIRED is read off the trigger's OWN record — `releasedAt`, the stamp the
  // release job writes when it opens the gate — never off the run's status,
  // which moves on for reasons that have nothing to do with the schedule.
  //
  // WHAT THIS COVERS, precisely: every caller of THIS function — the run page's
  // schedule form, the server action behind it, and the tool path — which is
  // every way a trigger's WHEN can be rewritten. Deleting a spent trigger row
  // is a different act and is deliberately not refused here: clearing a
  // schedule that has already run is tidying, not a claim about a past moment.
  //
  // THE WINDOW IS REAL AND IT IS NOT CLOSED HERE. A one-off can fire between
  // this read and the cancel/upsert below, exactly as it can between the
  // terminal-run gate (cinatra#2482) and the in-flight gate (cinatra#2523) that
  // stand above it — this function holds no lock on the trigger row and takes
  // none. Closing it needs a conditional write (`released_at IS NULL`) or a row
  // lock, which reshapes the trigger service rather than adding a refusal to
  // it. What this guard removes is the ordinary case: a person changing a
  // schedule they can see has already run.
  //
  // A RECURRING schedule is deliberately NOT refused: its future ticks are still
  // ahead of it, and a change applies to them. Ticks already fired are separate
  // runs of their own and no change here reaches back into them.
  //
  // BOTH ONE-OFFS, NOT ONE OF THEM (cinatra#2980). **Run right after setup** is
  // a one-off as much as **Schedule for later** is: its row is `immediate`, and
  // the immediate path stamps `releasedAt` through `markTriggerReleased` when it
  // opens the gate, exactly as a `scheduled` fire does. Naming `scheduled` alone
  // left a fired immediate row changeable, and the run page's standalone form
  // took that route — a finished run's own trigger row could be replaced with a
  // recurring schedule. The condition therefore reads the way the save guard
  // already reads it (`saveScheduleGuardRefusal` below): everything that is not
  // recurring is a one-off, so a one-off kind added later is refused by default
  // rather than let through by omission, which is precisely how `immediate` was
  // let through.
  //
  // AND A REPLAY OF THE SAME IMMEDIATE ARM IS NOT A CHANGE. `scheduleTrigger`
  // stamps `releasedAt` for an `immediate` trigger BEFORE this function
  // dispatches it (`markTriggerReleased`, then the recommendation hold, then
  // `dispatchImmediateNow`), and the installation path that arms an immediate
  // trigger is an at-least-once worker: a crash in that window leaves a stamped
  // row whose retry must still be able to finish. Refusing it would turn a
  // recoverable retry into a terminal park with "this schedule has already
  // fired" on a run that may never have been dispatched. An immediate request
  // against an immediate row rewrites no WHEN — it is the same instruction
  // arriving twice — so the ladder ABOVE this guard owns it: the terminal-run
  // gate refuses it on a finished run, the in-flight gate on a paused one, and
  // the recommendation hold answers a retry with the existing park. A fired
  // `scheduled` row asked for an immediate arm is NOT this case and stays
  // refused, exactly as cinatra#2928 shipped it.
  const beforeChange = await readRunTriggerByRunId(args.runId);
  const replaysTheSameImmediateArm =
    args.triggerType === "immediate" &&
    beforeChange?.triggerType === "immediate" &&
    // AND IT CARRIES NO SCHEDULE. `scheduledAt` and `cronExpression` are the two
    // fields that make a request a schedule, and the upsert below persists them
    // onto the row whatever the type says. An "immediate" request carrying one
    // is not the replay this exemption is for, so it is refused with the rest —
    // the exemption stays exactly "run now, again", which names no moment and
    // rewrites nothing (`timezone` is only ever read to interpret those two).
    !args.scheduledAt &&
    !args.cronExpression &&
    args.enabled !== false;
  if (
    beforeChange &&
    beforeChange.triggerType !== "recurring" &&
    beforeChange.releasedAt &&
    !replaysTheSameImmediateArm
  ) {
    // ONE SENTENCE FOR BOTH KINDS. The reader is told the same thing whichever
    // one-off they set, because it is the same fact about the same moment — and
    // the sentence names the next action that does work.
    return {
      ok: false,
      error:
        "This run's schedule has already fired, so it can't be changed. Start a new run to schedule it again.",
    };
  }

  // A STOPPED RECURRING SCHEDULE CANNOT BE CHANGED EITHER (cinatra#2972).
  //
  // Plan (A) §7.2 as amended 2026-08-25: **Cancel schedule** "stops the
  // recurring schedule and then makes the scheduler non-editable". The card
  // withholds the floor for exactly this state; this is the server saying the
  // same thing, so a request that reaches the service another way is refused
  // rather than quietly re-arming a schedule the person stopped.
  if (beforeChange && beforeChange.stoppedAt) {
    return { ok: false, error: SAVE_SCHEDULE_REFUSALS.stopped };
  }

  // THE REPLACEMENT RUNS UNDER THE CLAIM (cinatra#2981).
  //
  // Read existing row first → cancel old schedule → upsert (no orphan jobs) —
  // and all three under one claim, because the re-ask below could only ever be
  // as good as the interval after it. A **Cancel schedule** landing between the
  // re-ask and the upsert used to be accepted: the upsert writes `enabled` back
  // to true while `stopped_at` (deliberately absent from the store's SET clause)
  // survives, so the row came out of the race stopped AND enabled. For a
  // recurring→recurring save that self-healed on the next tick; for a
  // recurring→scheduled save it did not, because it also rewrote `trigger_type`
  // and the one-off fire path had no `stopped_at` check to save it.
  //
  // Under the claim there is no such interval. The row handed in below is read
  // while the claim is held, the cancel and both upserts happen before it is
  // released, and a stop waits and lands after — where it is the last word.
  //
  // THE READ IS STILL ITS OWN, not the gate's snapshot from the top of this
  // function: the cron/scheduledAt validation between them is asynchronous, so a
  // concurrent reconfiguration could install a scheduler after that earlier
  // snapshot and this call would then fail to cancel it, orphaning the job
  // (cinatra#2788).
  // Declared out here because the answer below still reports the installed
  // scheduler id; the claim body assigns it.
  let scheduleResult: { jobSchedulerId: string | null } = { jobSchedulerId: null };
  let refusal: SetTriggerForActorResult | null;
  try {
    refusal = await withTriggerClaim(
      args.runId,
      async (existing): Promise<SetTriggerForActorResult | null> => {

        // RE-ASK THE CALLER'S GUARD ON *THIS* READ (cinatra#2788).
        //
        // A caller that refused on released/fired state did so against an earlier
        // snapshot, and everything between that read and this one is asynchronous —
        // so a concurrent release can land in the gap and the caller's refusal never
        // runs again. Re-asking here binds the decision to the row the cancel and the
        // upsert are about to act on. Nothing has been written yet at this point, so
        // a refusal here leaves the reader's existing schedule untouched.
        if (strictness?.reverify) {
          const refusal = strictness.reverify(existing);
          if (refusal) return { ok: false, error: refusal };
        }
        // THE STOP STAMP WINS ON EVERY KIND SWITCH (cinatra#2981), and it is
        // asked HERE, unconditionally, rather than only through a caller's
        // `reverify` hook. Save changes passes that hook and would be refused
        // by it; the MCP `trigger_config_set` path and the run page's own form
        // do not, and a stopped schedule must not be re-armed from any of them.
        // Asked against the CLAIMED read, so this is the authoritative answer
        // rather than another snapshot with an interval after it.
        if (existing?.stoppedAt) {
          return { ok: false, error: SAVE_SCHEDULE_REFUSALS.stopped };
        }


        const oldJobSchedulerId = existing?.jobSchedulerId ?? null;
        const oldTriggerType = existing?.triggerType ?? null;
        if (oldJobSchedulerId && oldTriggerType) {
          try {
            await cancelTriggerSchedule({
              jobSchedulerId: oldJobSchedulerId,
              triggerType: oldTriggerType,
            });
          } catch (err) {
            // FAIL CLOSED FOR A REPLACEMENT (cinatra#2788). Continuing here installs
            // the new scheduler while the old one is still live: two schedulers on
            // one run, both able to fire it, and a reader who was shown exactly one
            // schedule. The replace path refuses instead — before the upsert, so
            // nothing is half-written and the prior schedule stands unchanged.
            if (strictness?.failClosedOnCancelFailure) {
              console.error(
                "[setRunTriggerForActor] cancel of prior schedule failed — refusing the replacement (nothing written)",
                args.runId,
                err,
              );
              return { ok: false, error: SAVE_SCHEDULE_REFUSALS.cancelFailed };
            }
            console.warn(
              "[setRunTriggerForActor] cancel of prior schedule failed (continuing)",
              args.runId,
              err,
            );
          }
        }

        // Upsert (no jobSchedulerId yet — set after scheduling).
        // NOTE: do NOT pass `releasedAt` — the store omits it from the SET clause
        // when undefined, preserving any prior value (matches the immediate-trigger
        // double-upsert path that calls markTriggerReleased between upserts).
        await createOrUpdateRunTrigger({
          runId: args.runId,
          triggerType: args.triggerType,
          scheduledAt: args.scheduledAt ? new Date(naiveDatetimeToUtcMs(args.scheduledAt, tz)) : null,
          cronExpression: args.cronExpression ?? null,
          timezone: tz,
          enabled: args.enabled ?? true,
          jobSchedulerId: null,
        });

        // Register the new schedule (compensate on failure).
          try {
          scheduleResult = await scheduleTrigger({
            runId: args.runId,
            triggerType: args.triggerType,
            scheduledAt: args.scheduledAt ? new Date(naiveDatetimeToUtcMs(args.scheduledAt, tz)) : undefined,
            cronExpression: args.cronExpression,
            timezone: tz,
          });
        } catch (err) {
          // THE COMPENSATION MUST NOT DELETE A SCHEDULE SOMEBODY STOPPED
          // (cinatra#2972). A **Cancel schedule** landing between this
          // save's re-verification and this failure leaves a STOPPED row — and the
          // cleanup below would delete it, taking away the schedule the person is
          // owed a reading of ("it never deletes the schedule"). A stopped row also
          // needs no cleanup: it names no live scheduler this call installed, because
          // this call is the one that just failed to install one.
          const stoppedMeanwhile = await readRunTriggerByRunId(args.runId).catch(() => null);
          if (stoppedMeanwhile?.stoppedAt) {
            console.warn(
              "[setRunTriggerForActor] schedule failed on a run stopped meanwhile — leaving the stopped row intact",
              args.runId,
            );
            return { ok: false, error: SAVE_SCHEDULE_REFUSALS.stopped };
          }
          await deleteRunTriggerByRunId(args.runId).catch((cleanupErr) => {
            console.error(
              "[setRunTriggerForActor] cleanup after schedule failure failed",
              args.runId,
              cleanupErr,
            );
          });
          return {
            ok: false,
            error: `schedule failed: ${(err as Error).message}`,
          };
        }

        // Persist final form (jobSchedulerId set). Same releasedAt-preservation note.
        await createOrUpdateRunTrigger({
          runId: args.runId,
          triggerType: args.triggerType,
          scheduledAt: args.scheduledAt ? new Date(naiveDatetimeToUtcMs(args.scheduledAt, tz)) : null,
          cronExpression: args.cronExpression ?? null,
          timezone: tz,
          enabled: args.enabled ?? true,
          jobSchedulerId: scheduleResult.jobSchedulerId,
        });

        return null;
      },
    );
  } catch (err) {
    if (err instanceof TriggerClaimUnavailableError) {
      // NOTHING WAS WRITTEN. The prior scheduler was never cancelled — the
      // cancel lives inside the claim — so the schedule the reader is looking at
      // is still the live one, which is exactly what `busy` tells them.
      return { ok: false, error: SAVE_SCHEDULE_REFUSALS.busy };
    }
    throw err;
  }
  if (refusal) return refusal;

  // Owner/org-admin member session grounds the status flips (§2a).
  const authority = await verifySessionAuthority(actor.userId, run.orgId);

  // Flip status based on trigger type:
  //   scheduled / recurring → pending_input (or pending_trigger) → armed
  //                           (gate will be opened later by the release job)
  //   immediate             → gate already opened by scheduleTrigger above;
  //                           transition directly to queued so the dispatcher
  //                           can pick up the run.
  if (args.triggerType === "scheduled" || args.triggerType === "recurring") {
    try {
      await transitionRunStatus(args.runId, "pending_input", "armed", undefined, authority);
    } catch (err) {
      if (
        err instanceof RunTransitionError &&
        err.code === "stale_from_status"
      ) {
        try {
          await transitionRunStatus(args.runId, "pending_trigger", "armed", undefined, authority);
        } catch (err2) {
          if (
            err2 instanceof RunTransitionError &&
            err2.code === "stale_from_status"
          ) {
            console.log(
              `[setRunTriggerForActor] run ${args.runId} not in pending_input/pending_trigger — leaving status as-is`,
            );
          } else {
            throw err2;
          }
        }
      } else {
        throw err;
      }
    }
  } else if (args.triggerType === "immediate") {
    // Run-start recommendation HOLD (cinatra#2148 finding 3). An immediate
    // trigger IS a run-start dispatch, so it must consult the same hold every
    // other interactive run-start does; before this it transitioned
    // pending_input → queued directly and a human-present run never paused.
    //
    // The trigger row + open gate are already durable at this point, so a park
    // costs nothing: the run simply stays pending_input until the chip-row
    // decision releases the park and dispatches through the canonical
    // `triggerAgentRun` (which performs the pending_input → queued CAS + enqueue
    // with the gate already open). A headless run (`humanPresent` null/false —
    // e.g. every programmatic MCP-created run) never parks, so the MCP surface
    // is byte-unchanged. Best-effort: any hold failure fails OPEN to the direct
    // transition below.
    //
    // A RETRIED immediate trigger on an ALREADY-parked run is covered by the
    // hold itself: it answers `held:true` with the existing park id and writes
    // no second park, so the retry cannot dispatch past the live park.
    let heldForRecommendation = false;
    try {
      const template = await readAgentTemplateById(run.templateId);
      if (template?.packageName) {
        const hold = await maybeHoldRunForRecommendation({
          run,
          template: {
            packageName: template.packageName,
            lifecycleConfig: (template as { lifecycleConfig?: string | null }).lifecycleConfig,
          },
        });
        heldForRecommendation = hold.held;
      }
    } catch (err) {
      // runId passed as a discrete ARGUMENT (never interpolated into the format
      // string) so a `%`-bearing id can never be read as a util.format specifier
      // (CodeQL js/tainted-format-string).
      console.warn(
        "[setRunTriggerForActor] immediate: recommendation hold evaluation failed for run",
        args.runId,
        "— dispatching normally:",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (heldForRecommendation) {
      // Parked at the recommendation interception — the chip-row's
      // confirm/adjust/skip releases the park and dispatches. Do NOT transition
      // here (the run stays pending_input; the run view renders the chip-row).
      console.log(
        "[setRunTriggerForActor] immediate: run held at the run-start recommendation interception; the chip-row decision dispatches it —",
        args.runId,
      );
    } else {
      // Gate is already open — now actually run it (cinatra#2523).
      const dispatched = await dispatchImmediateNow(args.runId, actor, authority);
      if (!dispatched.ok) return dispatched;
    }
  }

  // HOOK POINT A (cinatra#317) — outbound PM mirror of the schedule-DEFINING
  // trigger, AFTER the final createOrUpdateRunTrigger (jobSchedulerId persisted)
  // and the status flip have succeeded. Fail-open: the local schedule is already
  // durable, so a PM outage must never fail this call (the bridge swallows + logs
  // its own errors, and the .catch is defense-in-depth). Mirrors the trigger
  // CONFIG, not the recurring child runs.
  await syncRunTriggerPmTask({
    runId: args.runId,
    triggerType: args.triggerType,
    scheduledAt: args.scheduledAt
      ? new Date(naiveDatetimeToUtcMs(args.scheduledAt, tz)).toISOString()
      : null,
    cronExpression: args.cronExpression ?? null,
    timezone: tz,
    enabled: args.enabled ?? true,
  }).catch((err) => {
    // runId + err passed as ARGUMENTS (not interpolated into the format string)
    // so a runId is never treated as a console format spec (js/tainted-format-string).
    console.warn(
      "[setRunTriggerForActor] PM mirror failed (schedule unaffected) for run",
      args.runId,
      err,
    );
  });

  return {
    ok: true,
    runId: args.runId,
    jobSchedulerId: scheduleResult.jobSchedulerId,
  };
}

// ---------------------------------------------------------------------------
// getRunTriggerForActor — read a run's trigger config on behalf of `actor`.
// ---------------------------------------------------------------------------
/**
 * Read a run's trigger config on behalf of `actor`.
 *
 * Enforces ownership FIRST (read parent agent_run, verify owner) BEFORE
 * returning trigger metadata. Prevents information disclosure of scheduled
 * times / cron expressions / releasedAt from non-owners and keeps trigger
 * metadata behind the same ownership check.
 *
 * Same code path is used by server actions and MCP handlers — direct calls
 * to readRunTriggerByRunId from the MCP layer would bypass this check.
 */
export async function getRunTriggerForActor(
  actor: TriggerActorContext,
  runId: string,
): Promise<GetTriggerForActorResult> {
  if (!actor.userId) return { ok: false, error: "unauthorized" };

  const run = await readAgentRunById(runId);
  if (!run) return { ok: false, error: "run not found" };
  if (!isOwnerOrAdmin(actor, run.runBy ?? null)) {
    return { ok: false, error: "forbidden" };
  }

  const trigger = await readRunTriggerByRunId(runId);
  return { ok: true, trigger };
}

// ---------------------------------------------------------------------------
// deleteRunTriggerForActor — cancel a run's trigger on behalf of `actor`.
// ---------------------------------------------------------------------------
/**
 * Cancel a run's trigger on behalf of `actor`.
 *
 * Enforces ownership; cancels BullMQ schedule; deletes the row; flips run
 * status armed → stopped for scheduled/recurring trigger types.
 *
 * Idempotent: if there is no trigger row, returns ok without side effects.
 *
 * A SCHEDULE THAT WAS STOPPED IS NOT DELETED FROM HERE (cinatra#3004).
 *
 * The plan: "A recurring schedule that ran at least once and was then cancelled
 * is over … the run is over and nothing in that run can be configured anymore."
 * **Cancel schedule** ends it by STAMPING the row (`stopRecurringTriggerForActor`)
 * rather than removing it, and every refusal that keeps the ending — the save
 * guard, and `setRunTriggerForActor`'s own stopped gate — reads that row. So a
 * delete would not merely tidy: it would take the ending away and hand the
 * finished run back to the arm path, which sees no row and refuses nothing.
 *
 * Refused HERE rather than guarded at each caller, because the callers are the
 * point: this function is reached from a server action and from two MCP
 * handlers, and "no surface can walk around the ending" is only true if the one
 * function they share says no.
 *
 * WHAT "OVER" MEANS is `scheduleIsOver` below, in the plan's own two clauses.
 * Everything else is deleted exactly as before: a live schedule, and a one-off
 * whose run is still going.
 *
 * THE READ HAPPENS UNDER THE TRIGGER CLAIM (cinatra#2981), like every other
 * writer on this row. Without it a delete could read `stopped_at IS NULL`, wait,
 * and then remove the row a **Cancel schedule** stamped in the meantime — the
 * exact ending this refusal exists to keep.
 */
/**
 * IS THIS RUN'S SCHEDULE OVER? (cinatra#3004)
 *
 * The plan's sentence has two clauses and this predicate is both of them:
 *
 *   · "a recurring schedule that ran at least once and was then cancelled" —
 *     `stoppedAt`, which `stopRecurringTriggerForActor` only ever stamps AFTER a
 *     first fire (it refuses a schedule that has not fired), so there is no
 *     stopped-before-first-fire row for this to catch by accident;
 *   · "a run set to run once that already ran: the run is over" — a ONE-OFF that
 *     has FIRED, on a run that has reached a terminal status.
 *
 * BOTH HALVES OF THE SECOND CLAUSE ARE NEEDED. The fired stamp alone would also
 * refuse the ordinary tidy-up of a run dispatched a moment ago and still going —
 * **Run right after setup** stamps `releasedAt` the instant it arms. The
 * terminal status alone would refuse clearing a schedule that never fired at
 * all, which is not an ending, only a run that ended some other way.
 *
 * EVERYTHING THAT IS NOT RECURRING IS A ONE-OFF, written that way round so a
 * kind added later is protected by default rather than slipping through unnamed
 * — the same reading `setRunTriggerForActor`'s fired-one-off guard takes.
 *
 * Exported for the regression test, which reads the rule rather than inferring
 * it from a delete's side effects.
 */
export function scheduleIsOver(
  trigger: {
    triggerType: string;
    releasedAt: Date | null;
    stoppedAt: Date | null;
  },
  runStatus: string | null | undefined,
): boolean {
  if (trigger.stoppedAt) return true;
  return (
    trigger.triggerType !== "recurring" &&
    trigger.releasedAt !== null &&
    TERMINAL_RUN_STATUSES.has(runStatus ?? "")
  );
}

export async function deleteRunTriggerForActor(
  actor: TriggerActorContext,
  args: { runId: string },
): Promise<DeleteTriggerForActorResult> {
  if (!actor.userId) return { ok: false, error: "unauthorized" };

  const run = await readAgentRunById(args.runId);
  if (!run) return { ok: false, error: "run not found" };
  if (!isOwnerOrAdmin(actor, run.runBy ?? null)) {
    return { ok: false, error: "forbidden" };
  }

  let outcome: { refusal?: string; deleted?: string | null };
  try {
    outcome = await withTriggerClaim(args.runId, async (trigger) => {
      if (!trigger) return { deleted: null };
      // THE RUN'S STATUS IS READ AT THE SERIALIZATION POINT, not before it.
      // Half of `scheduleIsOver` is the RUN's own outcome, and the read above
      // happened before this call queued for the claim: a released one-off that
      // was still running then can have finished while this delete waited, and
      // deciding on that stale status would remove the very ending this refusal
      // exists to keep. A run that has vanished under us keeps the status the
      // authorization was taken on.
      const live = await readAgentRunById(args.runId);
      if (scheduleIsOver(trigger, live?.status ?? run.status)) {
        return { refusal: SAVE_SCHEDULE_REFUSALS.overCannotRemove };
      }
      try {
        await cancelTriggerSchedule({
          jobSchedulerId: trigger.jobSchedulerId,
          triggerType: trigger.triggerType,
        });
      } catch (err) {
        console.warn(
          "[deleteRunTriggerForActor] cancel of BullMQ job failed (continuing with DB delete)",
          args.runId,
          err,
        );
      }
      await deleteRunTriggerByRunId(args.runId);
      return { deleted: trigger.triggerType };
    });
  } catch (err) {
    if (err instanceof TriggerClaimUnavailableError) {
      // Another writer held the claim longer than this call would wait. NOTHING
      // was removed, so the schedule is exactly as the reader last saw it.
      console.warn(
        "[deleteRunTriggerForActor] the trigger claim was not available — the schedule is unchanged",
        args.runId,
      );
      return { ok: false, error: SAVE_SCHEDULE_REFUSALS.busy };
    }
    throw err;
  }
  if (outcome.refusal) return { ok: false, error: outcome.refusal };
  // Idempotent: no row to remove, and nothing else to undo either.
  if (outcome.deleted == null) return { ok: true };

  if (
    outcome.deleted === "scheduled" ||
    outcome.deleted === "recurring"
  ) {
    // Owner/org-admin member session grounds the armed→stopped teardown (§2a).
    const authority = await verifySessionAuthority(actor.userId, run.orgId);
    try {
      await transitionRunStatus(args.runId, "armed", "stopped", undefined, authority);
    } catch (err) {
      if (
        err instanceof RunTransitionError &&
        err.code === "stale_from_status"
      ) {
        console.log(
          `[deleteRunTriggerForActor] run ${args.runId} not in armed state — leaving status as-is`,
        );
      } else {
        throw err;
      }
    }
  }

  // HOOK POINT B (cinatra#317) — unschedule/delete the mirrored PM work item
  // AFTER the local trigger row is deleted and the armed→stopped transition has
  // run. Fail-open: the local trigger is already gone, so a PM outage must never
  // fail this call (the bridge leaves the pm-link row for the reconcile loop and
  // swallows + logs its own errors; the .catch is defense-in-depth).
  await deleteRunTriggerPmTask({ runId: args.runId }).catch((err) => {
    // runId + err passed as ARGUMENTS (not interpolated into the format string)
    // so a runId is never treated as a console format spec (js/tainted-format-string).
    console.warn(
      "[deleteRunTriggerForActor] PM unschedule failed (trigger already deleted) for run",
      args.runId,
      err,
    );
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// STOP A RECURRING SCHEDULE — what **Cancel schedule** does now (cinatra#2972).
//
// THE PLAN'S WORDS (PLAN: Agents Lifecycle (A) §7.2, amended 2026-08-25): the
// schedule step's "one control is **Cancel schedule**, shown only for a
// recurring schedule that has fired once — it stops the recurring schedule and
// then makes the scheduler non-editable; there is no Run now." §7.4's
// as-designed step 6 says the same: "**Cancel schedule** → **End state:
// stopped** (the scheduler then non-editable)".
//
// STOPPED IS NOT DELETED AND NOT PAUSED, and that is the whole difference from
// `deleteRunTriggerForActor`, which this operation replaced on the card:
//
//   · THE ROW STAYS. The person who stopped a schedule can still read the
//     schedule they stopped — the rows are still drawn, read-only. Deleting it
//     would blank the step and take the record with it.
//   · THE RUN IS NOT TOUCHED. `deleteRunTriggerForActor` flips an armed run to
//     `stopped`; this does not, because the plan withdrew that: "It never
//     deletes the schedule or pauses the run" (cinatra#2972).
//   · THE SCHEDULER IS CANCELLED. `enabled: false` is also re-read by the fire
//     path at fire time, so a job that outlives the cancel still refuses to
//     fire. Two independent stops, neither trusting the other.
//
// NO SURFACE OFFERS THE DELETE ANY MORE (cinatra#3004). The run's schedule tab
// used to carry a **Cancel trigger** that called `deleteRunTriggerForActor`, and
// that was the hole: with the row gone, every refusal that keeps a schedule's
// ending — this module's stopped gate and the save guard — reads nothing and
// refuses nothing. The tab now draws the schedule form, whose ending is this
// operation, and the delete refuses a stopped row outright.
// ---------------------------------------------------------------------------

export type StopRecurringTriggerResult =
  | { ok: true }
  | { ok: false; error: string };

export async function stopRecurringTriggerForActor(
  actor: TriggerActorContext,
  args: { runId: string },
): Promise<StopRecurringTriggerResult> {
  if (!actor.userId) return { ok: false, error: "unauthorized" };

  const run = await readAgentRunById(args.runId);
  if (!run) return { ok: false, error: "run not found" };
  // The run's owner or an administrator — the same standing every other
  // operation on this run's schedule takes. Stopping a schedule is not an
  // admin-only act: it takes something away rather than starting work, which is
  // what the withdrawn Run now needed admin standing for.
  if (!isOwnerOrAdmin(actor, run.runBy ?? null)) {
    return { ok: false, error: "forbidden" };
  }

  const trigger = await readRunTriggerByRunId(args.runId);
  if (!trigger) return { ok: false, error: "no trigger configured for this run" };
  // ONLY A RECURRING SCHEDULE, AND ONLY AFTER ITS FIRST FIRE — the server's own
  // reading of the same sentence the card reads to decide whether to draw the
  // control, so a hand-made request cannot reach an operation the plan does not
  // define for that schedule.
  if (trigger.triggerType !== "recurring") {
    return { ok: false, error: "Only a recurring schedule can be stopped." };
  }
  if (!trigger.lastFiredAt) {
    return {
      ok: false,
      error: "This schedule has not fired yet, so there is nothing to stop.",
    };
  }
  // Idempotent: a second press on an already-stopped schedule is a no-op rather
  // than a refusal, so a double-click cannot produce an error the reader has to
  // interpret.
  if (trigger.stoppedAt) return { ok: true };

  // THE STAMP GOES DOWN FIRST, AND THAT ORDER IS THE PROTOCOL (cinatra#2972,
  // codex round 2). Cancelling the scheduler first and then writing would leave,
  // on a failed write, a row that still reads ARMED and EDITABLE with no
  // scheduler behind it — a schedule the person is told is live and that can
  // never fire. Stamping first inverts the failure: what survives a crash is a
  // row that reads STOPPED with a scheduler that may still tick, and the fire
  // path refuses a stopped row and unschedules the orphan on that tick. One
  // order strands a lie, the other strands something that repairs itself.
  //
  // A FAILED STAMP IS A REFUSAL, NOT A THROW — this function answers with a
  // result like every other operation in this module. Nothing has been written
  // and the scheduler is untouched, so the schedule is exactly as the reader
  // last saw it and pressing again is safe.
  // BOTH STEPS UNDER THE CLAIM (cinatra#2981) — the stamp AND the cancel.
  //
  // WHAT THE CLAIM CHANGES HERE is not the stamp (a single UPDATE was always
  // atomic) but its RELATION to everything else: while it is held, no save can
  // be mid-replacement and no tick can be mid-fire, so the stamp cannot land in
  // the middle of another writer's decision and be overwritten by the rest of
  // it. It also means the cancel names the scheduler that is live NOW — a save
  // that won the claim just before this one installed a new `job_scheduler_id`,
  // and cancelling the id from the pre-claim snapshot would have left that one
  // ticking.
  //
  // ELIGIBILITY IS STILL THE PRE-CLAIM SNAPSHOT'S, DELIBERATELY. The recurring
  // and has-fired-once rulings above belong to the schedule the person was
  // looking at when they pressed the control. A save that switches the kind to
  // one-off while this stop waits for the claim must not turn their stop into a
  // refusal — that is precisely the shape that used to leave a stopped-and-armed
  // one-off behind. What the claimed read decides is only what cannot be decided
  // earlier: whether somebody already stopped it, and which scheduler to cancel.
  //
  // THE STAMP STILL GOES DOWN BEFORE THE CANCEL, and that order is still the
  // protocol (cinatra#2972). Cancelling first and then writing
  // would leave, on a failed write, a row that reads ARMED and EDITABLE with no
  // scheduler behind it — a schedule the person is told is live and that can
  // never fire. Stamping first inverts the failure: what survives is a row that
  // reads STOPPED with a scheduler that may still tick, and the fire path
  // refuses a stopped row and unschedules the orphan on that tick.
  //
  // A FAILED STAMP IS A REFUSAL, NOT A THROW — this function answers with a
  // result like every other operation in this module. Nothing has been written
  // and the scheduler is untouched, so the schedule is exactly as the reader
  // last saw it and pressing again is safe.
  try {
    await withTriggerClaim(args.runId, async (live) => {
      // Idempotent, re-asked on the claimed read: a second press that queued
      // behind the first is a no-op rather than a second stamp and a second
      // cancel.
      if (live?.stoppedAt) return;
      await stopRunTriggerInDb(args.runId);
      try {
        await cancelTriggerSchedule({
          jobSchedulerId: live?.jobSchedulerId ?? trigger.jobSchedulerId,
          triggerType: live?.triggerType ?? trigger.triggerType,
        });
      } catch (err) {
        // NOT FATAL, because the durable answer is already written. The
        // schedule reads stopped, `setRunTriggerForActor` refuses to change it,
        // and the next tick of the surviving scheduler reads the stamp, refuses
        // to fire and removes itself. Logged loudly so an operator can see the
        // orphan before its next tick does.
        console.error(
          "[stopRecurringTriggerForActor] the schedule is marked stopped but its scheduler would not cancel — the next tick will refuse and unschedule it",
          args.runId,
          err,
        );
      }
    });
  } catch (err) {
    if (err instanceof TriggerClaimUnavailableError) {
      // Another writer held the claim longer than this call would wait. NOTHING
      // was written and the scheduler is untouched, so the schedule is exactly
      // as the reader last saw it and pressing again is safe.
      console.warn(
        "[stopRecurringTriggerForActor] the trigger claim was not available — the schedule is unchanged",
        args.runId,
      );
      return { ok: false, error: SAVE_SCHEDULE_REFUSALS.busy };
    }
    console.error(
      "[stopRecurringTriggerForActor] the stop could not be recorded — the schedule is unchanged",
      args.runId,
      err,
    );
    return { ok: false, error: "That didn\u2019t go through. Try again." };
  }

  // The mirrored PM work item is unscheduled for the same reason the delete
  // path unschedules it: no further run will start from this schedule. Fail-open
  // — the local schedule is already stopped, so a PM outage must never fail
  // this call.
  await deleteRunTriggerPmTask({ runId: args.runId }).catch((err) => {
    console.warn(
      "[stopRecurringTriggerForActor] PM unschedule failed (the schedule is already stopped) for run",
      args.runId,
      err,
    );
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// SAVE CHANGES — re-arm an already-armed trigger from the card's own rows
// (cinatra#2788, epic #2784 S9d; plan (A) §7.2 and §7.4 as-designed step 6).
//
// THE PLAN'S WORDS: "the same card, with the same option rows, now shows the
// armed schedule; to change it you return to the card, change the rows and
// press **Save changes**, which re-arms the trigger" — and, in the interaction
// sequence, "change the rows and press **Save changes** → **End state:
// re-armed**".
//
// THIS IS NOT A SECOND ARMING PATH. Everything below the refusals delegates to
// `setRunTriggerForActor`, the one function that validates a cron, cancels the
// prior scheduler before installing the replacement, persists the row and moves
// the run's status. What this frame adds is the three refusals a RE-arm has and
// a first arm does not:
//
//   · IDENTITY. `setRunTriggerForActor` already re-checks owner-or-admin on the
//     actor it is handed; this frame reads the run first so it can refuse a run
//     that no longer exists with a sentence rather than a throw, and so the
//     other two refusals are decided against the same snapshot.
//   · A ONE-OFF THAT HAS ALREADY FIRED. A single delayed job that has run is
//     not a schedule any more. Re-arming it would quietly produce a SECOND run
//     from a control whose whole promise is "change this one".
//   · A RELEASED TRIGGER. The gate is open and the held steps are already
//     eligible; there is nothing left to hold back on a new schedule.
//
// RECURRING CHANGES APPLY TO FUTURE TICKS ONLY, and that is a property of the
// delegation rather than a rule written here: a recurring tick CLONES the run it
// was armed from and starts the copy (`trigger-release-job`), so ticks that have
// already fired are separate runs that this call does not touch, and the only
// thing replaced is the scheduler that decides the NEXT one. `setRunTriggerForActor`
// cancels the old `jobSchedulerId` before registering the new expression, so no
// tick is ever scheduled by both.
//
// SWITCHING TO "RUN RIGHT AFTER SETUP" IS REFUSED, deliberately. That row is not
// a schedule — arming it dispatches the run at once — so accepting it here would
// make Save changes an undocumented Run now, on a card that (in a
// conversation) deliberately carries neither Cancel schedule nor Run now.
// ---------------------------------------------------------------------------

/** §VI's closed selection vocabulary, as this module sees it. Mirrors
 *  `ProposedSchedule` in the protocol package; typed structurally rather than
 *  imported so the trigger service keeps no edge onto the view layer. */
export type SavedScheduleSelection =
  | { kind: "immediate" }
  | { kind: "scheduled"; runAt: string; timezone: string }
  | { kind: "recurring"; selection: RecurringConfig; timezone: string };

export type UpdateTriggerScheduleArgs = {
  runId: string;
  schedule: SavedScheduleSelection;
};

export type UpdateTriggerScheduleResult =
  | { ok: true; runId: string }
  | { ok: false; error: string };

/** What the card says when the schedule can no longer be changed. Reader-facing
 *  copy: it names the state and what to do instead, exactly as the immediate
 *  ladder's refusals do. */
export const SAVE_SCHEDULE_REFUSALS = {
  noTrigger:
    "There is no armed schedule on this run to change.",
  released:
    "This trigger has already been released — its steps are eligible now, so there is no schedule left to change.",
  firedOneOff:
    "This one-off schedule has already run. Ask for a new schedule instead of changing this one.",
  immediate:
    "\u201cRun right after setup\u201d starts the run now rather than scheduling it, so it is not a change you can save here. Set a time or a recurrence instead.",
  /**
   * The schedule is still being INSTALLED (cinatra#2934, the armed-trigger
   * tab's window). The write guard below deliberately says nothing about this
   * state — the installer exposes a schedule to the scheduler BEFORE it marks
   * the intent done, so refusing a write on it would take away an operation the
   * server is still granting. `canSaveInstalled` DOES withhold **Save changes**
   * for it, so a surface that has to explain a withheld control needs the
   * sentence, and it belongs in this table with the others rather than in a
   * second one.
   */
  arming:
    "This schedule is still being installed, so it can't be changed yet. Try again in a moment.",
  /** cinatra#2972 — the schedule was stopped with **Cancel schedule**. */
  stopped:
    "This schedule was stopped, so it can't be changed. Ask for a new schedule instead of changing this one.",
  /** cinatra#3004 — a schedule that is OVER, asked to be REMOVED rather than
   *  changed. The row is the record of the ending, so it stays. */
  overCannotRemove:
    "This run's schedule is over, so it can't be changed or removed. Start a new run to schedule it again.",
  /** The prior scheduler would not cancel, so the replacement was NOT installed
   *  — the schedule the reader is looking at is still the live one. */
  cancelFailed:
    "The schedule could not be changed just now. Your existing schedule is unchanged and still armed — please try again.",
  /** cinatra#2981 — another writer (a **Cancel schedule**, or another save)
   *  held the trigger claim for longer than this call would wait. Nothing was
   *  written, so the reader's schedule is exactly as they left it. */
  busy:
    "Something else is changing this schedule right now. Nothing was changed — please try again in a moment.",
} as const;

/**
 * THE SAVE GUARD, in ONE place (cinatra#2788).
 *
 * `updateRunTriggerScheduleForActor` asks this before it delegates, and asks it
 * AGAIN — through the strictness hook — against the row the setter itself reads
 * immediately before the cancel. Two call sites, one function, so the pre-check
 * and the re-check can never drift into disagreeing about what "still
 * changeable" means.
 */
function saveScheduleGuardRefusal(trigger: TriggerRecord | null): string | null {
  if (!trigger) return SAVE_SCHEDULE_REFUSALS.noTrigger;
  // A STOPPED SCHEDULE IS OVER (cinatra#2972). Plan (A) §7.2 as amended
  // 2026-08-25: **Cancel schedule** "stops the recurring schedule and then
  // makes the scheduler non-editable".
  //
  // ASKED HERE RATHER THAN ONLY IN THE PRE-CHECK, and that placement is the
  // point: this function is also the setter's `reverify` hook, run against the
  // row the cancel and the upsert are about to act on. A Save that starts
  // before a Cancel lands would otherwise re-arm the schedule the person had
  // just stopped — the config upsert writes `enabled` back to true — and the
  // pre-check alone could not see it.
  if (trigger.stoppedAt) return SAVE_SCHEDULE_REFUSALS.stopped;
  // A RELEASED trigger's gate is open — but only a ONE-OFF or an IMMEDIATE
  // trigger can be released in the sense that ends its schedule. A recurring
  // tick opens the COPY's gate, never this run's, so a recurring row's
  // `releasedAt` says nothing about whether the schedule is still live:
  // refusing on it here would contradict `canSaveInstalled`, which plan (A)
  // §7.2 as amended 2026-08-25 requires to stay TRUE for a fired recurring
  // schedule ("keeps its scheduler editable … a change applies to its future
  // runs"). The card and the server read one rule (cinatra#2972).
  if (trigger.triggerType !== "recurring" && trigger.releasedAt) {
    return SAVE_SCHEDULE_REFUSALS.released;
  }
  // A one-off whose moment has passed has fired (or is firing).
  if (
    trigger.triggerType === "scheduled" &&
    (!trigger.scheduledAt || trigger.scheduledAt.getTime() <= Date.now())
  ) {
    return SAVE_SCHEDULE_REFUSALS.firedOneOff;
  }
  return null;
}

/**
 * WHY THIS ARMED SCHEDULE CANNOT BE CHANGED RIGHT NOW — in words, for a surface
 * that has to say it (cinatra#2934, the armed-trigger tab's window).
 *
 * NOT A SECOND PREDICATE, AND THAT IS THE WHOLE POINT. It is the guard above —
 * the one function `updateRunTriggerScheduleForActor` asks before it delegates
 * and again inside the setter — plus the ONE state that guard deliberately
 * leaves alone: a trigger still arming, which **Save changes** is withheld for
 * (`canSaveInstalled`) while the write is still granted. So the window's answer
 * and the write's answer are the same answer, and the parity is pinned by a
 * table test rather than by two functions agreeing on purpose.
 *
 * `null` means "this schedule can still be changed" — the same reading
 * `canSaveInstalled` returns `true` for.
 */
export function saveScheduleRefusalFor(input: {
  readonly trigger: TriggerRecord | null;
  readonly arming: boolean;
}): string | null {
  if (input.arming) return SAVE_SCHEDULE_REFUSALS.arming;
  return saveScheduleGuardRefusal(input.trigger);
}

export async function updateRunTriggerScheduleForActor(
  actor: TriggerActorContext,
  args: UpdateTriggerScheduleArgs,
): Promise<UpdateTriggerScheduleResult> {
  if (!actor.userId) return { ok: false, error: "unauthorized" };

  const run = await readAgentRunById(args.runId);
  if (!run) return { ok: false, error: "run not found" };
  if (!isOwnerOrAdmin(actor, run.runBy ?? null)) {
    return { ok: false, error: "forbidden" };
  }

  // Refused BEFORE any write, so the prior scheduler is never cancelled on the
  // way to a refusal. This read is a SNAPSHOT: the authoritative re-ask happens
  // inside the setter, against the row the cancel and the upsert act on.
  const existing = await readRunTriggerByRunId(args.runId);
  const guardRefusal = saveScheduleGuardRefusal(existing);
  if (guardRefusal) return { ok: false, error: guardRefusal };
  if (args.schedule.kind === "immediate") {
    return { ok: false, error: SAVE_SCHEDULE_REFUSALS.immediate };
  }

  // THE SAVE PATH IS A REPLACEMENT, SO IT IS STRICT (cinatra#2788).
  //
  // Fail closed if the prior scheduler will not cancel — a save that installs a
  // second live scheduler is worse than a save that refuses — and re-ask the
  // guard above against the setter's own pre-cancel read, so a release that
  // lands between the snapshot and the write is refused rather than overwritten.
  const strictness: SetTriggerReplaceStrictness = {
    failClosedOnCancelFailure: true,
    reverify: saveScheduleGuardRefusal,
  };

  const result =
    args.schedule.kind === "scheduled"
      ? await setRunTriggerForActor(
          actor,
          {
            runId: args.runId,
            triggerType: "scheduled",
            scheduledAt: args.schedule.runAt,
            timezone: args.schedule.timezone,
          },
          strictness,
        )
      : await setRunTriggerForActor(
          actor,
          {
            runId: args.runId,
            triggerType: "recurring",
            cronExpression: buildCron(args.schedule.selection),
            timezone: args.schedule.timezone,
          },
          strictness,
        );

  return result.ok ? { ok: true, runId: args.runId } : { ok: false, error: result.error };
}
