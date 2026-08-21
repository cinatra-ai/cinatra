import "server-only";

import {
  SKIP_RECOMMENDATION_SOURCE,
  decidedSkillsFromEvidence,
  hasRunRecommendationSkip,
  readRunRejectedRecommendations,
  readRunSelectedSkillRevisions,
  writeRunRejectedRecommendations,
  type RunRecommendationDecidedSkill,
  type RunRejectedRecommendation,
} from "@/lib/run-selected-skill-revisions";

import { enforceRunAccess, resolveEffectivePolicy } from "./auth-policy";
import { getRunRecommendations } from "./recommendation-interception";
import {
  RECOMMENDATION_DECISION_REFUSAL,
  decodeRecommendationHoldRef,
  encodeRecommendationHoldRef,
  publishRecommendationHoldResume,
  readRecommendationParkForRun,
  recommendationHoldThreadId,
  releaseRecommendationParkForRun,
  resolveRecommendationCandidateSkillIds,
  type RecommendationHoldActor,
} from "./recommendation-hold";
import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";
import { getAssignedSkillIdsForAgent } from "@/lib/agents-store";
import { confirmRunSkillSelection } from "./recommendation-interception";
import type { RecommendationEfficacy } from "@cinatra-ai/skills/recommendation";
import {
  readAgentRunById,
  readAgentTemplateById,
  readRunCoOwners,
  type AgentRunRecord,
} from "./store";
import type { ParkRow } from "./lifecycle-continuation-park-store";
import type { RecommendedSkillForChip } from "./server-actions";

// ===========================================================================
// THE ACTOR-PARAMETERIZED HOLD CORE (cinatra#2790, epic #2784 S9f).
//
// WHY IT LIVES HERE, AND WHY IT IS PARAMETERIZED.
//
// The recommendation card's read and its two decisions used to exist ONLY as
// cookie-bound server actions (`run-recommendation-actions.ts`, a `"use server"`
// module), which resolve their identity from the ambient session and cannot
// carry a host credential. That is what withheld the card from the site widget:
// on a surface that declares its own broker proof — and is same-origin to the
// app — a session-derived read would answer, and a session-derived decision
// would RECORD, as whoever else is signed in on that browser.
//
// So the ladder moved out of the identity that used to be baked into it. Every
// function below takes the ALREADY-VERIFIED actor and its role hints, and does
// exactly what it always did with them. Two entries feed it and there is no
// third:
//
//   · the session entry — `run-recommendation-actions.ts`, unchanged in shape,
//     which resolves the cookie session and hands the actor down;
//   · the broker entry — `src/app/api/lifecycle-views/recommendation-hold/**`,
//     which consumes the widget's own `cwu_` at that route's audience with the
//     lifecycle grant required, resolves the reader's LIVE standing, and hands
//     the SAME actor shape down.
//
// The authorization is therefore not "the same by assertion": it is the same
// code, reached with an actor built the same way. A widget reader's read set and
// decision outcomes are the app's by construction.
//
// WHY THE DISPATCHER IS HANDED IN. Releasing a hold ends in `triggerAgentRun`,
// which lives in `run-actions.ts` — and `run-actions.ts` already imports THIS
// module. Importing it back would close a module cycle in the middle of the
// run's security path. The entry that owns a dispatcher passes it; this module
// never picks one, and a caller that passes none releases the park without
// dispatching (which is not a state any shipped entry uses).
// ===========================================================================

export type { RecommendationHoldActor } from "./recommendation-hold";

