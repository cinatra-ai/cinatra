import "server-only";

import {
  recommendationRunHasStarted,
  recommendationRunHasStartedForRow,
} from "./run-status";
import {
  SKIP_RECOMMENDATION_SOURCE,
  clearRunSelectedSkillRevisionsBeforeStart,
  decidedSkillsFromEvidence,
  hasRunRecommendationSkip,
  hasRunSelectedSkillRevisions,
  readRunRejectedRecommendations,
  readRunSelectedSkillRevisions,
  readRunRecommendationOfferedSet,
  writeRunRecommendationOfferedSet,
  writeRunRecommendationSkip,
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
  RECOMMENDATION_OFFER_STALE_CODE,
  RECOMMENDATION_RUN_STARTED_REFUSAL,
  RECOMMENDATION_RUN_STARTED_CODE,
  RECOMMENDATION_OFFER_STALE_REFUSAL,
  RECOMMENDATION_OFFER_UNREADABLE_CODE,
  RECOMMENDATION_OFFER_UNREADABLE_REFUSAL,
  RECOMMENDATION_SKIP_NOT_RECORDED,
  RECOMMENDATION_SKIP_NOT_RECORDED_CODE,
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

/**
 * ONE SKILL THE HOLD ITSELF OFFERED, carried into the settled reading
 * (cinatra#2790, epic #2784 S9f).
 *
 * WHY THE DURABLE DECISION EVIDENCE IS NOT ENOUGH ON ITS OWN. §V's settled
 * clause is "one chip per skill, each showing what it recorded", and its own
 * drawing renders the skipped one — `Schedule send ✕ Skipped` — beside the
 * confirmed and the adjusted one. But a skill settled by pressing ITS OWN Skip
 * writes no selection row (the selection store records what the run will use),
 * and the rejected half is written only for a candidate the scorer
 * RECOMMENDED (`recommendation-interception.ts`, `persistRejectedHalf`). So on
 * an offer where nothing scored over the recommend threshold — which is every
 * chip of a run started with no input params — a skipped skill left NO row of
 * any kind, and the settled row drew one chip fewer than the skills it had
 * just asked about.
 *
 * THE OFFER IS THE MISSING HALF, AND IT IS ALREADY DURABLE. The set a card
 * offered is claimed against the hold at the first draw (cinatra#2906). Carried
 * here, it lets the ONE row draw a chip for every skill it offered and state
 * SKIPPED on the ones no decision row names — which is what happened to them.
 */
export type RunRecommendationSettledCandidate = {
  skillId: string;
  /** The manifest displayName the held chip carried, or the id when unresolvable. */
  name: string;
  /**
   * THE VENDOR BESIDE THE NAME (cinatra#3047, review point 3) — the owning
   * package's byline as the platform names vendors everywhere else, resolved
   * server-side by the one vendor resolver. `null` where the package declares
   * none, and the pill then prints the name alone.
   */
  vendorName: string | null;
  /**
   * THE REVISION THE OFFER PINNED, and the offer's own recommended flag
   * (cinatra#3047, review point 1). A settled step whose run has not started is
   * still EDITABLE, and a re-decision rides the same decision path as the first
   * one — which needs exactly what the held row needed: the revision to pin for
   * a kept skill the scorer did not recommend, and whether it recommended it.
   */
  skillRevisionId: string;
  recommended: boolean;
};

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
      /** See `RunRecommendationSettledSelection` — the same three fields on both settled arms. */
      holdRef: string;
      runStarted: boolean;
      canDecide: boolean;
      /**
       * THE HOLD'S OWN OFFER — one entry per skill this reader was asked about,
       * so the settled row can state an outcome for each of them. Absent only
       * where the offer cannot be read (a hold parked before cinatra#2906 owns
       * no claim); the row then keeps exactly the reading it had before.
       */
      candidates?: RunRecommendationSettledCandidate[];
    }
  | {
      state: "skipped";
      decided: RunRecommendationDecidedSkill[];
      /** The same offer, for the same reason — see the `confirmed` arm above. */
      candidates?: RunRecommendationSettledCandidate[];
      /** See `RunRecommendationSettledSelection` — the same three fields on both settled arms. */
      holdRef: string;
      runStarted: boolean;
      canDecide: boolean;
    };

