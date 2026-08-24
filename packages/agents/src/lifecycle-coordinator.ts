import "server-only";

// ---------------------------------------------------------------------------
// THE LIFECYCLE COORDINATOR (cinatra#2928, epic #2926 W2a).
//
// One runner, one interface. However an agent run is started, resumed or
// advanced, the same code creates it, decides which moment applies when it
// reaches one, and parks or dispatches. The run itself records which moment it
// is waiting at and which card belongs to it, so a screen mounts that card from
// the run rather than deriving it from the shape of the pause.
//
// FIVE ENTRIES, and every way of touching a run's lifecycle is one of them:
//
//   launchAgentRun        — creates the run and decides the moments that apply
//                           at its start.
//   advanceAgentRun       — releases a parked run when a person or a schedule
//                           says so: Continue, a one-off trigger firing, an
//                           approval resuming.
//   onAgentHitl           — the agent pausing to ask for input.
//   onArtifactProduced    — an artifact write being recorded.
//   onReviewedWorkChanged — a change landing on reviewed work.
//
// Each answers with the CARRIER it acted on — a run, or, for a schedule not yet
// confirmed, the schedule the person stated, held — together with the status
// that carrier is really in and the moment, if any.
//
// WHAT THIS SLICE DOES NOT DO. It stops short of the review CORE and of the two
// surfaces that bypass the worker today (the widget's content-edit run and runs
// of external agents over the agent-to-agent protocol). Those are W2b's
// (cinatra#2929), and `RUN_PRODUCERS` below names them as owed rather than
// leaving them unlisted. It changes no screen: the moments it records are the
// parks that already exist, and nothing new parks because of it.
//
// THE POLICY TABLE IS UNCHANGED. `LifecycleCheckpoint` still has its three
// checkpoints — the organization's rules first, the product's defaults next.
// Two of the five moments are simply not policy matters: the HITL moment is the
// agent's own (the step asks or it does not), and a schedule has no artifact
// type, destination or origin, so it is not a row in that table. The schedule
// DEFAULT therefore lives here, stated once, below.
// ---------------------------------------------------------------------------