/** What the card may draw right now, for THIS reader. */
export type RunRecommendationHoldState =
  | { state: "none" }
  | {
      state: "held";
      agentPackageName: string;
      promptText: string;
      recommendations: RecommendedSkillForChip[];
      /**
       * OPAQUE handle to THIS hold instance (cinatra#2568). The row hands it
       * back on confirm/skip so the decision is bound to the hold it was taken
       * against. Empty when no ref can be minted (no app secret): the decision
       * then falls back to the pre-#2568 run-scoped behaviour rather than
       * becoming un-decidable.
       */
      holdRef: string;
      /**
       * Whether THIS reader may shape the run — §V's read-only reading.
       *
       * PRESENTATION ONLY, and deliberately so: the decision core below
       * re-authorizes on its own and never reads this flag, so it can neither
       * grant nor remove authority. Derived FAIL-OPEN — a derivation that cannot
       * answer says `true`, because withholding the affordances from a reader
       * who may in fact decide is a regression, while showing them to a reader
       * who may not costs one honest refusal line.
       */
      canDecide: boolean;
    }
  | {
      state: "confirmed";
      skillNames: string[];
      decided: RunRecommendationDecidedSkill[];
    }
  | { state: "skipped"; decided: RunRecommendationDecidedSkill[] };

export type RunRecommendationDecisionResult =
  | { ok: true; dispatched: boolean }
  | { ok: false; error: string; code?: string; settingsHref?: string };

/** The authoritative per-run selection write, handed in by the entry. */
export type RecommendationSelectionWrite = (input: {
  runId: string;
  agentPackageName?: string;
  confirmedSkillIds: string[];
  promptText?: string;
  declaredProducedTypes?: string[];
  targetArtifactKind?: string;
  forcedRevisions?: Record<string, string>;
  adjustedSkillIds?: string[];
}) => Promise<{ ok: boolean }>;

/** The canonical dispatcher, handed in by the entry (see the header). */
export type RecommendationDispatch = (input: {
  runId: string;
  templateSlug: string;
}) => Promise<
  { ok: true } | { ok: false; error: string; code?: string; settingsHref?: string }
>;

/**
 * Can this reader DECIDE this run's recommendation? The same execute-tier gate
 * the selection write enforces, read here so the card can draw §V's read-only
 * chips instead of offering a press that would only ever be refused. FAIL-OPEN
 * by contract — see `canDecide`.
 */