/**
 * THE THREE FIELDS A SETTLED ANSWER CARRIES SO THE SELECTION IS NOT FROZEN
 * (cinatra#3047, review point 1).
 *
 * "Continue records the selection and releases the hold, but the selection is
 * not frozen." Until the run STARTS, the reader who opens the completed Skills
 * step sees the same pills with their boxes editable and one control to save a
 * changed selection; once it has started the same page is read-only with no
 * control at all. Three facts decide that, and all three are the resolver's to
 * answer rather than the screen's:
 *
 *   holdRef    — the SAME opaque handle the held reading carried, so a saved
 *                change is bound to the hold it belongs to and rides the SAME
 *                decision path. `resolveDecisionHold` accepts it: a ref naming a
 *                hold that is now RELEASED is still this run's hold, which is
 *                exactly the idempotent-retry case it already admits, and only a
 *                ref naming a hold the run has moved past is refused.
 *   runStarted — HAS THE RUN'S EXECUTION BEGUN? Answered from the RUN ROW by
 *                `recommendationRunHasStartedForRow` (cinatra#3062): the run's
 *                own `started_at`, stamped once inside the `queued->running`
 *                dispatch CAS, with the platform's `PRE_EXECUTION_RUN_STATUSES`
 *                still deciding every status the stamp cannot answer alone. It
 *                is NOT a status test on its own, because `pending_approval` is
 *                reached both BEFORE execution (the setup interrupt this very
 *                hold parks on) and DURING it, and it is not a local flag a
 *                screen kept: every read, and therefore every reload, asks the
 *                row again.
 *   canDecide  — the same presentation-only reading of this reader's standing
 *                the held branch publishes, resolved by the same function. A
 *                reader who may not shape the run is not handed a live box.
 */
export type RunRecommendationSettledSelection = {
  holdRef: string;
  runStarted: boolean;
  canDecide: boolean;
};

// The boundary itself lives on the pure run-status leaf beside
// `PRE_EXECUTION_RUN_STATUSES` — see `recommendationRunHasStarted` there. It is
// read here, and by the screen, and by the suite that pins it, so there is one
// definition rather than three. `recommendationRunHasStartedForRow` is that same
// boundary asked of the run ROW, which is what this resolver holds.
export { recommendationRunHasStarted, recommendationRunHasStartedForRow };

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
  /**
   * The hold the decision was BOUND to by the hold-instance CAS (cinatra#2906),
   * whose claimed offer this confirm must honour. Threaded from the binding
   * rather than re-read at the write: a run can be released and parked again
   * between the two, and a re-read would then resolve the decision against a
   * different hold's offer.
   */
  holdId?: string | null;
}) => Promise<{
  ok: boolean;
  /**
   * The reader-facing sentence a REFUSED write wants drawn in place of the
   * generic denial (cinatra#2906). The stale-offer refusal describes the
   * CALLER'S OWN next step rather than denying them, so flattening it into the
   * enumeration-proof generic line would cost the reader the one thing they can
   * act on. Absent for every other refusal, which keeps the generic line.
   */
  refusal?: string;
  /** The typed outcome that rides alongside `refusal`. */
  refusalCode?: string;
}>;

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
async function resolveDecidedSkillNames(
  run: AgentRunRecord,
): Promise<{ names: Map<string, string>; vendors: Map<string, string> }> {
  const names = new Map<string, string>();
  // THE OTHER HALF OF THE PILL'S LABEL (cinatra#3047). Resolved from the SAME
  // scored read as the name, so the two halves of "<Skill name> by <vendor>"
  // can never come from two different resolutions of the same skill.
  const vendors = new Map<string, string>();
  try {
    const template = await readAgentTemplateById(run.templateId).catch(() => null);
    const packageName = template?.packageName;
    if (!packageName) return { names, vendors };
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
      if (r.skillId && r.vendorName) vendors.set(r.skillId, r.vendorName);
    }
  } catch {
    /* labels only — an unresolvable name never costs the settled card */
  }
  return { names, vendors };
}