import {
  LIFECYCLE_MOMENT_CARD_KIND,
  lifecycleMomentParksRun,
  type LifecycleCardKind,
  type LifecycleMoment,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import { resolveRunCreationAuthority } from "@/lib/org-write/run-creation-authority";
import { enqueueAgentRun, type AgentRunEnqueueOptions } from "@/lib/agent-run-enqueue";

import {
  createAgentRun,
  createAgentRunPendingInput,
  readAgentRunById,
  recordRunLifecycleMoment,
  transitionRunStatus,
  RunTransitionError,
  type AgentRunRecord,
  type AgentTemplateRecord,
  type CreateAgentRunInput,
} from "./store";
import type { GuardedRunCompanionWrite } from "./org-write-run-seam";
import { maybeHoldRunForRecommendation } from "./recommendation-hold";
import type { AgentRunStatus } from "./run-status";

// ---------------------------------------------------------------------------
// The answer shape
// ---------------------------------------------------------------------------

/**
 * What a lifecycle act happened TO.
 *
 * Two carriers, and the difference is whether a run exists yet. Before Confirm
 * there is no run: the carrier is the schedule the person stated, held, and its
 * whole state is its own signed reference.
 */
export type LifecycleCarrier =
  | { readonly kind: "run"; readonly run: AgentRunRecord }
  | { readonly kind: "scheduleProposal"; readonly proposal: HeldScheduleCarrier };

/** The held schedule, as a carrier. The token IS the state; nothing is written. */
export type HeldScheduleCarrier = {
  /** The opaque signed reference the person's card carries. */
  readonly ref: string;
  /** Who stated it — the only audience that may read it back. */
  readonly proposer: string;
  /** When the reading expires into "state it again". */
  readonly expiresAt: number;
};

/**
 * Every entry answers with this, and the status is always the one the carrier is
 * REALLY in — never an optimistic one.
 */
export type CoordinatorAnswer = {
  readonly carrier: LifecycleCarrier;
  readonly status: string;
  readonly moment: LifecycleMoment | null;
};

// ---------------------------------------------------------------------------
// The producer inventory
// ---------------------------------------------------------------------------

/**
 * Every way a run comes into existence, named.
 *
 * This is the list the inventory test walks, and it is data rather than prose so
 * "every producer goes through launch" is checkable instead of asserted. A
 * producer whose `routed` is false says WHO routes it — an unowned false is the
 * waiver this list exists to prevent.
 */
export type RunProducer = {
  /** The stable key a call site passes to `launchAgentRun`. */
  readonly key: string;
  /** The module the run is born in. */
  readonly module: string;
  /** Is this producer routed through `launchAgentRun` today? */
  readonly routed: boolean;
  /** For an unrouted producer: the slice that routes it. Never empty. */
  readonly tracking: string | null;
  /** One line: what starts a run this way. */
  readonly what: string;
};

export const RUN_PRODUCERS: readonly RunProducer[] = Object.freeze([
  {
    key: "chat_or_widget_dispatch",
    module: "packages/agents/src/actions.ts",
    routed: true,
    tracking: null,
    what: "the `agent_run` primitive — a person asking for a run in a conversation, and every headless caller of the same primitive",
  },
  {
    key: "registry_run_action",
    module: "packages/agents/src/actions.ts",
    routed: true,
    tracking: null,
    what: "the registry server action's Run",
  },
  {
    key: "run_page_pending",
    module: "packages/agents/src/run-actions.ts",
    routed: true,
    tracking: null,
    what: "the run page creating a run and leaving it for the Run button",
  },
  {
    key: "run_page_create_and_trigger",
    module: "packages/agents/src/run-actions.ts",
    routed: true,
    tracking: null,
    what: "the /agents card's Run — create and start in one act",
  },
  {
    key: "run_page_dev_preview",
    module: "packages/agents/src/run-actions.ts",
    routed: true,
    tracking: null,
    what: "the step-by-step screen's preview run",
  },
  {
    key: "agent_as_tool",
    module: "packages/agents/src/mcp/agent-tools-registry.ts",
    routed: true,
    tracking: null,
    what: "one agent invoking another as a tool",
  },
  {
    key: "project_dispatch",
    module: "src/lib/project-dispatch.ts",
    routed: true,
    tracking: null,
    what: "a project instance dispatching its seat agent",
  },
  {
    key: "external_a2a_invocation",
    module: "src/lib/a2a-server.ts",
    routed: true,
    tracking: null,
    what: "an outside system invoking a published agent over the agent-to-agent protocol",
  },
  {
    key: "lifecycle_repair",
    module: "packages/agents/src/lifecycle-repair-dispatch-store.ts",
    routed: true,
    tracking: null,
    what: "the repair run a rejected review sends back",
  },
  {
    key: "release_now_recurring_copy",
    module: "packages/agents/src/run-actions.ts",
    routed: true,
    tracking: null,
    what: "Release now on a recurring schedule — one copy, started by a person instead of by the clock",
  },
  {
    key: "recurring_trigger_tick",
    module: "packages/agents/src/trigger-release-job.ts",
    routed: true,
    tracking: null,
    what: "a recurring schedule firing — a fresh copy of the run per tick",
  },
  {
    key: "schedule_confirm",
    module: "packages/agents/src/trigger-schedule-proposal-service.ts",
    routed: true,
    tracking: null,
    what: "Confirm on a schedule stated in a conversation — the held schedule becomes a run with its schedule in one step",
  },
  {
    key: "widget_content_edit",
    module: "src/lib/host-content-editor-dispatch.ts",
    routed: false,
    tracking: "cinatra#2929 (lifecycle-b W2b) — the worker-backed adapter that keeps the blocking reply and its timeout",
    what: "the widget's content-edit run, which bypasses the worker today",
  },
  {
    key: "external_agent_message",
    module: "packages/agents/src/a2a-actions.ts",
    routed: false,
    tracking: "cinatra#2929 (lifecycle-b W2b) — the adapter that keeps the remote task stream",
    what: "a run of an external agent over the agent-to-agent protocol, which bypasses the worker today",
  },
]);

/** The producers this slice has NOT routed yet, with their owner. */
export const UNROUTED_PRODUCERS: readonly RunProducer[] = Object.freeze(
  RUN_PRODUCERS.filter((p) => !p.routed),
);

// ---------------------------------------------------------------------------
// Verified human presence
// ---------------------------------------------------------------------------

/**
 * The fields a launch frame may be read for, and nothing else.
 *
 * `delegatedRestricted` and `launchOrigin` are stamped exclusively by
 * server-only code the model cannot reach; `userId` is the resolved principal
 * the same frames carry.
 */
export type LaunchFrame = {
  readonly delegatedRestricted?: unknown;
  readonly launchOrigin?: unknown;
  readonly userId?: unknown;
  readonly orgWriteAuthority?: OrgWriteAuthority;
};

/**
 * Is a VERIFIED HUMAN present for this launch?
 *
 * THE DEFECT THIS CLOSES (cinatra#2892). Presence used to be "the frame came
 * through a chat surface", which the chat pre-router stamps as a CONSTANT. A
 * non-human principal reaching that pre-router therefore produced a run stamped
 * human-present with NO OWNER: the recommendation hold could fire on it, and the
 * only card that could release it belongs to a person who does not exist. The
 * refusal direction was safe — nothing launched unowned — but a dead-end card is
 * still a stranded run, and the stamp was untrue.
 *
 * So presence now needs BOTH halves, and both are server-stamped:
 *   1. a verified interactive surface — the transport-verified delegated chat
 *      carrier, or the in-process chat pre-router's constant, or a producer that
 *      states an explicit interactive presence claim it derived from a live
 *      session;
 *   2. a RESOLVABLE HUMAN OWNER on the same frame.
 *
 * Fail-closed: anything else is headless, which is the pre-existing behaviour
 * for every non-interactive origin.
 */
export function verifiedHumanPresence(input: {
  frame: unknown;
  /** An interactive producer's own claim, itself derived from a live session. */
  interactive?: boolean;
  /** The owner the run ROW will carry. This is the owner that counts. */
  runBy?: string | null;
}): boolean {
  const frame = (input.frame ?? {}) as LaunchFrame;
  const fromChatSurface =
    frame.delegatedRestricted === true || frame.launchOrigin === "chat";
  const interactive = fromChatSurface || input.interactive === true;
  if (!interactive) return false;
  // THE SECOND HALF, AND IT IS THE ROW'S OWNER — not the frame's principal.
  //
  // The frame's `userId` is who is CALLING; `runBy` is who the run will BELONG
  // to, and it is the only one a card can be shown to later, long after the
  // frame is gone. Accepting the frame's principal as the owner would readmit
  // the very defect this function exists to close, one step further along: a
  // run stamped human-present whose row carries no owner at all.
  const owner =
    typeof input.runBy === "string" && input.runBy.length > 0 ? input.runBy : null;
  if (owner === null) return false;
  // AND THEY MUST BE THE SAME PERSON when the frame names one. A frame acting
  // for somebody else is not a person sitting in front of this run: the card
  // would be shown to the owner while the presence claim came from the caller.
  if (typeof frame.userId === "string" && frame.userId.length > 0) {
    return frame.userId === owner;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The schedule default — the coordinator's own, not an organization rule
// ---------------------------------------------------------------------------

/** What the schedule screen offers before a person's run begins. */
export type ScheduleDefault =
  | { readonly kind: "run_after_setup" }
  | { readonly kind: "stated"; readonly schedule: unknown }
  | { readonly kind: "none"; readonly why: string };

/**
 * The schedule moment's own default, stated once and here.
 *
 * Run right after setup, UNLESS the person stated a schedule in the conversation
 * or changed it on the screen — and NEVER for a run nobody is present for. A
 * schedule has no artifact type, destination or origin, so it is not a row in
 * the policy table and no organization rule governs it.
 *
 * Nothing this function returns ARMS anything, and `launchAgentRun` does not
 * call it. It answers what the SCREEN would offer, and the screen is W3's
 * (cinatra#2930) — this slice changes no screen and parks no run that does not
 * park today, so a launch that applied this default would be inventing a wait
 * with no card to release it. What lives here is the DECISION, stated once and
 * in the coordinator rather than as a row in the policy table; what consumes it
 * is the slice that draws the card.
 */
export function scheduleDefaultForLaunch(input: {
  humanPresent: boolean;
  /** A schedule the person already stated, if any. */
  statedSchedule?: unknown;
}): ScheduleDefault {
  if (!input.humanPresent) {
    return {
      kind: "none",
      why: "nobody is present for this run — the schedule it was given applies and no screen is shown",
    };
  }
  if (input.statedSchedule !== undefined && input.statedSchedule !== null) {
    return { kind: "stated", schedule: input.statedSchedule };
  }
  return { kind: "run_after_setup" };
}

// ---------------------------------------------------------------------------
// The moment triple
// ---------------------------------------------------------------------------

/** The card a moment mounts. One table, shared with every host. */
export function cardKindForMoment(moment: LifecycleMoment): LifecycleCardKind {
  return LIFECYCLE_MOMENT_CARD_KIND[moment];
}

/**
 * State the moment on the run.
 *
 * BEST-EFFORT BY CONTRACT, exactly like the recommendation write it sits beside:
 * a lifecycle record must never fail a run. A throw is logged and swallowed, and
 * the run keeps the behaviour it had before the column existed — a NULL moment,
 * which every surface already reads as "no recorded moment".
 */
async function stateMoment(input: {
  run: Pick<AgentRunRecord, "id" | "orgId">;
  moment: LifecycleMoment | null;
  cardRef?: string | null;
  authority: OrgWriteAuthority | undefined;
}): Promise<void> {
  try {
    await recordRunLifecycleMoment(
      {
        runId: input.run.id,
        orgId: input.run.orgId,
        moment: input.moment,
        cardKind: input.moment === null ? null : cardKindForMoment(input.moment),
        cardRef: input.cardRef ?? null,
      },
      input.authority,
    );
  } catch (err) {
    // The run id is request-influenced, so it is a discrete ARGUMENT and never
    // interpolated into the format string (CodeQL js/tainted-format-string).
    console.warn(
      "[lifecycle-coordinator] could not state the moment on run",
      input.run.id,
      "— the run keeps a null moment:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// 1. launch
// ---------------------------------------------------------------------------

/** The creation inputs a caller owns. Presence and initial status are NOT among
 *  them: this module derives both, so no caller can hand in a presence claim. */
export type LaunchCreateInput = Omit<
  CreateAgentRunInput,
  "initialStatus" | "humanPresent"
>;

/** The pre-dispatch creator's own inputs, minus the presence claim. */
export type LaunchPendingInput = {
  templateId: string;
  runBy: string | null;
  orgId: string;
  inputParams?: Record<string, unknown>;
  projectId?: string | null;
  scopeActor?: CreateAgentRunInput["scopeActor"];
  /** Companion writes committed ATOMICALLY WITH THE RUN ROW. */
  withinCreateTx?: GuardedRunCompanionWrite;
};

/**
 * Which creator this launch uses.
 *
 * TWO CREATORS, ONE ENTRY. The general one takes a caller-minted id and the
 * whole input; the pre-dispatch one mints the id, pins the latest version and
 * can carry companion writes inside the same transaction (which is how Confirm
 * writes a run and its schedule in one step). They are different acts of
 * creation, so the fence bans BOTH outside this module rather than banning one
 * and leaving the other as the way around it.
 */
export type LaunchCreation =
  | { readonly kind: "full"; readonly input: LaunchCreateInput }
  | { readonly kind: "pre_dispatch"; readonly input: LaunchPendingInput };

/**
 * The enqueue options, or a function of the run that produces them.
 *
 * The function form exists because the pre-dispatch creator MINTS the run id,
 * so a caller whose job id is derived from that id cannot state it up front —
 * and a job id silently dropped is a duplicate dispatch waiting to happen.
 */
export type LaunchEnqueueOptions =
  | AgentRunEnqueueOptions
  | ((run: AgentRunRecord) => AgentRunEnqueueOptions);

/** How a launch reaches the queue. */
export type LaunchDispatch =
  /** The coordinator enqueues, with these options. */
  | { readonly kind: "enqueue"; readonly options: LaunchEnqueueOptions }
  /**
   * The caller enqueues. Named rather than implied, because a run created and
   * never dispatched is the one state nothing recovers on its own — the reason
   * has to be readable at the call site.
   */
  | { readonly kind: "caller_dispatches"; readonly why: string }
  /**
   * The run is created and STAYS pre-dispatch: a trigger dispatches it later.
   * No moment is evaluated here, because the moments that apply at a run's
   * start are decided when it actually starts — which for this shape is the
   * trigger path, not this call.
   */
  | { readonly kind: "await_trigger"; readonly why: string };

export type LaunchInput = {
  /** The inventory key of the producer — the key `RUN_PRODUCERS` records. */
  producer: string;
  /** The VERIFIED actor envelope, or null for a headless producer. */
  frame: unknown;
  create: LaunchCreation;
  dispatch: LaunchDispatch;
  /** An interactive producer's own presence claim, derived from a live session. */
  interactive?: boolean;
  /** Needed only when a hold may apply — i.e. when a human may be present. */
  template?: Pick<AgentTemplateRecord, "packageName"> & { lifecycleConfig?: string | null };
  /** A headless producer that mints its own authority hands it in here. */
  authority?: OrgWriteAuthority | undefined;
};

/**
 * Create a run and decide the moments that apply at its start.
 *
 * THE ORDERING IS THE WHOLE POINT, and it is the one this generalizes from
 * `createAgentRunForLaunchFrame`: a run that may park is created PARKED and
 * dispatched only once the moment declines to open. Creating it `queued` and
 * then parking it STRANDS it — the release paths only let go of the two
 * pre-dispatch waiting states, so a park applied to an already-queued row is a
 * park nothing can release.
 *
 * Three endings, and the status returned is always the one the row is really in:
 *   PARKED    → `pending_input`, nothing enqueued, waiting on a person, with the
 *               moment stated on the row.
 *   DISPATCHED→ `queued`, CAS'd once and enqueued once.
 *   RACED     → someone else moved the run first; this call adds no second job
 *               and claims no state it did not produce.
 */
export async function launchAgentRun(input: LaunchInput): Promise<CoordinatorAnswer> {
  const { create, dispatch } = input;
  const frame = (input.frame ?? {}) as LaunchFrame;
  const orgId = create.input.orgId;
  const runBy = create.input.runBy ?? null;

  const authority =
    input.authority !== undefined
      ? input.authority
      : await resolveRunCreationAuthority(orgId, {
          orgWriteAuthority: frame.orgWriteAuthority,
          userId: typeof frame.userId === "string" ? frame.userId : undefined,
        });

  // SERVER-DERIVED, and never readable from the call's arguments.
  const humanPresent = verifiedHumanPresence({
    frame: input.frame,
    interactive: input.interactive,
    runBy,
  });

  // A run that WAITS for a trigger is created pre-dispatch and stays there. A
  // run that starts now is created parked when a human is present — because the
  // moment may open before it dispatches — and `queued` otherwise.
  const parkOnCreate = dispatch.kind === "await_trigger" || humanPresent;

  const run =
    create.kind === "pre_dispatch"
      ? await createAgentRunPendingInput(
          {
            ...create.input,
            runBy: create.input.runBy,
            humanPresent: humanPresent ? true : undefined,
          },
          authority,
        )
      : await createAgentRun(
          {
            ...create.input,
            initialStatus: parkOnCreate ? "pending_input" : "queued",
            humanPresent: humanPresent ? true : undefined,
          },
          authority,
        );

  if (dispatch.kind === "await_trigger") {
    // Created and left pre-dispatch on purpose. The moments that apply at a
    // run's start are decided when it starts, and for this shape that is the
    // trigger path — deciding them here would park a run against a card nobody
    // has been shown yet.
    return { carrier: { kind: "run", run }, status: run.status, moment: null };
  }

  if (humanPresent) {
    // BEST-EFFORT, on the same contract as every other interactive run-start: a
    // recommendation must never fail a run, so any throw fails OPEN to a normal
    // dispatch.
    let held = false;
    try {
      const hold = await maybeHoldRunForRecommendation({
        run,
        template: {
          packageName: input.template?.packageName ?? "",
          lifecycleConfig: input.template?.lifecycleConfig,
        },
      });
      held = hold.held;
      if (hold.held) {
        // The park id IS the card reference: it is what the recommendation
        // card resolves its authorized state against, server-side, under the
        // reader.
        await stateMoment({
          run,
          moment: "recommendation",
          cardRef: hold.parkId ?? null,
          authority,
        });
      }
    } catch (holdErr) {
      console.warn(
        "[lifecycle-coordinator] recommendation evaluation failed for run",
        run.id,
        "— dispatching normally:",
        holdErr instanceof Error ? holdErr.message : String(holdErr),
      );
    }
    if (held) {
      // PARKED. No transition, no enqueue. The card in the conversation draws
      // the recommendation, and its decision releases the park through
      // `advanceAgentRun`.
      return {
        carrier: { kind: "run", run },
        status: "pending_input",
        moment: "recommendation",
      };
    }

    try {
      await transitionRunStatus(run.id, "pending_input", "queued", undefined, authority);
    } catch (transitionErr) {
      if (
        transitionErr instanceof RunTransitionError &&
        transitionErr.code === "stale_from_status"
      ) {
        // A concurrent writer already moved the run off `pending_input`, so it
        // owns the dispatch. Enqueueing here too would be the second enqueue
        // this path promises never to make — and this branch may not GUESS at
        // the state either: the re-read is the only source of the answer, and
        // when it cannot answer, this call says so.
        let current: AgentRunRecord | null = null;
        try {
          current = await readAgentRunById(run.id);
        } catch (rereadErr) {
          throw new Error(
            `Run ${run.id} lost the dispatch race and its state could not be re-read: ${
              rereadErr instanceof Error ? rereadErr.message : String(rereadErr)
            }`,
          );
        }
        if (!current) {
          throw new Error(`Run ${run.id} lost the dispatch race and no longer reads back.`);
        }
        return { carrier: { kind: "run", run }, status: current.status, moment: null };
      }
      throw transitionErr;
    }
  }

  if (dispatch.kind === "caller_dispatches") {
    // The row is `queued` and the caller owns the job. Nothing is claimed here
    // that this call did not produce.
    return { carrier: { kind: "run", run }, status: "queued", moment: null };
  }

  try {
    await enqueueAgentRun(
      { runId: run.id },
      typeof dispatch.options === "function" ? dispatch.options(run) : dispatch.options,
    );
  } catch (enqueueErr) {
    // Compensate this function's OWN transition so a failed enqueue cannot leave
    // the run sitting in `queued` with no job behind it. The headless branch made
    // no transition of its own, so it has nothing to undo.
    //
    // A LADDER, not a catch-and-log: `queued` with no job is the one state
    // nothing recovers on its own. Back to `pending_input` (decidable again),
    // failing that to `failed` with the reason (terminal and visible beats
    // phantom), failing that a throw that names the run as STRANDED rather than
    // reporting only the enqueue failure that started it.
    //
    // Reverting is safe even when the enqueue error was ambiguous: exactly-once
    // dispatch is enforced by the RUN ROW, not by the queue — the worker's first
    // act is to skip a run that is not `queued`, and the work sits behind a
    // `queued → running` CAS. The residual runs the benign way: a dispatch that
    // actually succeeded but reported ambiguously is compensated away and the
    // run waits for a person to retry it. A lost dispatch on a visible run,
    // never a duplicate one.
    if (humanPresent) {
      let recovered: "pending_input" | "failed" | null = null;
      try {
        await transitionRunStatus(run.id, "queued", "pending_input", undefined, authority);
        recovered = "pending_input";
      } catch (revertErr) {
        // Same reading as the release ladder below: a stale `from` means the run
        // has moved on and belongs to another writer, and the terminal rung must
        // not run against a generation this call did not produce.
        if (revertErr instanceof RunTransitionError && revertErr.code === "stale_from_status") {
          console.warn(
            "[lifecycle-coordinator] enqueue compensation skipped for run",
            run.id,
            "— another writer moved it after this launch; leaving it to them",
          );
          throw enqueueErr;
        }
        console.error(
          "[lifecycle-coordinator] enqueue compensation revert failed for run",
          run.id,
          revertErr,
        );
        try {
          await transitionRunStatus(
            run.id,
            "queued",
            "failed",
            {
              error: `Dispatch failed and the run could not be returned to its waiting state: ${
                enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)
              }`,
            },
            authority,
          );
          recovered = "failed";
        } catch (failErr) {
          console.error(
            "[lifecycle-coordinator] could not land run in any terminal state after a failed enqueue",
            run.id,
            failErr,
          );
        }
      }
      if (recovered === null) {
        throw new Error(
          `Run ${run.id} is STRANDED: its dispatch failed, it could not be returned to a waiting state, and it could not be failed. It is queued with no job behind it. Original dispatch error: ${
            enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)
          }`,
        );
      }
    }
    throw enqueueErr;
  }

  return { carrier: { kind: "run", run }, status: "queued", moment: null };
}

/**
 * Clear whatever moment a run states, for a release that is not `advanceAgentRun`.
 *
 * ONE EXISTS, and it is named rather than left implicit: the immediate-trigger
 * arm of `setRunTriggerForActor` releases a run parked at `pending_trigger` with
 * a CAS ladder of its own, wound together with a trigger row it may have to
 * unwind. Calling `advanceAgentRun` there would mean either duplicating that
 * unwind inside the coordinator or losing it — so that path keeps its own CAS
 * and borrows only the clear.
 *
 * Best-effort, on the same contract as every other lifecycle record: a failure
 * is logged and the run still goes.
 */
export async function clearRunLifecycleMoment(
  runId: string,
  authority: OrgWriteAuthority | undefined,
): Promise<void> {
  // THE READ IS INSIDE THE BEST-EFFORT, not beside it. It sat outside, so a
  // transient database read failure escaped into a caller that had ALREADY
  // released the run and had not yet enqueued it — leaving exactly the run this
  // clear exists to tidy up after: released, with no job behind it.
  try {
    const run = await readAgentRunById(runId);
    if (!run) return;
    await recordRunLifecycleMoment(
      { runId: run.id, orgId: run.orgId, moment: null },
      authority,
    );
  } catch (err) {
    console.warn(
      "[lifecycle-coordinator] could not clear the moment on run",
      runId,
      "— the run keeps the moment it was stating:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * State the SCHEDULE moment on a run that has just parked at the schedule step.
 *
 * NOT A SIXTH ENTRY — the five entries are the lifecycle ACTS, and this is the
 * coordinator recording a moment it already owns. It exists because that park is
 * created inside the worker's setup hand-off rather than at the run's start, and
 * a moment nobody states is a moment every screen has to infer.
 *
 * The park itself is unchanged: this states what the run is waiting at, and
 * `advanceAgentRun` clears it when Continue lets the run go.
 */
export async function stateRunScheduleMoment(input: {
  run: Pick<AgentRunRecord, "id" | "orgId">;
  /** The server-checked reference of the schedule card, when there is one. */
  cardRef?: string | null;
  authority: OrgWriteAuthority | undefined;
}): Promise<void> {
  await stateMoment({
    run: input.run,
    moment: "schedule",
    cardRef: input.cardRef ?? null,
    authority: input.authority,
  });
}

// ---------------------------------------------------------------------------
// 2. advance
// ---------------------------------------------------------------------------

/** Why a parked run is being released. */
export type ReleaseReason =
  | "continue"
  | "trigger_fired"
  | "approval_resumed"
  | "recommendation_decided";

export type AdvanceInput = {
  run: Pick<AgentRunRecord, "id" | "orgId" | "status">;
  release: {
    reason: ReleaseReason;
    /** The status the run is parked at — the CAS's `from`. */
    from: AgentRunStatus;
    /** The status it moves to. */
    to: AgentRunStatus;
    /** How the released run reaches the queue. */
    dispatch: LaunchDispatch;
    /**
     * What to do when the CAS is LOST — another writer moved the run first.
     *
     * `"answer"` (the default) reports the state this call re-read, which is
     * what a single-rung release wants: the run moved, and by whom is not this
     * caller's business.
     *
     * `"throw"` re-raises the transition error, for a caller that tries more
     * than one parked state in turn and has to know WHICH rung won — a rung
     * that silently reported the run's current state would be indistinguishable
     * from the rung that actually released it, and the compensation would then
     * revert the run to a state it was never in.
     */
    onLostRace?: "answer" | "throw";
  };
  authority: OrgWriteAuthority | undefined;
};

/**
 * Release a parked run.
 *
 * THE CAS COMES FIRST, AND THE CLEAR FOLLOWS IT. The clear used to run ahead of
 * the transition, which reads better and is wrong: a call that then LOSES the
 * CAS has already wiped a moment it does not own, and the writer that really
 * released the run — or a writer that parked it at a different moment in the
 * window — finds its own record gone. Winning the CAS is the only proof that
 * this call is the one releasing this run, so it is what the clear waits for.
 *
 * The residual runs the other way and is the small one: between the transition
 * and the clear the row is released while still naming a moment. A host that
 * mounts in that window re-reads the run's state server-side on mount and finds
 * a run that is no longer waiting — which is the same answer it gets for any
 * card whose moment has just ended.
 *
 * All three columns go null together — a card kind left behind by a moment that
 * is over is the same defect in a quieter form.
 */
export async function advanceAgentRun(input: AdvanceInput): Promise<CoordinatorAnswer> {
  const { run, release, authority } = input;

  try {
    await transitionRunStatus(run.id, release.from, release.to, undefined, authority);
  } catch (err) {
    if (
      err instanceof RunTransitionError &&
      err.code === "stale_from_status" &&
      (release.onLostRace ?? "answer") === "answer"
    ) {
      const current = await readAgentRunById(run.id);
      if (!current) {
        throw new Error(`Run ${run.id} lost the release race and no longer reads back.`);
      }
      // NOT CLEARED. This call released nothing, so it states nothing about
      // what the run is waiting at.
      return {
        carrier: { kind: "run", run: current },
        status: current.status,
        moment: null,
      };
    }
    throw err;
  }

  if (release.dispatch.kind === "enqueue") {
    const options = release.dispatch.options;
    try {
      await enqueueAgentRun(
        { runId: run.id },
        typeof options === "function" ? options(run as AgentRunRecord) : options,
      );
    } catch (enqueueErr) {
      // THE SAME LADDER `launchAgentRun` CLIMBS, and for the same reason: a run
      // sitting in the released status with no job behind it is the one state
      // nothing recovers on its own. No worker picks it up, and no surface
      // offers a person a way to move it.
      //
      // Back to the state it was parked at — decidable again, and the person
      // can retry — failing that to `failed` with the reason, which is terminal
      // and visible and which every surface already renders. Failing both, the
      // throw NAMES the run as stranded instead of reporting only the enqueue
      // failure that started it.
      //
      // Reverting is safe even when the enqueue error was ambiguous: exactly-once
      // dispatch rests on the RUN ROW, not on the queue — the worker skips a run
      // that is not `queued`, and the work sits behind a `queued → running` CAS.
      // The residual is the benign direction: a dispatch that succeeded but
      // reported ambiguously is compensated away and the run waits to be
      // retried. A lost dispatch on a visible run, never a duplicate one.
      let recovered: string | null = null;
      try {
        await transitionRunStatus(run.id, release.to, release.from, undefined, authority);
        recovered = release.from;
      } catch (revertErr) {
        // ANOTHER WRITER OWNS THE RUN. A stale `from` means the row has moved on
        // since this call released it — stopped, resumed, finished — and the
        // second rung must NOT run: `queued → stopped → queued` is a legal
        // sequence, so a status-only CAS cannot tell this call's own `queued`
        // from the one a resuming writer just created, and failing that one
        // would kill work somebody restarted. There is nothing here to
        // compensate; the run is somebody else's.
        if (revertErr instanceof RunTransitionError && revertErr.code === "stale_from_status") {
          console.warn(
            "[lifecycle-coordinator] release compensation skipped for run",
            run.id,
            "— another writer moved it after this release; leaving it to them",
          );
          throw enqueueErr;
        }
        console.error(
          "[lifecycle-coordinator] release compensation revert failed for run",
          run.id,
          revertErr,
        );
        try {
          await transitionRunStatus(
            run.id,
            release.to,
            "failed",
            {
              error: `Dispatch failed and the run could not be returned to its waiting state: ${
                enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)
              }`,
            },
            authority,
          );
          recovered = "failed";
        } catch (failErr) {
          console.error(
            "[lifecycle-coordinator] could not land run in any terminal state after a failed release enqueue",
            run.id,
            failErr,
          );
        }
      }
      if (recovered === null) {
        throw new Error(
          `Run ${run.id} is STRANDED: its release dispatched nothing, it could not be returned to its waiting state, and it could not be failed. Original dispatch error: ${
            enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)
          }`,
        );
      }
      throw enqueueErr;
    }
  }

  // WON, AND DISPATCHED. Only now is the moment over.
  //
  // THE CLEAR IS LAST, and both neighbours are the reason. Ahead of the CAS it
  // wiped a moment this call had not earned; between the CAS and the enqueue it
  // was lost for good whenever the compensation put the run back at the state it
  // was parked at — a run returned to its wait with nothing to say what it is
  // waiting for is a park with no card. Last, the compensation path never
  // reaches it, so a run that comes back is still stating its moment.
  //
  // Best-effort by the same contract as every other lifecycle record: a failure
  // is logged loudly and the run still goes, because a bookkeeping write must
  // never strand a released run.
  await stateMoment({ run, moment: null, authority });

  const released = await readAgentRunById(run.id);
  return {
    carrier: released
      ? { kind: "run", run: released }
      : { kind: "run", run: run as AgentRunRecord },
    status: released?.status ?? release.to,
    moment: null,
  };
}

// ---------------------------------------------------------------------------
// 3. the agent pauses to ask
// ---------------------------------------------------------------------------

export type HitlInput = {
  run: Pick<AgentRunRecord, "id" | "orgId" | "status">;
  /** The server-checked reference of the screen the agent is asking on. */
  screenRef: string;
  authority: OrgWriteAuthority | undefined;
};

/**
 * The agent paused to ask for input.
 *
 * NO POLICY. The step asks or it does not; there is no rule to consult and
 * nothing to decide. What this entry does is make the pause a RECORDED FACT
 * instead of a shape a screen has to recognize — which is why
 * `classifyRunWaitInterrupt` can now read the moment off the row instead of
 * matching a synthetic task-id prefix.
 */
export async function onAgentHitl(input: HitlInput): Promise<CoordinatorAnswer> {
  await stateMoment({
    run: input.run,
    moment: "hitl",
    cardRef: input.screenRef,
    authority: input.authority,
  });
  const current = await readAgentRunById(input.run.id);
  return {
    carrier: current
      ? { kind: "run", run: current }
      : { kind: "run", run: input.run as AgentRunRecord },
    status: current?.status ?? input.run.status,
    moment: "hitl",
  };
}

// ---------------------------------------------------------------------------
// 4. an artifact write is recorded
// ---------------------------------------------------------------------------

export type ProducedInput = {
  run: Pick<AgentRunRecord, "id" | "orgId" | "status">;
  /** Did the policy open a review for this write? Decided by the review core. */
  reviewOpened: boolean;
  /** The review's server-checked reference, when one opened. */
  reviewRef?: string | null;
  authority: OrgWriteAuthority | undefined;
};

/**
 * An artifact write was recorded.
 *
 * A REVIEW EXISTS ONLY FOR ARTIFACT-BOUND WORK. An agent whose outputs are bound
 * to no artifact never reaches a review, so this entry records NOTHING for one:
 * `reviewOpened: false` writes no moment and — deliberately — clears none
 * either. A write that produced no review is not evidence about whatever else
 * the run may be waiting at, and clearing a moment this entry did not set would
 * take a card off a host on the strength of an unrelated event.
 *
 * THE REVIEW CORE ITSELF IS W2b's (cinatra#2929): one core with two inputs, the
 * declared targets and the typed output confirmed by the write. This entry is
 * the seam that core reports through, and it takes the decision rather than
 * making it — so W2b fills a named seam instead of inventing a parallel one.
 */
export async function onArtifactProduced(
  input: ProducedInput,
): Promise<CoordinatorAnswer> {
  const moment: LifecycleMoment | null = input.reviewOpened ? "review" : null;
  if (moment !== null) {
    await stateMoment({
      run: input.run,
      moment,
      cardRef: input.reviewRef ?? null,
      authority: input.authority,
    });
  }
  const current = await readAgentRunById(input.run.id);
  return {
    carrier: current
      ? { kind: "run", run: current }
      : { kind: "run", run: input.run as AgentRunRecord },
    status: current?.status ?? input.run.status,
    moment,
  };
}

// ---------------------------------------------------------------------------
// 5. a change lands on reviewed work
// ---------------------------------------------------------------------------

export type ReviewedWorkChangedInput = {
  run: Pick<AgentRunRecord, "id" | "orgId" | "status">;
  /** The audit's server-checked reference. */
  auditRef: string;
  authority: OrgWriteAuthority | undefined;
};

/**
 * A change landed on reviewed work.
 *
 * THE AUDIT DOES NOT PARK THE RUN. It is a READING: it is recorded, its reading
 * is signalled, and the run goes on. This entry therefore states the moment and
 * touches the status not at all — the invariant is asserted here rather than
 * left to each caller to remember, and `lifecycleMomentParksRun` is the one
 * place that says which moments do park.
 */
export async function onReviewedWorkChanged(
  input: ReviewedWorkChangedInput,
): Promise<CoordinatorAnswer> {
  // A structural guard, not a comment: if the shared table ever said the audit
  // parks, this entry would be quietly wrong in a way no caller could see.
  if (lifecycleMomentParksRun("audit")) {
    throw new Error(
      "the audit moment is recorded WITHOUT parking the run — the shared moment table now says otherwise, and one of the two is wrong",
    );
  }
  await stateMoment({
    run: input.run,
    moment: "audit",
    cardRef: input.auditRef,
    authority: input.authority,
  });
  const current = await readAgentRunById(input.run.id);
  return {
    carrier: current
      ? { kind: "run", run: current }
      : { kind: "run", run: input.run as AgentRunRecord },
    // UNCHANGED, and that is the point of this entry.
    status: current?.status ?? input.run.status,
    moment: "audit",
  };
}
