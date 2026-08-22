"use server";

// ---------------------------------------------------------------------------
// Run-start recommendation chip-row DECISION actions (cinatra#2067, epic #2037
// C3). The three affordances the shared chip-row surfaces — CONFIRM (keep the
// recommended set), ADJUST (confirm a different set — same action, different
// ids) and SKIP (proceed with the computed default) — each write their durable
// decision AND release the run-start hold so the parked run dispatches.
//
// These are the ONLY callers that release a recommendation park + dispatch a
// held run. Both:
//   1. write the decision (confirm → the authoritative per-run selection via the
//      existing execute-tier-authorized `confirmRunSkillSelectionAction`; skip →
//      durable `user_skipped` evidence);
//   2. release the run-start recommendation park (the S0 sweeper);
//   3. dispatch the run through the canonical `triggerAgentRun` — which, seeing
//      the park now RELEASED (not parked) and a decision on record, re-holds
//      nothing and performs the normal pending_input→queued transition + enqueue
//      (connector/LLM preflight included).
//
// NOTE: this is NOT a review-gate decision. The chip-row's confirm/adjust/skip
// are skill-selection affordances, categorically distinct from the review
// decision floor (Approve/Reject/Comment) — no fourth floor affordance is added
// anywhere (issue #2067 AC-8).
// ---------------------------------------------------------------------------

import { requireActorContext, requireAuthSession } from "@/lib/auth-session";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  enforceRunAccess,
  resolveEffectivePolicy,
  type ActorRoleHints,
} from "./auth-policy";
import { actorFromSession } from "@/lib/authz/build-actor-context";

import {
  writeRunRecommendationSkip,
  SKIP_RECOMMENDATION_SOURCE,
} from "@/lib/run-selected-skill-revisions";

import {
  readRunSelectedSkillRevisions,
  readRunRejectedRecommendations,
  hasRunRecommendationSkip,
  decidedSkillsFromEvidence,
  type RunRecommendationDecidedSkill,
  type RunRejectedRecommendation,
  type RunSelectedSkillRevision,
} from "@/lib/run-selected-skill-revisions";

import { readAgentRunById, readAgentTemplateById, readRunCoOwners } from "./store";
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
  RECOMMENDATION_SKIP_NOT_RECORDED,
  RECOMMENDATION_SKIP_NOT_RECORDED_CODE,
} from "./recommendation-hold";
import { triggerAgentRun } from "./run-actions";
import { confirmRunSkillSelectionAction } from "./server-actions";
import type { RecommendedSkillForChip } from "./server-actions";

export type RunRecommendationDecisionResult =
  | { ok: true; dispatched: boolean }
  | { ok: false; error: string; code?: string; settingsHref?: string };


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
       * against — see `assertDecisionMatchesLiveHold`. Empty when no ref can be
       * minted (no app secret): the decision then falls back to the pre-#2568
       * run-scoped behaviour rather than becoming un-decidable.
       */
      holdRef: string;
      /**
       * Whether THIS reader may shape the run — §V's read-only reading, which
       * draws every chip with its three affordances DISABLED and the reason
       * under the row.
       *
       * PRESENTATION ONLY, and deliberately so. The decision actions each
       * re-authorize from the session on their own (`confirmRunSkillSelection‑
       * Action` enforces execute tier; the skip path enforces the run's trigger
       * ownership) and neither reads this flag, so it can neither grant nor
       * remove any authority. It is therefore derived FAIL-OPEN: a derivation
       * that cannot answer says `true`, because withholding the affordances from
       * a reader who may in fact decide would be a regression on the shipped
       * card, while showing them to a reader who may not costs one honest
       * refusal line — exactly what ships today.
       */
      canDecide: boolean;
    }
  | {
      state: "confirmed";
      skillNames: string[];
      decided: RunRecommendationDecidedSkill[];
    }
  | { state: "skipped"; decided: RunRecommendationDecidedSkill[] };


/**
 * Can this session DECIDE this run's recommendation? The same execute-tier gate
 * `confirmRunSkillSelectionAction` enforces before it writes, read here so the
 * card can draw §V's read-only chips instead of offering a press that would only
 * ever be refused. FAIL-OPEN by contract — see `canDecide` above.
 */