/**
 * THE HOLD'S OWN OFFER, resolved for the SETTLED reading (cinatra#2790).
 *
 * Read back from the claim the FIRST draw wrote against this hold — not
 * re-scored — so the settled row states the outcome of the very set the reader
 * was asked about, whatever has been published since.
 *
 * INTERSECTED AGAINST THIS READER exactly as the held branch intersects its
 * chips, and for the same reason: the settled row is the held row after it
 * settled, so a reader who was never shown a scoped skill does not learn its
 * name from the row's decided reading either.
 *
 * BEST-EFFORT AND ONE-DIRECTIONAL. An offer that cannot be read costs the
 * SKIPPED chips and never the card: the answer falls back to the decided
 * evidence alone, which is the reading this branch had before. A hold parked
 * before cinatra#2906 owns no claim and lands there by construction.
 */
async function resolveSettledCandidates(input: {
  run: AgentRunRecord;
  holdId: string;
  who: RecommendationHoldActor;
  nameBySkillId: ReadonlyMap<string, string>;
  vendorBySkillId: ReadonlyMap<string, string>;
}): Promise<RunRecommendationSettledCandidate[]> {
  const { run, holdId, who, nameBySkillId, vendorBySkillId } = input;
  try {
    const offered = await readRunRecommendationOfferedSet(holdId);
    if (offered.length === 0) return [];
    const template = await readAgentTemplateById(run.templateId).catch(() => null);
    const packageName = template?.packageName;
    if (!packageName) return [];
    const entitled = new Set(
      await resolveRecommendationCandidateSkillIds({
        run,
        packageName,
        viewer: viewerScopeForHoldActor(who),
      }),
    );
    return offered
      .filter((o) => entitled.has(o.skillId))
      .map((o) => ({
        skillId: o.skillId,
        name: nameBySkillId.get(o.skillId) ?? o.skillId,
        vendorName: vendorBySkillId.get(o.skillId) ?? null,
        // THE OFFER'S OWN decisive fields, read back from the claim rather than
        // re-scored, so a pre-start re-decision pins exactly what the first draw
        // put on the card (cinatra#3047, review point 1).
        skillRevisionId: o.skillRevisionId,
        recommended: o.recommended,
      }));
  } catch {
    return [];
  }
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
/**
 * WAS THIS RUN'S RECOMMENDATION ANSWERED? — the RUN's own reading of the
 * question the card resolves for a viewer (cinatra#3047).
 *
 * WHO ASKS, AND WHY IT IS NOT THE CARD. The run page draws no skill picker
 * inside its run-progress panel for a run whose skills were decided on the card
 * ("The agentic run progress card appears once the skills are decided; no skill
 * inside it can be selected"). The panel used to answer that from a
 * recommendation card of its own; that mount is deleted — the row has one owner
 * and one place — so the screen answers it server-side, before the first paint,
 * and hands the panel a boolean.
 *
 * WHY IT LIVES HERE, beside the resolver rather than in the screen. "Decided"
 * has exactly one definition, and it is the one the ladder below applies to a
 * terminal park: a selection set on file means CONFIRMED, a skip record means
 * SKIPPED, and neither means the question was never answered. A screen that
 * re-expressed that from the park's status alone would be a second definition —
 * and a wrong one, because the park's status and the decision's evidence are not
 * written atomically: a confirm or a skip that races the TTL sweeper leaves a
 * `policy_unresolved` park with real evidence behind it, which the card reads as
 * decided and a status-only test would call undecided, putting the forbidden
 * picker back on the page.
 *
 * NOT ACTOR-SCOPED, deliberately, and it is not a viewer's answer: the decided
 * reading is not viewer-filtered in the ladder below either, and the only caller
 * has already cleared the run's own access door before it asks.
 *
 * FAILS TOWARD THE PICKER. An unreadable store answers "not decided", which
 * leaves the panel exactly as it was before this rule existed — the same posture
 * the rule has always taken for a read that gives up.
 */
export function recommendationDecidedForRun(input: {
  runId: string;
  /** The run's `recommendation_hold` park status, or null when it never held. */
  parkStatus: string | null | undefined;
}): boolean {
  const { runId, parkStatus } = input;
  if (!runId) return false;
  // A live hold is the question still open, and no park at all is a run that was
  // never asked. Only a TERMINAL park can carry a decision.
  if (parkStatus == null || parkStatus === "parked") return false;
  try {
    if (hasRunSelectedSkillRevisions(runId)) return true;
    return hasRunRecommendationSkip(runId);
  } catch {
    return false;
  }
}

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
    //
    // THIS LADDER IS THE DEFINITION OF "DECIDED" (cinatra#3047): a selection set
    // means confirmed, a skip record means skipped, neither means nobody
    // answered. `recommendationDecidedForRun` above is the same ladder as a
    // boolean, for the run page's server-side read; change one and change both.
    const selected = readRunSelectedSkillRevisions(runId);
    let rejected: RunRejectedRecommendation[] = [];
    try {
      rejected = readRunRejectedRecommendations(runId);
    } catch {
      rejected = [];
    }
    const { names: nameBySkillId, vendors: vendorBySkillId } =
      await resolveDecidedSkillNames(run);
    const decided = decidedSkillsFromEvidence(selected, rejected, nameBySkillId);
    // THE OFFER RIDES BOTH SETTLED ANSWERS, and therefore BOTH TRANSPORTS: the
    // cookie action and the broker read route each return this state verbatim,
    // so the row is handed the same shape whichever host drew it. There is no
    // second path and no host-specific settled reading.
    const candidates = await resolveSettledCandidates({
      run,
      holdId: park.id,
      who,
      nameBySkillId,
      vendorBySkillId,
    });
    // THE SELECTION IS NOT FROZEN UNTIL THE RUN STARTS (cinatra#3047, review
    // point 1) — see `RunRecommendationSettledSelection` for what each of these
    // three answers and why the resolver is the one that answers it.
    const settledSelection: RunRecommendationSettledSelection = {
      holdRef: encodeRecommendationHoldRef({ runId, holdId: park.id }) ?? "",
      runStarted: recommendationRunHasStartedForRow(run),
      canDecide: await readerMayDecide(run, who),
    };
    if (selected.length > 0) {
      return {
        state: "confirmed",
        skillNames: selected.map((s) => nameBySkillId.get(s.skillId) ?? s.skillId),
        decided,
        candidates,
        ...settledSelection,
      };
    }
    if (hasRunRecommendationSkip(runId)) {
      return { state: "skipped", decided, candidates, ...settledSelection };
    }
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

  // THE OFFER IS CLAIMED AS IT IS DRAWN, AND THE CARD IS DRAWN FROM IT
  // (cinatra#2906).
  //
  // What the confirm may pin is decided HERE, by what a reader is shown — not
  // later, by asking for the list again and recording against a different
  // answer. The FIRST draw claims the offer; every later draw reads that claim
  // back and renders it, so two readers of one hold see one card and neither
  // can have the other's offer moved under them.
  //
  // The claim carries only the four fields that decide an outcome (skill, pinned
  // revision, recommended-ness, rank). The LABEL, SCORE and FEATURE BREAKDOWN
  // stay presentation and are joined from THIS reader's own live scoring below —
  // which is also what keeps the viewer intersection intact: a chip is drawn only
  // where the claimed offer and this reader's own entitled candidate set agree,
  // so a narrower reader still never learns a wider one's scoped skill names.
  //
  // BEST-EFFORT, and one-directional: a claim that could not be written or read
  // costs the FIX and never the card. This is the ONE remaining fall-through and
  // it is named rather than implied - a hold whose claim write failed is
  // indistinguishable from a hold parked before this shipped, so its confirm
  // takes the pre-#2906 path. Fail-closing the DRAW instead would make the card
  // vanish from a run that is genuinely waiting on it, which is worse than the
  // defect. The run id is a discrete argument, never in the format-string
  // position.
  let offered: Awaited<ReturnType<typeof readRunRecommendationOfferedSet>> = [];
  try {
    await writeRunRecommendationOfferedSet({
      runId,
      holdId: park.id,
      offered: recs.map((r) => ({
        skillId: r.skillId,
        skillRevisionId: r.skillRevisionId,
        recommended: r.recommended,
        rank: r.rank,
      })),
    });
    offered = await readRunRecommendationOfferedSet(park.id);
  } catch (err) {
    console.warn(
      "[resolveRecommendationHoldStateForActor] offered-set claim failed for run",
      runId,
      "— the card still draws:",
      err instanceof Error ? err.message : String(err),
    );
    offered = [];
  }

  // The chips: the CLAIMED offer's decisive fields, this reader's presentation,
  // in the order the offer was drawn. An offered id this reader cannot see is
  // not drawn for them; a live candidate this hold never offered is not drawn at
  // all, because the hold's offer is settled. With no claim to read, the live
  // scoring is the row, exactly as before #2906.
  const presentation = new Map(recs.map((r) => [r.skillId, r] as const));
  const chips =
    offered.length > 0
      ? offered.flatMap((o) => {
          const live = presentation.get(o.skillId);
          if (!live) return [];
          return [
            {
              skillId: o.skillId,
              skillRevisionId: o.skillRevisionId,
              name: live.displayName,
              vendorName: live.vendorName,
              score: live.score,
              rank: o.rank,
              recommended: o.recommended,
              scoredFeatures: live.scoredFeatures,
            },
          ];
        })
      : recs.map((r) => ({
          skillId: r.skillId,
          skillRevisionId: r.skillRevisionId,
          name: r.displayName,
          vendorName: r.vendorName,
          score: r.score,
          rank: r.rank,
          recommended: r.recommended,
          scoredFeatures: r.scoredFeatures,
        }));

  return {
    state: "held",
    agentPackageName: packageName,
    promptText,
    canDecide: await readerMayDecide(run, who),
    holdRef: encodeRecommendationHoldRef({ runId, holdId: park.id }) ?? "",
    recommendations: chips,
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
 *
 * WHAT IT DOES NOT GUARANTEE, stated plainly: it is a read-and-compare, not an
 * atomic claim, so two decisions racing on the SAME live hold both write their
 * decision. What IS exactly-once is the DISPATCH — the park sweep is a
 * `status='parked'` conditional update, so only one of them transitions the park
 * and only one run is dispatched.
 *
 * The SHAPE that race leaves behind, named so the disclosure is not merely
 * implied: a Confirm and a Skip racing the same live hold write into two
 * different tables — the authoritative per-run selection rows, and the skip
 * record with its `user_skipped` rejected rows. Both survive. The SURFACE stays
 * single-valued and deterministic (the state resolver reads selections first and
 * answers `confirmed`, so the settled card never shows two decisions), and the
 * RUN is single-valued too (it executes the confirmed selection). What carries
 * both is the recommendation-efficacy telemetry, which then counts one run as
 * accepted and skipped. That is the residual: a double-counted telemetry row,
 * not a contradictory run and not a contradictory card. Removing it means
 * claiming the park before writing, which trades this race for a worse one (a
 * claimed park whose decision write then fails leaves an un-dispatched run with
 * no live hold and no row to decide) — so it belongs with the park store's own
 * transaction, not here.
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
    // The hold the CAS just bound this decision to — see `holdId` on the type.
    holdId: bound.holdId,
    ...(input.promptText !== undefined ? { promptText: input.promptText } : {}),
    ...(input.declaredProducedTypes ? { declaredProducedTypes: input.declaredProducedTypes } : {}),
    ...(input.targetArtifactKind ? { targetArtifactKind: input.targetArtifactKind } : {}),
    ...(input.forcedRevisions ? { forcedRevisions: input.forcedRevisions } : {}),
    ...(input.adjustedSkillIds ? { adjustedSkillIds: input.adjustedSkillIds } : {}),
  });
  if (!written.ok) {
    // A REFUSED WRITE KEEPS THE HOLD. Nothing is released and nothing is
    // dispatched, so the card stays decidable with its controls operable — which
    // is what makes a stale-offer refusal something the reader can act on rather
    // than a dead end. The write's own sentence is preferred where it has one
    // (cinatra#2906); everything else keeps the enumeration-proof generic line.
    return {
      ok: false,
      error: written.refusal ?? RECOMMENDATION_DECISION_REFUSAL,
      ...(written.refusalCode ? { code: written.refusalCode } : {}),
    };
  }

  return releaseAndDispatch(input.runId, bound.holdId, input.holdRef !== undefined, input.dispatch);
}