async function readerMayDecide(
  run: AgentRunRecord,
  who: RecommendationHoldActor,
): Promise<boolean> {
  try {
    const runTemplate = await readAgentTemplateById(run.templateId).catch(() => null);
    const coOwnerUserIds = (await readRunCoOwners(run.id).catch(() => [])).map((r) => r.userId);
    await enforceRunAccess(
      { ...run, effectivePolicy: resolveEffectivePolicy(run, runTemplate), coOwnerUserIds },
      who.actor,
      "execute",
      who.roleHints,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * DISPLAY NAMES FOR THE SETTLED READING (cinatra#2841).
 *
 * §V's chips print a skill's NAME — held and settled alike. The run's durable
 * evidence carries ids only, so the settled row joins the names in here, through
 * the same run-actor candidate seam and scorer the held branch uses.
 *
 * NOT VIEWER-INTERSECTED, deliberately: the decided summary is the set THIS run
 * resolved, which the run's own Skills tab already lists to every reader who
 * clears the same run-read door. Only the LIVE candidate row is intersected.
 *
 * BEST-EFFORT BY CONTRACT: a failure costs labels, never the card.
 */
async function resolveDecidedSkillNames(run: AgentRunRecord): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const template = await readAgentTemplateById(run.templateId).catch(() => null);
    const packageName = template?.packageName;
    if (!packageName) return names;
    const candidateSkillIds = await resolveRecommendationCandidateSkillIds({ run, packageName });
    let promptText = "";
    try {
      promptText = JSON.stringify(run.inputParams ?? {});
    } catch {
      promptText = "";
    }
    const recs = await getRunRecommendations({
      agentId: packageName,
      intent: { promptText },
      restrictToSkillIds: candidateSkillIds,
    });
    for (const r of recs) {
      if (r.skillId && r.displayName) names.set(r.skillId, r.displayName);
    }
  } catch {
    /* labels only — an unresolvable name never costs the settled card */
  }
  return names;
}

/**
 * THE READ LADDER, for one verified reader.
 *
 * AUTHORIZATION (cinatra#2148): the run is loaded THROUGH the access door —
 * `readAgentRunById(runId, actor, roleHints)` runs `enforceRunAccess(…, "read",
 * …)` and throws for a run this reader may not see. The park read sits BEHIND
 * that door so an unauthorized caller cannot even probe a run's hold state, and
 * the live candidate row is intersected against the reader's OWN entitlement so
 * a non-owner never learns the owner's scoped skill names.
 *
 * Every denial answers `{ state: "none" }` — indistinguishable from a run that
 * was never held, which is the same posture the lifecycle resolve holds.
 */
export async function resolveRecommendationHoldStateForActor(input: {
  runId: string;
  who: RecommendationHoldActor;
}): Promise<RunRecommendationHoldState> {
  const { runId, who } = input;
  if (!runId) return { state: "none" };
  if (!who.actor.userId) return { state: "none" };

  // Access door FIRST — every branch below is behind it.
  const run = await readAgentRunById(runId, who.actor, who.roleHints).catch(() => null);
  if (!run) return { state: "none" };

  const park = await readRecommendationParkForRun(runId).catch(() => null);
  if (!park) return { state: "none" };

  if (park.status !== "parked") {
    // DECIDED summary. Deliberately NOT viewer-filtered — see
    // `resolveDecidedSkillNames`.
    const selected = readRunSelectedSkillRevisions(runId);
    let rejected: RunRejectedRecommendation[] = [];
    try {
      rejected = readRunRejectedRecommendations(runId);
    } catch {
      rejected = [];
    }
    const nameBySkillId = await resolveDecidedSkillNames(run);
    const decided = decidedSkillsFromEvidence(selected, rejected, nameBySkillId);
    if (selected.length > 0) {
      return {
        state: "confirmed",
        skillNames: selected.map((s) => nameBySkillId.get(s.skillId) ?? s.skillId),
        decided,
      };
    }
    if (hasRunRecommendationSkip(runId)) return { state: "skipped", decided };
    return { state: "none" };
  }

  const template = await readAgentTemplateById(run.templateId).catch(() => null);
  const packageName = template?.packageName;
  if (!packageName) return { state: "none" };

  const assignedSkillIds = await resolveRecommendationCandidateSkillIds({
    run,
    packageName,
    viewer: viewerScopeForHoldActor(who),
  });
  let promptText = "";
  try {
    promptText = JSON.stringify(run.inputParams ?? {});
  } catch {
    promptText = "";
  }
  const recs = await getRunRecommendations({
    agentId: packageName,
    intent: { promptText },
    restrictToSkillIds: assignedSkillIds,
  }).catch(() => []);
  return {
    state: "held",
    agentPackageName: packageName,
    promptText,
    canDecide: await readerMayDecide(run, who),
    holdRef: encodeRecommendationHoldRef({ runId, holdId: park.id }) ?? "",
    recommendations: recs.map((r) => ({
      skillId: r.skillId,
      skillRevisionId: r.skillRevisionId,
      name: r.displayName,
      score: r.score,
      rank: r.rank,
      recommended: r.recommended,
      scoredFeatures: r.scoredFeatures,
    })),
  };
}

/**
 * THE HOLD-INSTANCE BINDING (cinatra#2568). Resolves the hold a decision is
 * bound to, BEFORE the decision writes anything.
 *
 * A decision taken against hold H is applied to hold H or to nothing. An
 * idempotent RETRY names a hold that is now RELEASED — still this run's hold, so
 * it is accepted. Only a decision naming a hold that is not the run's current
 * park at all is refused, and the refusal is the same generic one an
 * unauthorized caller gets.
 */
async function resolveDecisionHold(
  runId: string,
  holdRef: string | undefined,
): Promise<{ ok: true; holdId: string | null } | { ok: false }> {
  const park = await readRecommendationParkForRun(runId).catch(() => null);
  if (!holdRef) return { ok: true, holdId: park?.id ?? null };
  const claimed = decodeRecommendationHoldRef(holdRef);
  const matches =
    claimed !== null &&
    claimed.runId === runId &&
    park !== null &&
    park.id === claimed.holdId;
  return matches ? { ok: true, holdId: claimed!.holdId } : { ok: false };
}

/**
 * Shared release + dispatch. Releases the run-start recommendation park then
 * dispatches through the canonical dispatcher the entry handed in.
 *
 * The release is VERIFIED before dispatching (cinatra#2148) and the verification
 * read FAILS CLOSED: "I could not confirm the release" must never become
 * "dispatched". The typed hold interrupt is retired on exactly that verification
 * (cinatra#2568) — never optimistically, so the wire can under-report a hold's
 * end but can never claim a run was freed while it is still waiting.
 */
async function releaseAndDispatch(
  runId: string,
  boundHoldId: string | null,
  holdNamed: boolean,
  dispatch: RecommendationDispatch | undefined,
): Promise<RunRecommendationDecisionResult> {
  const HOLD_STILL_LIVE = {
    ok: false as const,
    error: "could not release the run-start recommendation hold — please retry",
  };

  await releaseRecommendationParkForRun(
    runId,
    holdNamed && boundHoldId ? boundHoldId : undefined,
  ).catch(() => false);
  let parkAfterRelease: ParkRow | null;
  try {
    parkAfterRelease = await readRecommendationParkForRun(runId);
  } catch {
    return HOLD_STILL_LIVE;
  }
  if (parkAfterRelease?.status === "parked") return HOLD_STILL_LIVE;

  const run = await readAgentRunById(runId).catch(() => null);
  if (!run) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  const releasedHoldId = boundHoldId ?? parkAfterRelease?.id ?? null;
  if (releasedHoldId) {
    try {
      await publishRecommendationHoldResume({
        runId,
        threadId: recommendationHoldThreadId(run),
        holdId: releasedHoldId,
      });
    } catch {
      /* announced or not, the decision's outcome stands */
    }
  }

  if (run.status !== "pending_input" && run.status !== "pending_trigger") {
    return { ok: true, dispatched: false };
  }
  if (!dispatch) return { ok: true, dispatched: false };

  const result = await dispatch({ runId, templateSlug: run.templateId });
  if (!result.ok) {
    return { ok: false, error: result.error, code: result.code, settingsHref: result.settingsHref };
  }
  return { ok: true, dispatched: true };
}

/**
 * CONFIRM / ADJUST for one verified reader: persist the confirmed selection
 * (execute-tier authorized by `writeRunSkillSelectionForActor`), then release the
 * run-start hold and dispatch.
 */
export async function confirmRecommendationForActor(input: {
  runId: string;
  confirmedSkillIds: string[];
  who: RecommendationHoldActor;
  /** Carried for the session entry's action signature; the write re-derives the
   *  package from the RUN'S template and never trusts this value. */
  agentPackageName?: string;
  /**
   * THE AUTHORITATIVE SELECTION WRITE, handed in by the entry (cinatra#2790).
   *
   * The session entry passes `confirmRunSkillSelectionAction`, whose gate is
   * resolved from the cookie session; the broker entry passes
   * `writeRunSkillSelectionForActor`, the same gate resolved from the widget's
   * own credential. One gate, two identities — and the action delegates to the
   * actor-parameterized twin, so there is exactly one implementation of it.
   */
  writeSelection: RecommendationSelectionWrite;
  promptText?: string;
  declaredProducedTypes?: string[];
  targetArtifactKind?: string;
  forcedRevisions?: Record<string, string>;
  adjustedSkillIds?: string[];
  holdRef?: string;
  dispatch?: RecommendationDispatch;
}): Promise<RunRecommendationDecisionResult> {
  if (!input.who.actor.userId) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };
  if (!input.runId) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  // 0. The hold-instance CAS — BEFORE any write, so a decision aimed at a hold
  //    the run has moved past leaves no trace on the run at all.
  const bound = await resolveDecisionHold(input.runId, input.holdRef);
  if (!bound.ok) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  const written = await input.writeSelection({
    runId: input.runId,
    agentPackageName: input.agentPackageName,
    confirmedSkillIds: input.confirmedSkillIds,
    ...(input.promptText !== undefined ? { promptText: input.promptText } : {}),
    ...(input.declaredProducedTypes ? { declaredProducedTypes: input.declaredProducedTypes } : {}),
    ...(input.targetArtifactKind ? { targetArtifactKind: input.targetArtifactKind } : {}),
    ...(input.forcedRevisions ? { forcedRevisions: input.forcedRevisions } : {}),
    ...(input.adjustedSkillIds ? { adjustedSkillIds: input.adjustedSkillIds } : {}),
  });
  if (!written.ok) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  return releaseAndDispatch(input.runId, bound.holdId, input.holdRef !== undefined, input.dispatch);
}

/**
 * SKIP for one verified reader: persist durable skip evidence (a `user_skipped`
 * rejected row per recommended candidate), write NO selection row, then release
 * the hold and dispatch.
 *
 * The ownership check is the same gate the dispatch enforces: a run with an
 * initiator may only be skipped by that person; a run without one accepts any
 * verified caller, matching the trigger semantics.
 */
export async function skipRecommendationForActor(input: {
  runId: string;
  who: RecommendationHoldActor;
  holdRef?: string;
  dispatch?: RecommendationDispatch;
}): Promise<RunRecommendationDecisionResult> {
  const userId = input.who.actor.userId ?? null;
  if (!userId) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };
  if (!input.runId) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  const bound = await resolveDecisionHold(input.runId, input.holdRef);
  if (!bound.ok) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  const run = await readAgentRunById(input.runId).catch(() => null);
  if (!run) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };
  if (run.runBy && run.runBy !== userId) {
    return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };
  }

  // Durable skip evidence. Best-effort — a telemetry write must never block the
  // dispatch.
  try {
    const template = await readAgentTemplateById(run.templateId).catch(() => null);
    const packageName = template?.packageName;
    if (packageName) {
      const assignedSkillIds = await resolveRecommendationCandidateSkillIds({ run, packageName });
      let intentPromptText = "";
      try {
        intentPromptText = JSON.stringify(run.inputParams ?? {});
      } catch {
        intentPromptText = "";
      }
      const recommendations = await getRunRecommendations({
        agentId: packageName,
        intent: { promptText: intentPromptText },
        restrictToSkillIds: assignedSkillIds,
      });
      const rejectedRows = recommendations
        .filter((r) => r.recommended)
        .map((r) => ({
          skillId: r.skillId,
          skillRevisionId: r.skillRevisionId,
          recommendationSource: SKIP_RECOMMENDATION_SOURCE,
          recommendedRank: r.rank,
        }));
      writeRunRejectedRecommendations({ runId: input.runId, rejected: rejectedRows });
    }
  } catch (err) {
    // The run id is a request-controlled value; keep it OUT of the console
    // format-string position so a `%`-bearing id can never be interpreted as a
    // util.format specifier (CodeQL js/tainted-format-string).
    console.warn(
      "[skipRecommendationForActor] skip-evidence write failed for run",
      input.runId,
      "— continuing:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return releaseAndDispatch(input.runId, bound.holdId, input.holdRef !== undefined, input.dispatch);
}

// ===========================================================================
// THE ACTOR-PARAMETERIZED SELECTION WRITE (cinatra#2790, epic #2784 S9f).
//
// `confirmRunSkillSelectionAction` used to spell this gate out inside a
// `"use server"` module, which meant it could only ever run for a COOKIE
// session. The site widget's confirm needs the identical gate for a reader
// proven by a broker credential, and two implementations of an execute-tier
// write are two things to keep in step by hand. So the gate moved HERE, where
// both entries reach it, and the action supplies the session actor.
//
// Nothing was relaxed in the move: the same checks run in the same order.
// ===========================================================================

/** The result shape the skill-selection write answers with. */
export type RunSkillSelectionWriteResult = {
  ok: boolean;
  written: number;
  efficacy: RecommendationEfficacy;
};

/**
 * The VIEWER scope a scoped read is intersected against, derived from the
 * verified actor and its hints through ONE projection.
 *
 * Deriving it here rather than at each entry is what keeps the widget's
 * intersection and the session's identical: both the live candidate row and the
 * assigned-set bound below read the same scope for the same reader. It reads
 * nothing and decides nothing — a projection of an actor context that has
 * already been resolved, so it can neither widen nor narrow authority.
 */
function viewerScopeForHoldActor(who: RecommendationHoldActor): {
  principalId: string;
  teamIds: string[];
  projectIds: string[];
  organizationId?: string;
} {
  const ctx = buildActorContextFromPrimitive(who.actor, null, who.roleHints);
  return {
    principalId: ctx.principalId,
    teamIds: ctx.teamIds ?? [],
    projectIds: ctx.projectIds ?? [],
    ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}),
  };
}