async function readerMayDecide(
  run: Awaited<ReturnType<typeof readAgentRunById>>,
  session: Parameters<typeof actorFromSession>[0] | null,
  roleHints: ActorRoleHints,
): Promise<boolean> {
  if (!run || !session) return true;
  try {
    const runTemplate = await readAgentTemplateById(run.templateId).catch(() => null);
    const coOwnerUserIds = (await readRunCoOwners(run.id).catch(() => [])).map((r) => r.userId);
    await enforceRunAccess(
      { ...run, effectivePolicy: resolveEffectivePolicy(run, runTemplate), coOwnerUserIds },
      actorFromSession(session),
      "execute",
      roleHints,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * DISPLAY NAMES FOR THE SETTLED READING (cinatra#2841).
 *
 * §V's chips print a skill's NAME — held and settled alike ("Enrich contacts",
 * never `@vendor/pkg:enrich`, and never the slug `enrich-contacts`). The run's
 * durable evidence carries ids only, so the settled row joins the names in
 * HERE, the same way the held branch below gets them: through the shared
 * run-actor candidate seam and the scorer, whose `displayName` is the owning
 * extension's manifest title resolved once server-side
 * (`buildRecommendationCandidatesForAgent`). Reading THAT field rather than
 * the catalog `name` is what keeps the settled row and the held row identical:
 * both take the same resolved label from the same call.
 *
 * NOT VIEWER-INTERSECTED, deliberately and consistently with the branch that
 * calls it: the decided summary is the set THIS run resolved, which the run's
 * own Skills tab already lists to every reader who clears the same run-read
 * door. Only the LIVE candidate row is intersected.
 *
 * BEST-EFFORT BY CONTRACT. A failure costs labels, never the card: every id with
 * no resolved name keeps the id as its label, which is exactly what the settled
 * row printed before this join existed.
 */
async function resolveDecidedSkillNames(
  run: NonNullable<Awaited<ReturnType<typeof readAgentRunById>>>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const template = await readAgentTemplateById(run.templateId).catch(() => null);
    const packageName = template?.packageName;
    if (!packageName) return names;
    const candidateSkillIds = await resolveRecommendationCandidateSkillIds({
      run,
      packageName,
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
 * The run-start recommendation hold state for the chat-mounted run panel
 * (cinatra#2067 item 5 — the SAME shared chip-row serves chat). Returns:
 *   held      → the interactive chip-row (prefetched candidates);
 *   confirmed → the read-only confirmed summary;
 *   skipped   → the read-only skipped summary;
 *   none      → no row (headless / policy-skipped / empty-candidate / no run).
 *
 * AUTHORIZATION (cinatra#2148): the run is loaded THROUGH the access door —
 * `readAgentRunById(runId, actor, roleHints)` runs
 * `enforceRunAccess(..., "read", ...)` and throws for a run this session may not
 * see. The bare `readAgentRunById(runId)` this used before SKIPPED that gate, so
 * any authenticated caller holding a run id could read the row; with the
 * candidate set now actor-scoped that would have leaked the run owner's scoped
 * skill NAMES. The park read is likewise moved BEHIND the door so an
 * unauthorized caller cannot even probe a run's hold state. The role HINTS ride
 * along (mirroring `confirmRunSkillSelectionAction`) so the door neither
 * over-admits nor falsely denies a platform-admin / org-admin / policy-authorized
 * same-org reader.
 */
export async function getRunRecommendationHoldStateAction(input: {
  runId: string;
}): Promise<RunRecommendationHoldState> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { state: "none" };
  if (!input.runId) return { state: "none" };

  // The viewer's kernel context serves BOTH the access door's role hints and the
  // presentation intersection below. FAIL-CLOSED: unresolvable ⇒ no row.
  const viewer = await requireActorContext().catch(() => null);
  if (!viewer) return { state: "none" };
  const roleHints: ActorRoleHints = {
    ...(viewer.platformRole ? { platformRole: viewer.platformRole } : {}),
    ...(viewer.orgRole ? { orgRole: viewer.orgRole } : {}),
    ...(viewer.teamRoles ? { teamRoles: viewer.teamRoles } : {}),
    ...(viewer.teamIds ? { teamIds: viewer.teamIds } : {}),
    ...(viewer.projectGrants ? { projectGrants: viewer.projectGrants } : {}),
    actorOrganizationId: viewer.organizationId ?? null,
  };

  // Access door FIRST — every branch below is behind it.
  const doorActor: PrimitiveActorContext = { actorType: "human", source: "ui", userId };
  const run = await readAgentRunById(input.runId, doorActor, roleHints).catch(() => null);
  if (!run) return { state: "none" };

  const park = await readRecommendationParkForRun(input.runId).catch(() => null);
  if (!park) return { state: "none" };

  if (park.status !== "parked") {
    // DECIDED summary. Deliberately NOT viewer-filtered: these are the skills
    // THIS run resolved, and the run's own Skills tab
    // (`/agents/.../[instanceId]/skills`) already lists exactly this joined set
    // to every viewer who clears the same run-read door. Filtering only here
    // would hide legitimately run-scoped information while changing no
    // disclosure boundary. The LIVE candidate row below is the surface this
    // change actually widens, and that one IS intersected.
    const selected = readRunSelectedSkillRevisions(input.runId);
    // §V's settled row states each skill's OWN outcome, so the rejected half of
    // the same evidence is read beside the accepted half. Best-effort: a store
    // that cannot answer costs the per-chip marks, never the settled card.
    let rejected: RunRejectedRecommendation[] = [];
    try {
      rejected = readRunRejectedRecommendations(input.runId);
    } catch {
      rejected = [];
    }
    // §V's settled chips print the SAME display name the held chips print, so
    // the ids the evidence carries are joined to names before the row is built.
    const nameBySkillId = await resolveDecidedSkillNames(run);
    const decided = decidedSkillsFromEvidence(selected, rejected, nameBySkillId);
    if (selected.length > 0) {
      return {
        state: "confirmed",
        // The field is `skillNames`, and now it truthfully holds names — the id
        // survives only as the fallback for a skill nothing could name.
        skillNames: selected.map((s) => nameBySkillId.get(s.skillId) ?? s.skillId),
        decided,
      };
    }
    if (hasRunRecommendationSkip(input.runId)) return { state: "skipped", decided };
    return { state: "none" };
  }

  const template = await readAgentTemplateById(run.templateId).catch(() => null);
  const packageName = template?.packageName;
  if (!packageName) return { state: "none" };

  // Same run-actor-scoped candidate seam the hold decision used (cinatra#2148
  // finding 1) — the row must SHOW exactly the candidate set that made it fire,
  // org/workspace assignments included — INTERSECTED with this viewer's own
  // entitlement so a non-owner reader never learns the owner's scoped skill
  // names and every offered chip is one this caller's confirm can write.
  const assignedSkillIds = await resolveRecommendationCandidateSkillIds({
    run,
    packageName,
    viewer: {
      principalId: viewer.principalId,
      teamIds: viewer.teamIds ?? [],
      projectIds: viewer.projectIds ?? [],
      organizationId: viewer.organizationId ?? undefined,
    },
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
    canDecide: await readerMayDecide(run, session, roleHints),
    holdRef: encodeRecommendationHoldRef({ runId: input.runId, holdId: park.id }) ?? "",
    recommendations: recs.map((r) => ({
      skillId: r.skillId,
      skillRevisionId: r.skillRevisionId,
      // The RESOLVED display label — the same field `resolveDecidedSkillNames`
      // reads, so the held row and the settled row cannot label a skill
      // differently.
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
 * WHAT IT GUARANTEES: a decision taken against hold H is applied to hold H or to
 * nothing. Without it these actions were only run-scoped — a decision submitted
 * after the run had been dispatched and PARKED AGAIN as H' would write its
 * selection (or its skip evidence) and then release H', applying a choice the
 * human made for a different candidate set. A stale tab, a slow network or a
 * double-decided run is enough. The check therefore runs FIRST, so a decision
 * aimed at a hold the run has moved past leaves no trace on the run at all.
 *
 * WHAT IT DOES NOT GUARANTEE, stated plainly: it is a read-and-compare, not an
 * atomic claim, so two decisions racing on the SAME live hold both write their
 * decision — exactly as they did before this slice. What IS exactly-once is the
 * DISPATCH: the park sweep is a `status='parked'` conditional update, so only
 * one of them transitions the park and only one run is dispatched. Making the
 * write itself exclusive means claiming the park before writing, which trades
 * this race for a worse one (a claimed park whose decision write then fails
 * leaves an un-dispatched run with no live hold and no row to decide) — so it
 * belongs with the park store's own transaction, not here.
 *
 * The SHAPE that race leaves behind, named so the disclosure is not merely
 * implied: a Confirm and a Skip racing the same live hold write into two
 * different tables — the authoritative per-run selection rows, and
 * `user_skipped` rejected rows. Both survive. The SURFACE stays single-valued
 * and deterministic (`getRunRecommendationHoldStateAction` reads selections
 * first and answers `confirmed`, so the settled card never shows two
 * decisions), and the RUN is single-valued too (it executes the confirmed
 * selection). What carries both is the recommendation-efficacy telemetry, which
 * then counts one run as accepted and skipped. That is the residual: a
 * double-counted telemetry row, not a contradictory run and not a contradictory
 * card. Removing it means the atomic claim above, at the price named above.
 *
 * IDEMPOTENT RETRY IS NOT A STALE DECISION. A decision whose response was lost
 * and is retried names a hold that is now RELEASED — and that is still THIS
 * run's hold, so it is accepted and the downstream path is idempotent (the
 * release is a no-op, the dispatch is guarded by the run's own status). Only a
 * decision naming a hold that is not the run's current park at all is refused.
 *
 * The refusal is the same generic one an unauthorized caller gets, so "your
 * hold is stale" and "you may not decide this run" are indistinguishable.
 *
 * FAIL-CLOSED for a named decision: an unreadable park refuses. A caller that
 * names NO hold keeps the pre-#2568 run-scoped behaviour, because a deployment
 * that cannot mint refs (no app secret) must still be able to decide its runs.
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
    // Deliberately NOT `park.status === "parked"`: the run's current park being
    // the claimed hold is the binding. A released one means "already decided",
    // which is a RETRY, not a stale decision.
    park.id === claimed.holdId;
  return matches ? { ok: true, holdId: claimed!.holdId } : { ok: false };
}

/**
 * CONFIRM / ADJUST: persist the human's confirmed selection set (execute-tier
 * authorized by `confirmRunSkillSelectionAction`), then release the run-start
 * hold and dispatch. `confirmedSkillIds` is the FULL kept set — a plain confirm
 * keeps the recommended ids; an "adjust" passes the edited set (a removed skill
 * is absent; an added non-recommended skill rides `forcedRevisions`).
 */
export async function confirmRunRecommendationAction(input: {
  runId: string;
  agentPackageName: string;
  confirmedSkillIds: string[];
  promptText?: string;
  declaredProducedTypes?: string[];
  targetArtifactKind?: string;
  forcedRevisions?: Record<string, string>;
  /**
   * The kept skills the reader settled through the chip's ADJUST panel
   * (cinatra#2841). Written as `user_adjusted` selection rows, so §V's third
   * settled mark is reachable for a skill that IS in the scored set — which is
   * every skill the row offers.
   */
  adjustedSkillIds?: string[];
  /** The hold this decision was taken against (cinatra#2568) — see the CAS below. */
  holdRef?: string;
}): Promise<RunRecommendationDecisionResult> {
  const session = await requireAuthSession().catch(() => null);
  if (!session?.user?.id) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };
  if (!input.runId) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  // 0. The hold-instance CAS — BEFORE any write. A decision aimed at a hold the
  //    run has moved past must not mutate the run's selection on its way to
  //    being refused.
  const bound = await resolveDecisionHold(input.runId, input.holdRef);
  if (!bound.ok) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  // 1. Write the authoritative per-run selection (does its own execute-tier
  //    run authorization + assigned-set bounding).
  const written = await confirmRunSkillSelectionAction({
    runId: input.runId,
    agentPackageName: input.agentPackageName,
    confirmedSkillIds: input.confirmedSkillIds,
    promptText: input.promptText,
    declaredProducedTypes: input.declaredProducedTypes,
    targetArtifactKind: input.targetArtifactKind,
    forcedRevisions: input.forcedRevisions,
    adjustedSkillIds: input.adjustedSkillIds,
  });
  if (!written.ok) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  // 2 + 3. Release the hold and dispatch — bound to the hold resolved above.
  return releaseAndDispatch(input.runId, bound.holdId, input.holdRef !== undefined);
}

/**
 * SKIP: persist durable skip evidence — the RUN-LEVEL skip record (the marker
 * the settled card reads, keyed by run_id and VERIFIED before any release) plus
 * one `user_skipped` rejected row per candidate the row actually offered — write
 * NO selection row (the run falls back to the computed default set), then
 * release the hold and dispatch.
 */
export async function skipRunRecommendationAction(input: {
  runId: string;
  /** The hold this decision was taken against (cinatra#2568) — see the CAS below. */
  holdRef?: string;
}): Promise<RunRecommendationDecisionResult> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };
  if (!input.runId) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  // The hold-instance CAS runs BEFORE the durable skip evidence is written —
  // a stale decision must leave no trace on the run it was not aimed at.
  const bound = await resolveDecisionHold(input.runId, input.holdRef);
  if (!bound.ok) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  const run = await readAgentRunById(input.runId).catch(() => null);
  if (!run) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  // OWNERSHIP, FAIL-CLOSED. Skip is a `runBy`-owner decision, so the run must
  // NAME this session as its owner — an unowned run is refused, not admitted.
  //
  // This deliberately does NOT copy `triggerAgentRun`'s `run.runBy && run.runBy
  // !== userId`, which admits a null owner. That form reads as "nobody claimed
  // it, so anybody may", and on THIS path a null owner is reachable: the chat
  // dispatch boundary stamps the launch origin as a constant while carrying a
  // user id only for a human principal (`chatActorToPrimitive` in
  // `src/app/api/chat/explicit-dispatch-server.ts`), so a non-human principal
  // reaching the pre-router creates a chat-origin run with no `runBy` — and the
  // recommendation hold still fires on it. Fail-open there would let any
  // authenticated session release and dispatch that run.
  //
  // Skip being stricter than the dispatch it precedes is the intended
  // direction: the tighter gate is the one that decides, and `triggerAgentRun`
  // re-checks afterwards. Confirm is unaffected — it carries its own
  // execute-tier authorization inside `confirmRunSkillSelectionAction`.
  if (!run.runBy || run.runBy !== userId) {
    return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };
  }

  // DURABLE SKIP EVIDENCE, AND IT IS NOT BEST-EFFORT.
  //
  // This evidence IS the card's settled state: `getRunRecommendationHoldStateAction`
  // reads it back to answer `skipped`, and with no evidence it answers `none` and
  // the card disappears from the conversation instead of settling. So a failed
  // write may NOT fall through to the release: releasing a run while losing the
  // record of the decision is precisely the outcome that made Skip vanish.
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
  // skip.
  //
  // EVERY SUCCESSFUL SKIP LEAVES A DURABLE MARKER — there is no releasing path
  // through here that records nothing. The marker is the RUN-LEVEL skip record
  // (`run_recommendation_skips`, keyed by run_id alone), written and VERIFIED
  // below on every branch; the per-skill efficacy rows are a separate, optional
  // accompaniment. The only non-recording ending is a REFUSAL, which keeps the
  // hold and leaves the card decidable.
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
      // The evidence must name the SAME candidates the row offered (cinatra#2148
      // finding 1) — resolved through the shared run-actor seam.
      const assignedSkillIds = await resolveRecommendationCandidateSkillIds({
        run,
        packageName,
      });
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
    // The MARKER is the record that makes the card settle: the state reader
    // answers `skipped` from it, and with no marker it answers `none` and the
    // card disappears from the conversation instead of settling. It is keyed by
    // the RUN, so it exists on every branch above — including the ones with no
    // candidate left to name.
    //
    // The per-skill half is OPTIONAL — it is empty whenever drift retired the
    // offered set, or the template reads back with no package name. Neither
    // makes the skip less of a decision, and neither is allowed to invent a
    // rejected skill.
    //
    // BOTH HALVES RIDE ONE TRANSACTION (round-8 finding 2). They used to be two
    // sequential autocommitted writes, rows first: a marker that failed after
    // the rows committed refused the skip and left the park LIVE, while
    // `hasRunRecommendationSkip` answered `skipped` off those orphaned
    // `user_skipped` rows and settled the card for the decision this action had
    // just refused. Nothing distinguishes such a row from a legitimate
    // pre-core__0095 one, so the reader cannot be taught to ignore it — the
    // write is what has to be atomic. A refusal below can therefore no longer
    // leave a HALF: the ordinary failure rolls both halves back, and the sync
    // bridge's ambiguous ending (a COMMIT whose result was lost) leaves BOTH,
    // which is a decision fully on record that the retry converges on. See the
    // store's own note for that boundary.
    //
    // `writeRunRecommendationSkip` READS THE MARKER BACK and returns whether it
    // is durably there. A write that quietly did nothing is therefore not
    // mistaken for a decision on record: the release below is gated on the
    // verified fact, not on the absence of an exception.
    const recorded = writeRunRecommendationSkip({
      runId: input.runId,
      skippedBy: userId,
      candidateCount: rejectedRows.length,
      rejected: rejectedRows,
    });
    if (!recorded) {
      console.error(
        "[skipRunRecommendationAction] skip marker did not read back for run",
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
    // A FAILED WRITE, on the other hand, is fatal to the decision. The run id is
    // request-controlled, so it is passed as a discrete argument and never
    // interpolated into the format string (CodeQL js/tainted-format-string).
    console.error(
      "[skipRunRecommendationAction] skip-evidence write failed for run",
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

  return releaseAndDispatch(input.runId, bound.holdId, input.holdRef !== undefined);
}

/**
 * Shared release + dispatch. Releases the run-start recommendation park (S0
 * sweeper) then dispatches through the canonical `triggerAgentRun` (ownership +
 * connector/LLM preflight + pending_input→queued CAS + enqueue). Because the
 * park is now RELEASED, `triggerAgentRun`'s hold re-check finds no live park and
 * `maybeHoldRunForRecommendation` sees a decided run — so the run dispatches
 * instead of re-holding.
 *
 * The release is VERIFIED before dispatching (cinatra#2148): a swallowed release
 * failure used to leave the park LIVE, which made `triggerAgentRun` return
 * `ok:true` off its live-park short-circuit — and this helper then reported
 * `dispatched: true` for a run that never moved. A still-live park is now an
 * explicit, retryable error instead of a false success. The verification read
 * FAILS CLOSED: an unreadable park is treated as still-held, because "I could
 * not confirm the release" must never become "dispatched".
 *
 * RESUME rides EXACTLY that verification (cinatra#2568). The typed hold
 * interrupt is only retired once the park is confirmed no longer live — never
 * optimistically on "the action was called", and never on the fail-closed
 * branches above. So the wire can under-report a hold's end (the next subscribe
 * re-derives from the park and finds it released) but can never claim a run was
 * freed while it is still waiting. Emitted BEFORE the dispatch attempt because
 * the hold is over either way: a preflight failure surfaces as its own
 * actionable error on a run that is genuinely no longer held.
 */
async function releaseAndDispatch(
  runId: string,
  /** The hold this decision resolved to (`resolveDecisionHold`), if any. */
  boundHoldId: string | null,
  /** Whether the caller NAMED that hold — only then is the release instance-bound. */
  holdNamed: boolean,
): Promise<RunRecommendationDecisionResult> {
  const HOLD_STILL_LIVE = {
    ok: false as const,
    error: "could not release the run-start recommendation hold — please retry",
  };

  // The release carries the CAS through: it sweeps the hold this decision was
  // bound to, or nothing. A concurrent release-and-repark between the check and
  // here therefore ends as an honest retryable error (the verification below
  // finds the NEW park still live) instead of releasing a hold nobody decided.
  await releaseRecommendationParkForRun(
    runId,
    holdNamed && boundHoldId ? boundHoldId : undefined,
  ).catch(() => false);
  let parkAfterRelease: Awaited<ReturnType<typeof readRecommendationParkForRun>>;
  try {
    parkAfterRelease = await readRecommendationParkForRun(runId);
  } catch {
    return HOLD_STILL_LIVE;
  }
  if (parkAfterRelease?.status === "parked") return HOLD_STILL_LIVE;

  const run = await readAgentRunById(runId).catch(() => null);
  if (!run) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };

  // The hold is verifiably over — retire it on the wire so every live surface
  // (this tab, another tab, an external AG-UI client) drops the card at the same
  // moment, instead of the losing tab sitting on a decided hold until its next
  // poll tick. BOUND to the hold instance that was actually released, so it can
  // never clear the card of a hold the run is waiting on now.
  //
  // Guarded here as well as inside the publisher: the decision's outcome is the
  // park release and the dispatch, and neither may be lost to a transport
  // failure on an announcement.
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

  // A held run is in one of the two PRE-DISPATCH waiting states; if it already
  // advanced past them (a concurrent decision won the dispatch race), report
  // success without re-dispatching.
  //
  // cinatra#2523: `pending_trigger` joined that set when setup stopped ending on
  // `completed`. Reading it as "already advanced" would report `ok:true,
  // dispatched:false` for a run that never moved — the exact false-success shape
  // the run-start hold's own verification (cinatra#2148) exists to prevent, and
  // the one this issue's ruling forbids.
  if (run.status !== "pending_input" && run.status !== "pending_trigger") {
    return { ok: true, dispatched: false };
  }

  const result = await triggerAgentRun({ runId, templateSlug: run.templateId });
  if (!result.ok) {
    return { ok: false, error: result.error, code: result.code, settingsHref: result.settingsHref };
  }
  return { ok: true, dispatched: true };
}
