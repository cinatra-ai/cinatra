import "server-only";

import { verifySessionAuthority } from "@/lib/org-write/authority";
import { enqueueAgentRun, enqueueDepsForTemplate } from "@/lib/agent-run-enqueue";
import { asActionablePreflightError } from "./actionable-preflight-error";
import {
  readAgentRunById,
  readAgentTemplateById,
  transitionRunStatus,
  RunTransitionError,
  slugifyAgentTemplateName,
} from "./store";
import {
  maybeHoldRunForRecommendation,
  readRecommendationParkForRun,
} from "./recommendation-hold";

// ===========================================================================
// THE ACTOR-PARAMETERIZED RUN-START DISPATCHER (cinatra#2790, epic #2784 S9f).
//
// WHY IT LIVES HERE. The run-start dispatch used to exist ONLY inside
// `triggerAgentRun`, in `run-actions.ts` — a `"use server"` module, so its
// first line was `requireAuthSession()` and its identity could only ever be a
// cookie. That is the whole defect this module closes: the widget's
// recommendation decision authenticates with its own credential, releases the
// park and writes its selections, and then reached a dispatcher that asked a
// browser cookie who was calling. There is no cookie in a cross-site frame, so
// the dispatch answered `unauthorized`, the run stayed `pending_input`, and the
// card drew a refusal on a decision that had already been recorded.
//
// So the dispatch moved out of the identity that used to be baked into it. Step
// 1 — resolve who is calling — belongs to the ENTRY; every step after it is
// here, unchanged, taking the already-verified principal. Two entries feed it
// and there is no third:
//
//   · the session entry — `triggerAgentRun`, unchanged in shape and in
//     behaviour, which resolves the cookie session and hands its user id down;
//   · the broker entry — the widget recommendation decision, which hands down
//     the principal its `cwu_` proved, bound to the org that credential names
//     and to the ONE run the route already checked it owns.
//
// THIS MODULE IS DELIBERATELY NOT A `"use server"` MODULE, and that is
// load-bearing. Every export of a server-action module is a client-callable
// endpoint; an exported dispatcher that TAKES a principal would therefore be an
// endpoint on which any browser could name any user. Identity is resolved by the
// entries, which are the only things a client can reach.
//
// NOTHING WAS RELAXED IN THE MOVE. The same checks run in the same order, and
// the broker principal only ever adds checks: the run must be the exact one its
// credential was authorized against, it must carry an initiator, that initiator
// must be this person, and it must live in the org the credential binds.
//
// ONE OBSERVABLE DIFFERENCE, named here rather than left to be discovered: the
// two best-effort console lines below now carry `[dispatchRunStartForPrincipal]`
// where they used to carry `[triggerAgentRun]`. Nothing reads either string —
// they are operator breadcrumbs — and the old one would be a lie on the broker
// host, which does not go through `triggerAgentRun` at all. Authorization, run
// state and every returned result are unchanged.
// ===========================================================================

export type RunStartDispatchArgs = {
  runId: string;
  templateSlug: string; // used for run/template consistency check
};

export type RunStartDispatchResult =
  | { ok: true }
  // `code`/`settingsHref` carry an actionable run-preflight failure
  // (a missing/unconfigured connector or LLM provider) so the UI can
  // deep-link the fix instead of showing a generic "enqueue failed".
  | { ok: false; error: string; code?: string; settingsHref?: string };

/**
 * WHO is dispatching, as proven by the entry — never as claimed by a caller.
 *
 * A discriminated union rather than a bag of optional fields, so the broker
 * variant cannot be constructed without its bindings: a widget dispatch that
 * forgot to name its org or its run would not compile, instead of quietly
 * becoming a session-shaped dispatch with a wider reach.
 */
export type RunStartDispatchPrincipal =
  | {
      /** The cookie host — `triggerAgentRun` resolved this from the session. */
      via: "session";
      userId: string;
    }
  | {
      /**
       * The broker host — a widget lifecycle route resolved this from the
       * presented `cwu_` at that route's audience, under its own grant.
       */
      via: "widget-credential";
      userId: string;
      /** The org the CREDENTIAL binds. The run must live in it. */
      orgId: string;
      /** The ONE run this credential was authorized against on this request. */
      runId: string;
    };