/**
 * THE AUTHORITATIVE PER-RUN SELECTION WRITE, for one verified reader.
 *
 * Moved verbatim out of `confirmRunSkillSelectionAction` (which now calls it) so
 * the widget's confirm and the app's confirm are ONE write with ONE gate, rather
 * than two implementations that must be kept in step by hand.
 *
 * The gate is EXECUTE tier, not read: writing the set MUTATES what the run
 * delivers, so a workspace-READ / owner-EXECUTE run must deny a non-owner
 * reader. The agent package is derived from the RUN'S template and never from
 * the caller-supplied name, and the written set is bounded by the agent's
 * already-assigned deliverable skills resolved with THIS reader's scope — so a
 * caller can never force an archived, excluded or unassigned skill into a run,
 * not even as a label.
 */
export async function writeRunSkillSelectionForActor(input: {
  runId: string;
  confirmedSkillIds: string[];
  who: RecommendationHoldActor;
  promptText?: string;
  declaredProducedTypes?: string[];
  targetArtifactKind?: string;
  forcedRevisions?: Record<string, string>;
  adjustedSkillIds?: string[];
}): Promise<RunSkillSelectionWriteResult> {
  const empty: RunSkillSelectionWriteResult = {
    ok: false,
    written: 0,
    efficacy: { accepted: [], rejected: [] },
  };
  const who = input.who;
  if (!who.actor.userId) return empty;
  try {
    if (!input.runId) return empty;
    const run = await readAgentRunById(input.runId).catch(() => null);
    if (!run) return empty;
    const runTemplate = await readAgentTemplateById(run.templateId).catch(() => null);
    const coOwnerUserIds = (await readRunCoOwners(run.id).catch(() => [])).map((r) => r.userId);
    // Resolve the CONCRETE effective policy — a bare `?? null` would leave the
    // policy undefined and `enforceRunAccess` would then SKIP the policy gate.
    const runWithCoOwners = {
      ...run,
      effectivePolicy: resolveEffectivePolicy(run, runTemplate),
      coOwnerUserIds,
    };
    try {
      await enforceRunAccess(runWithCoOwners, who.actor, "execute", who.roleHints);
    } catch {
      return empty;
    }

    const agentPackageName = runTemplate?.packageName;
    if (!agentPackageName) return empty;

    const viewer = viewerScopeForHoldActor(who);
    const assignedIds = await getAssignedSkillIdsForAgent(agentPackageName, {
      principalId: viewer.principalId,
      teamIds: viewer.teamIds,
      projectIds: viewer.projectIds,
      ...(viewer.organizationId ? { organizationId: viewer.organizationId } : {}),
    }).catch(() => [] as string[]);
    const allowed = new Set(assignedIds);
    const forcedRevisions = input.forcedRevisions
      ? Object.fromEntries(
          Object.entries(input.forcedRevisions).filter(([skillId]) => allowed.has(skillId)),
        )
      : undefined;
    const adjustedSkillIds = input.adjustedSkillIds?.filter((skillId) => allowed.has(skillId));

    const result = await confirmRunSkillSelection({
      runId: input.runId,
      agentId: agentPackageName,
      intent: {
        promptText: input.promptText,
        declaredProducedTypes: input.declaredProducedTypes,
        targetArtifactKind: input.targetArtifactKind,
      },
      confirmedSkillIds: input.confirmedSkillIds,
      forcedRevisions,
      adjustedSkillIds,
      restrictToSkillIds: assignedIds,
    });
    return { ok: true, written: result.written, efficacy: result.efficacy };
  } catch {
    return empty;
  }
}