/**
 * SKIP for one verified reader: persist durable skip evidence — the RUN-LEVEL
 * skip record plus one `user_skipped` rejected row per candidate the row
 * actually offered — write NO selection row (the run falls back to the computed
 * default set), then release the hold and dispatch.
 *
 * BOTH ENTRIES REACH THIS. The rules below are therefore the widget's rules too:
 * the broker entry does not get a laxer skip than the cookie entry, because
 * there is only one skip.
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

  // OWNERSHIP, FAIL-CLOSED (cinatra#2794). Skip is a `runBy`-owner decision, so
  // the run must NAME this caller as its owner — an unowned run is refused, not
  // admitted.
  //
  // This deliberately does NOT copy `triggerAgentRun`'s `run.runBy && run.runBy
  // !== userId`, which admits a null owner. That form reads as "nobody claimed
  // it, so anybody may", and on THIS path a null owner is reachable: the chat
  // dispatch boundary stamps the launch origin as a constant while carrying a
  // user id only for a human principal (`chatActorToPrimitive` in
  // `src/app/api/chat/explicit-dispatch-server.ts`), so a non-human principal
  // reaching the pre-router creates a chat-origin run with no `runBy` — and the
  // recommendation hold still fires on it. Fail-open there would let any
  // authenticated caller release and dispatch that run.
  //
  // Skip being stricter than the dispatch it precedes is the intended
  // direction: the tighter gate is the one that decides, and `triggerAgentRun`
  // re-checks afterwards. Confirm is unaffected — it carries its own
  // execute-tier authorization inside the selection write the entry hands in.
  if (!run.runBy || run.runBy !== userId) {
    return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };
  }

  // DURABLE SKIP EVIDENCE, AND IT IS NOT BEST-EFFORT (cinatra#2794).
  //
  // This evidence IS the card's settled state: the state resolver above reads it
  // back to answer `skipped`, and with no evidence it answers `none` and the card
  // disappears from the conversation instead of settling. So a failed write may
  // NOT fall through to the release: releasing a run while losing the record of
  // the decision is precisely the outcome that made Skip vanish.
  //
  // The evidence has TWO HALVES, and only one of them can be empty.
  //
  // The PER-SKILL half covers every candidate the row offered, not only the
  // scorer-recommended ones. The hold fires whenever there is any candidate at
  // all, so a row can be — and in practice often is — made entirely of FORCED
  // candidates; writing evidence only for recommended ones left those skips
  // unrecorded. A forced candidate is written with a NULL rank, which is what
  // keeps "offered but not recommended" distinguishable from "recommended at
  // rank n" in the same table. This half is empty whenever drift retired the
  // offered set, and that is allowed.
  //
  // The RUN-LEVEL half is the marker, and it is never empty on a successful
  // skip. Every successful skip therefore leaves a durable marker — there is no
  // releasing path through here that records nothing. The only non-recording
  // ending is a REFUSAL, which keeps the hold and leaves the card decidable.
  //
  // A READ FAILURE IS A FAILURE, NOT AN ANSWER. The template read is INSIDE the
  // try and carries no `.catch(() => null)`: swallowing it would turn "the
  // database did not answer" into "this run has no package", walk past the
  // evidence write, and release — the same lost decision a failed write
  // produces, arriving by a quieter route. A template that genuinely reads back
  // WITHOUT a package name is a different fact: it simply leaves the per-skill
  // half empty, and the run-level marker still records the decision.
  try {
    const template = await readAgentTemplateById(run.templateId);
    const packageName = template?.packageName;
    let rejectedRows: Array<{
      skillId: string;
      skillRevisionId: string | null;
      recommendationSource: string;
      recommendedRank: number | null;
    }> = [];
    if (packageName) {
      // The evidence must name the SAME candidates the row offered
      // (cinatra#2148 finding 1) — resolved through the shared run-actor seam.
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
      // PER-SKILL EFFICACY ROWS COME FROM THE EXACT SCORED RESULT, AND ONLY IT.
      //
      // Every row written here is read back as "this skill was OFFERED to a
      // human and not kept", so it may only name a skill the row actually
      // offered. `recommendations` is that set by construction: candidate
      // generation intersects the assigned ids with the INSTALLED catalog and
      // caps the result at `DEFAULT_MAX_CANDIDATES` (`recommend.server.ts`), so
      // the scored result is the offered set and the assigned set is merely its
      // superset.
      //
      // There used to be a fallback here that wrote every ASSIGNED id when the
      // scorer came back empty. It recorded rejections for skills that were
      // never offered — uninstalled ones the intersection had dropped, and
      // everything past the cap on an agent assigned more than fifty — which is
      // efficacy telemetry stating something that did not happen. Drift is real,
      // but the answer to "the offered set is gone" is the RUN-LEVEL marker
      // below, not a guess at what was on the row.
      rejectedRows = recommendations.map((r) => ({
        skillId: r.skillId,
        skillRevisionId: r.skillRevisionId,
        recommendationSource: SKIP_RECOMMENDATION_SOURCE,
        // NULL for a forced candidate: it was offered, never ranked.
        recommendedRank: r.recommended ? r.rank : null,
      }));
    }

    // ONE DURABLE WRITE, AND IT IS VERIFIED BEFORE ANYTHING IS RELEASED.
    //
    // BOTH HALVES RIDE ONE TRANSACTION. They used to be two sequential
    // autocommitted writes, rows first: a marker that failed after the rows
    // committed refused the skip and left the park LIVE, while
    // `hasRunRecommendationSkip` answered `skipped` off those orphaned
    // `user_skipped` rows and settled the card for the decision this call had
    // just refused. Nothing distinguishes such a row from a legitimate legacy
    // one, so the reader cannot be taught to ignore it — the write is what has
    // to be atomic. A refusal below can therefore no longer leave a HALF: the
    // ordinary failure rolls both halves back, and the sync bridge's ambiguous
    // ending (a COMMIT whose result was lost) leaves BOTH, which is a decision
    // fully on record that the retry converges on.
    //
    // `writeRunRecommendationSkip` READS THE MARKER BACK and returns whether it
    // is durably there. A write that quietly did nothing is therefore not
    // mistaken for a decision on record: the release below is gated on the
    // verified fact, not on the absence of an exception.
    // AN ALL-CLEAR ROW IS A SKIP, AND IT MUST READ BACK AS ONE (cinatra#3047,
    // review point 2). With checkboxes there is no skip ACTION: clearing every
    // box and pressing Continue is what skips, and on a run whose Skills step was
    // already decided that means selection rows from the earlier answer are on
    // file. Left there, the resolver's selection-first ladder would read the run
    // back as CONFIRMED while every box on the reader's screen was clear.
    //
    // THE SCOPE IS THE HOLD'S OWN OFFER, NOT THE FRESH SCORING (convergence
    // finding 4). `rejectedRows` is derived from a scoring taken NOW, and a skill
    // that was selected earlier can be absent from it — unassigned since,
    // uninstalled, or displaced past the candidate cap. Clearing only what the
    // new scoring returned would leave exactly that skill selected, and the
    // reader would see an all-clear row read back as confirmed. The claimed
    // offer is the durable record of what this hold asked about, so it is what
    // the clear is bounded by; the scored ids are unioned in so a hold with no
    // readable claim still clears what it can.
    //
    // The store's own guard is the other half: the DELETE tests the run's status
    // in the statement, so a started run's materialized ledger is untouched
    // whatever this call asks for.
    const clearedSkillIds = new Set(rejectedRows.map((r) => r.skillId));
    if (bound.holdId) {
      try {
        for (const offer of await readRunRecommendationOfferedSet(bound.holdId)) {
          clearedSkillIds.add(offer.skillId);
        }
      } catch {
        /* an unreadable claim costs SCOPE, never the skip — the scored ids stand */
      }
    }
    clearRunSelectedSkillRevisionsBeforeStart({
      runId: input.runId,
      skillIds: [...clearedSkillIds],
    });

    const recorded = writeRunRecommendationSkip({
      runId: input.runId,
      skippedBy: userId,
      candidateCount: rejectedRows.length,
      rejected: rejectedRows,
    });
    if (!recorded) {
      console.error(
        "[skipRecommendationForActor] skip marker did not read back for run",
        input.runId,
        "— refusing to release",
      );
      return {
        ok: false,
        error: RECOMMENDATION_SKIP_NOT_RECORDED,
        code: RECOMMENDATION_SKIP_NOT_RECORDED_CODE,
      };
    }
  } catch (err) {
    // A FAILED WRITE is fatal to the decision. The run id is request-controlled,
    // so it is passed as a discrete argument and never interpolated into the
    // format string (CodeQL js/tainted-format-string).
    console.error(
      "[skipRecommendationForActor] skip-evidence write failed for run",
      input.runId,
      "— refusing to release:",
      err instanceof Error ? err.message : String(err),
    );
    // The TYPED outcome rides alongside the prose. A caller that offers a retry
    // branches on the code; the message is what a person reads.
    return {
      ok: false,
      error: RECOMMENDATION_SKIP_NOT_RECORDED,
      code: RECOMMENDATION_SKIP_NOT_RECORDED_CODE,
    };
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
  /**
   * The reader-facing sentence for a refusal that describes the CALLER'S OWN
   * next step (cinatra#2906: the offer the card made can no longer be honoured).
   * Absent for an authorization denial, which keeps the generic refusal.
   */
  refusal?: string;
  /** The typed outcome that rides alongside `refusal`. */
  refusalCode?: string;
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
  /** The hold the decision was bound to — see `RecommendationSelectionWrite`. */
  holdId?: string | null;
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
      // THE HOLD WHOSE OFFER THIS CONFIRM MUST HONOUR (cinatra#2906) — the one
      // the caller's hold-instance CAS already validated, never a fresh read of
      // the run's current park. A run can be released and parked AGAIN between
      // the binding and this write, and a re-read would then resolve the
      // decision against a different hold's offer. A caller that binds no hold
      // passes none, which is the no-offer case the confirm already handles.
      holdId: input.holdId ?? null,
      forcedRevisions,
      adjustedSkillIds,
      restrictToSkillIds: assignedIds,
    });
    if (!result.ok) {
      // NOTHING WAS WRITTEN — the confirm refused before its first statement.
      // The refusal travels with its own sentence so the row can draw a reason
      // the reader can act on instead of the generic denial, and the two reasons
      // stay distinguishable: an offer that no longer holds asks the reader to
      // change their selection, one that could not be READ asks them to retry.
      // THREE REASONS NOW, AND THEY STAY DISTINGUISHABLE (cinatra#3047). An
      // offer that no longer holds asks the reader to change their selection;
      // one that could not be READ asks them to retry; and a run that has
      // already started tells them the selection is settled, because no retry
      // will make that write land.
      if (result.refusal.reason === "run_already_started") {
        return {
          ...empty,
          refusal: RECOMMENDATION_RUN_STARTED_REFUSAL,
          refusalCode: RECOMMENDATION_RUN_STARTED_CODE,
        };
      }
      const unreadable = result.refusal.reason === "offered_set_unreadable";
      return {
        ...empty,
        refusal: unreadable
          ? RECOMMENDATION_OFFER_UNREADABLE_REFUSAL
          : RECOMMENDATION_OFFER_STALE_REFUSAL,
        refusalCode: unreadable
          ? RECOMMENDATION_OFFER_UNREADABLE_CODE
          : RECOMMENDATION_OFFER_STALE_CODE,
      };
    }
    return { ok: true, written: result.written, efficacy: result.efficacy };
  } catch {
    return empty;
  }
}