/**
 * The run statuses the canonical run-START dispatcher accepts (cinatra#2523).
 * Both are PRE-DISPATCH waiting states with a legal `→queued` edge:
 *   - `pending_input`   — created, never dispatched (or returned from `armed`);
 *   - `pending_trigger` — setup finished, awaiting the user's trigger choice.
 *
 * Declared next to the dispatcher because the run-start recommendation chip-row
 * releases its park through it: a run parked from `pending_trigger` must
 * dispatch on the decision, not be misread as "already advanced".
 */
const RUN_START_DISPATCH_FROM_STATUSES = ["pending_input", "pending_trigger"] as const;

export async function dispatchRunStartForPrincipal(
  args: RunStartDispatchArgs,
  principal: RunStartDispatchPrincipal,
): Promise<RunStartDispatchResult> {
  // 1. The principal the ENTRY verified. This module never resolves one.
  const userId = principal.userId;
  if (!userId) return { ok: false, error: "unauthorized" };

  // 1b. THE CREDENTIAL BINDING, on the broker host only. A widget credential
  //     authorizes the run its request was checked against and nothing else, so
  //     a dispatcher handed to the decision core can never be aimed at a second
  //     run — not even by a later edit that passes the wrong id.
  if (principal.via === "widget-credential" && args.runId !== principal.runId) {
    return { ok: false, error: "forbidden" };
  }

  // 2. Load run
  const run = await readAgentRunById(args.runId);
  if (!run) return { ok: false, error: "run not found" };

  // 3. Ownership check
  if (run.runBy && run.runBy !== userId) {
    return { ok: false, error: "forbidden" };
  }

  // 3b. THE BROKER BINDING, re-applied against the row this module just read —
  //     the same two facts the widget route checked before it wrote anything
  //     (`widgetSessionOwnsRun`), re-checked here so the dispatch cannot be
  //     reached with a wider reach than the decision was.
  //
  //     A run with NO initiator is refused on this branch rather than admitted.
  //     In the app a `runBy`-less run is dispatchable by any signed-in session
  //     (the trigger semantics above), but "anyone in the org" is not a binding
  //     to THIS conversation, and a headless carrier run is exactly the kind a
  //     widget must not be able to reach by id.
  if (principal.via === "widget-credential") {
    if (!run.runBy) return { ok: false, error: "forbidden" };
    if (!run.orgId || run.orgId !== principal.orgId) {
      return { ok: false, error: "forbidden" };
    }
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
  // But this is reached from a PUBLIC entry, so "the owner asked" is not enough
  // to admit that state: it would let a run be dispatched straight past the
  // trigger step the state exists to wait for. Admit it only on the evidence
  // that put it here — a run-start recommendation park that has been DECIDED.
  //
  // "Decided" is checked HERE, not left to the live-park short-circuit below:
  // that read and the hold evaluation after it are both fail-OPEN, so a
  // truthiness test on the park row would let an undecided run through whenever
  // those reads failed. A missing park, an unreadable park, and a park still
  // `parked` all refuse.
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
      // Parked — the chip-row decision (session action or broker route)
      // releases it and dispatches. Do NOT transition or enqueue here.
      return { ok: true };
    }
  } catch (err) {
    // The run id is a request-controlled value; keep it OUT of the console
    // format-string position (pass it as a discrete argument) so a `%`-bearing
    // id can never be interpreted as a util.format specifier (CodeQL
    // js/tainted-format-string).
    console.warn(
      "[dispatchRunStartForPrincipal] recommendation hold evaluation failed for run",
      args.runId,
      "— dispatching normally:",
      err instanceof Error ? err.message : String(err),
    );
  }
  // The acting member's LIVE org standing grounds both the dispatch and its
  // compensation. Resolved from (userId, run.orgId) — the person and the org,
  // never an ambient session — so it fails closed identically for a cookie
  // caller whose membership was revoked and for a widget caller whose was.
  const authority = await verifySessionAuthority(userId, run.orgId);

  // 6. Atomic compare-and-swap onto `queued`. Returns false if a concurrent
  //    request already won the race.
  //
  // cinatra#2523 made this a two-rung ladder for the same reason as the state
  // check above: both pre-dispatch waiting states are legal dispatch sources,
  // and the rung that WINS is remembered so the compensation below reverts the
  // run to where it actually was rather than rewriting its state.
  let dispatchedFrom: (typeof RUN_START_DISPATCH_FROM_STATUSES)[number] | null = null;
  for (const from of RUN_START_DISPATCH_FROM_STATUSES) {
    try {
      await transitionRunStatus(args.runId, from, "queued", undefined, authority);
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
        "[dispatchRunStartForPrincipal] compensation revert failed for run",
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
