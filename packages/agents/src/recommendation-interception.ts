/**
 * Run-start RECOMMENDATION interception orchestration (cinatra#2041, epic #2037
 * S3, Point R).
 *
 * The server-side seam that ties the policy lattice (recommendation checkpoint)
 * + the request-aware scorer + the immutable per-run selection store into the
 * three run-start motions:
 *
 *   - HEADLESS auto-apply (`autoApplyHeadlessRecommendation`): the
 *     execution-worker path. A worker run has no present human, so the lattice
 *     default (`humanPresent:false ⇒ skip`) means this is a NO-OP unless an org
 *     `required` bound fires the checkpoint; when it fires, the top
 *     recommendations are auto-applied immediately. A headless run NEVER parks
 *     (epic decision 6).
 *   - HUMAN confirm (`confirmRunSkillSelection`): the chip-row path. A present
 *     human confirms/adjusts the recommendation set; the confirmed pinned
 *     revisions are written with `recommended_confirmed`/`user_forced`, and the
 *     accepted/rejected split is returned for the efficacy surface (#1368).
 *   - Chip-row READ (`getRunRecommendations`): the scored set the chip-row +
 *     the MCP primitive both surface (one scoring implementation).
 *
 * Lives in `@cinatra-ai/agents` because it needs BOTH the org-policy store
 * (agents) and the request-aware scorer (skills) — the direction the skills⇄
 * agents seam already flows (agents depends on skills).
 */
import "server-only";

import {
  buildRecommendationCandidatesForAgent,
  recommendSkillsForAgentTask,
  type RecommendSkillsForAgentInput,
} from "@cinatra-ai/skills/recommendation-server";
import {
  decideRecommendationContinuation,
  deriveConfirmedSelection,
  deriveSelectionFromOfferedSet,
  summarizeRecommendationEfficacy,
  type OfferedSkill,
  type RankedRecommendation,
  type RecommendationEfficacy,
  type RunIntent,
  type RunSkillSelectionEntry,
} from "@cinatra-ai/skills/recommendation";
import { evaluatePolicy } from "@/lib/lifecycle/lifecycle-policy";
import type { CompiledManifestLifecycle } from "@/lib/lifecycle/lifecycle-policy";

import { resolveOrgPolicyRule, POLICY_ARTIFACT_TYPE_WILDCARD } from "./lifecycle-policy-store";
import {
  replaceRunSelectedSkillRevisionsBeforeStart,
  readRunRecommendationOfferedSet,
  writeRunSelectedSkillRevisions,
  writeRunRejectedRecommendations,
} from "@/lib/run-selected-skill-revisions";

/** Parse the compiled `agent_templates.lifecycle_config` JSON-as-text. Returns
 * null on absence / malformed JSON (never throws). */
export function parseLifecycleConfig(
  raw: string | null | undefined,
): CompiledManifestLifecycle | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as CompiledManifestLifecycle;
  } catch {
    // malformed compiled config — treat as absent.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chip-row / MCP read.
// ---------------------------------------------------------------------------

/** Score the agent's candidate skills against the run intent. The single scored
 * set the chip-row surfaces (and the MCP primitive returns). */
export async function getRunRecommendations(
  input: RecommendSkillsForAgentInput,
): Promise<RankedRecommendation[]> {
  return recommendSkillsForAgentTask(input);
}

// ---------------------------------------------------------------------------
// Headless auto-apply (execution-worker path).
// ---------------------------------------------------------------------------

export interface AutoApplyHeadlessInput {
  runId: string;
  orgId: string | null | undefined;
  agentId: string;
  intent: RunIntent;
  /** The compiled agent-manifest lifecycle declarations, if any. */
  manifest?: CompiledManifestLifecycle | null;
  /** Bound the candidate set to these skill ids — the agent's already-assigned,
   * runtime-deliverable skills. A headless auto-apply must never select a skill
   * the agent could not already deliver (an archived / excluded / unsynced skill
   * would fail delivery), so the execution worker passes the resolved assigned
   * set here and the selection is always a subset of it. */
  restrictToSkillIds?: string[];
  autoApplyLimit?: number;
}

export type AutoApplyHeadlessResult =
  | { mode: "skipped"; reason: string; written: 0 }
  | { mode: "auto_applied"; reason: string; written: number; selection: RunSkillSelectionEntry[] };

/**
 * Evaluate the recommendation checkpoint for a HEADLESS run and, if the lattice
 * fires it (org `required`), auto-apply the top recommendations into the
 * immutable per-run selection set. A no-op (no write) when the checkpoint does
 * not fire — so the run falls back to today's computed assignment, unchanged.
 * NEVER parks.
 *
 * Best-effort by contract: a recommendation write must never fail a run, so the
 * caller wraps this; here we only surface the outcome.
 */
export async function autoApplyHeadlessRecommendation(
  input: AutoApplyHeadlessInput,
): Promise<AutoApplyHeadlessResult> {
  // Resolve the org bound for the recommendation checkpoint. Without an orgId we
  // cannot resolve an org `required` bound, so the checkpoint stays silent →
  // headless default skip (unchanged behavior).
  const orgRule = input.orgId
    ? await resolveOrgPolicyRule(input.orgId, {
        checkpoint: "recommendation",
        // Recommendation is PRE-production: the produced type is not yet known,
        // so the org bound is resolved over the wildcard type (an org expresses
        // "require recommendation for all this agent's runs" via the `*` rule).
        artifactType: POLICY_ARTIFACT_TYPE_WILDCARD,
        destinationClass: "none",
        originKind: "agent_produced",
      })
    : { bound: "silent" as const };

  const decision = evaluatePolicy({
    checkpoint: "recommendation",
    artifactType: POLICY_ARTIFACT_TYPE_WILDCARD,
    destinationClass: "none",
    originKind: "agent_produced",
    humanPresent: false,
    orgRule,
    manifest: input.manifest ?? undefined,
  });

  if (!decision.fired) {
    return { mode: "skipped", reason: decision.reason, written: 0 };
  }

  const recommendations = await recommendSkillsForAgentTask({
    agentId: input.agentId,
    intent: input.intent,
    // Candidates are bound to the agent's deliverable assigned set (safety) —
    // the auto-applied selection is always a subset of what the agent could
    // already deliver.
    restrictToSkillIds: input.restrictToSkillIds,
  });
  const continuation = decideRecommendationContinuation({
    policyFired: true,
    humanPresent: false,
    recommendations,
    autoApplyLimit: input.autoApplyLimit,
  });

  // Human-present modes never reach a headless worker; the only firing outcome
  // here is auto_applied.
  if (continuation.mode !== "auto_applied") {
    return { mode: "skipped", reason: continuation.reason, written: 0 };
  }

  writeRunSelectedSkillRevisions({ runId: input.runId, selections: continuation.selection });
  return {
    mode: "auto_applied",
    reason: continuation.reason,
    written: continuation.selection.length,
    selection: continuation.selection,
  };
}

// ---------------------------------------------------------------------------
// Human confirm (chip-row path).
// ---------------------------------------------------------------------------

export interface ConfirmRunSkillSelectionInput {
  runId: string;
  agentId: string;
  intent: RunIntent;
  /** The skill ids the human kept from the recommendation chip-row. */
  confirmedSkillIds: string[];
  /**
   * THE HOLD THE CARD WAS DRAWN AGAINST (cinatra#2906). Its recorded offered set
   * is the authority for what this confirm may pin. Absent — a hold parked
   * before the offered set was recorded at all, or one whose draw could not
   * record it — the pre-#2906 path below still runs, so an in-flight hold stays
   * decidable across the upgrade instead of becoming permanently refusable.
   */
  holdId?: string | null;
  /**
   * Pinned revision for a forced (non-recommended) skill: skillId → revId.
   * Consulted ONLY on the no-offered-set path. With an offered set every pin
   * comes from what was drawn, so a client-supplied value can no longer decide
   * which revision a run executes.
   */
  forcedRevisions?: Record<string, string>;
  /**
   * Kept skills the reader settled through the chip's ADJUST panel
   * (cinatra#2841). An in-set one is written `user_adjusted` instead of
   * `recommended_confirmed`, which is what makes §V's `Adjusted` settled mark
   * reachable for the scored set the row offers.
   */
  adjustedSkillIds?: string[];
  /** The agent's currently-assigned deliverable skills, resolved by the caller
   *  with the reader's own scope. Half of the honourability test below. */
  restrictToSkillIds?: string[];
}

/** A kept skill the offer can no longer honour: unassigned, or uninstalled. */
export const OFFERED_SET_STALE_REASON = "offered_set_stale" as const;
/** The offer itself could not be read — an error, never "it offered nothing". */
export const OFFERED_SET_UNREADABLE_REASON = "offered_set_unreadable" as const;
/**
 * THE RUN HAS ALREADY STARTED (cinatra#3047, convergence finding 3). A decision
 * bound to a hold may be taken again while the run has not begun executing; once
 * it has, its selection set is the ledger execution materialized from and the
 * write is refused rather than partially applied. The refusal is the STORE'S
 * answer, taken inside the write's own transaction — not a status read this
 * module took a moment earlier and hoped was still true.
 */
export const RUN_ALREADY_STARTED_REASON = "run_already_started" as const;

export interface ConfirmRunSkillSelectionRefusal {
  reason:
    | typeof OFFERED_SET_STALE_REASON
    | typeof OFFERED_SET_UNREADABLE_REASON
    | typeof RUN_ALREADY_STARTED_REASON;
  /** The kept ids the offer can no longer honour. Empty when it could not be read. */
  staleSkillIds: string[];
}

export type ConfirmRunSkillSelectionResult =
  | {
      ok: true;
      written: number;
      selection: RunSkillSelectionEntry[];
      efficacy: RecommendationEfficacy;
    }
  | { ok: false; refusal: ConfirmRunSkillSelectionRefusal };

/**
 * Persist the REJECTED half of the efficacy split durably (the accepted half
 * rides `run_selected_skill_revisions`). ROUTED into S2 (cinatra#2040).
 *
 * Best-effort by contract — a telemetry write must never fail the confirm path.
 * It names skills out of the SAME set the split was measured against, so the two
 * halves can never describe different offers.
 */
function persistRejectedHalf(
  runId: string,
  measuredAgainst: ReadonlyArray<{
    skillId: string;
    skillRevisionId: string;
    recommended: boolean;
    rank: number;
  }>,
  efficacy: RecommendationEfficacy,
): void {
  const rejectedSet = new Set(efficacy.rejected);
  const rejectedRows = measuredAgainst
    .filter((r) => r.recommended && rejectedSet.has(r.skillId))
    .map((r) => ({
      skillId: r.skillId,
      skillRevisionId: r.skillRevisionId,
      recommendationSource: "recommended_not_kept",
      recommendedRank: r.rank,
    }));
  try {
    writeRunRejectedRecommendations({ runId, rejected: rejectedRows });
  } catch (err) {
    // The run id is a FORMAT ARGUMENT (`%s`), never spliced into the
    // format-string position — a tainted value there could be (mis)interpreted
    // by console.error's printf-style substitution (js/tainted-format-string).
    console.error(
      "[recommendation-interception] rejected-recommendation efficacy write failed for run=%s — continuing:",
      runId,
      err,
    );
  }
}

/**
 * Persist a human's confirmed/adjusted selection as the immutable per-run set,
 * and return the accepted/rejected efficacy split.
 *
 * WHAT IS ENFORCED (cinatra#2906) — stated as behaviour the code holds, not as
 * an assumption about how little time passed. The confirm resolves against the
 * OFFERED SET: the scored set recorded against this hold when the card was
 * drawn. It runs NO second scoring pass. Therefore:
 *
 *   · every kept skill is pinned to the revision the reader was SHOWN, whatever
 *     has been published since;
 *   · a kept skill that a confirm-time scoring would no longer return is still
 *     written at its offered revision, because no confirm-time scoring is
 *     consulted at all;
 *   · a kept skill the offer can no longer honour — no longer assigned to this
 *     agent, or no longer in the installed catalogue — REFUSES the whole confirm
 *     with a typed reason BEFORE anything is written. Never a silent
 *     substitution, never a silent drop, and never an empty set that delivery
 *     would read as "no set" and replace with the computed assignment;
 *   · the efficacy split and its durable rejected rows are measured against the
 *     claimed OFFER - the set this hold put to the run - so the tally states
 *     what was actually asked rather than what a later scoring would have.
 *
 * A hold that OWNS no offer keeps the pre-#2906 behaviour, so a hold already
 * parked when this shipped stays decidable. That is the ONLY fall-through: an
 * offer that exists but cannot be READ refuses instead, so a database that did
 * not answer is never mistaken for a hold that offered nothing.
 *
 * Writes idempotently (first write per (run, skill) wins) — and because the
 * offer is claimed once and never replaced, a retried confirm derives the same
 * rows from the same offer and converges on them, instead of accumulating a
 * mixed set across a live-state change.
 *
 * WHAT THIS DOES NOT CLOSE, stated plainly rather than left to be discovered.
 *
 * TWO DIFFERENT DECISIONS on one live hold still both write. The hold-instance
 * binding is a read-and-compare, not an atomic claim (see `resolveDecisionHold`),
 * so two readers keeping different subsets can still union in the run's rows.
 * That race predates this change and is unchanged by it; removing it means
 * claiming the park before writing, which belongs with the park store's own
 * transaction. What IS closed is the substitution: whichever of them writes,
 * every row it writes carries a revision that was actually on a card.
 *
 * "BEFORE ANY WRITE" MEANS THE DECISION, NOT A LOCK. The honourability probe
 * runs before the first statement, so a refusal leaves nothing behind. It does
 * not hold the assignment: a withdrawal landing between the probe and the insert
 * is not detected here, exactly as a withdrawal landing one moment after a
 * successful confirm is not. Delivery re-resolves the agent's assignment at
 * execution, which is where that window is answered.
 *
 * THE TALLY IS THE RUN'S, NOT ONE READER'S. Efficacy is measured against the
 * hold's claimed offer. Where two readers of different scope look at one hold,
 * the narrower one's card draws the intersection of the claim with what they may
 * see, while the tally still names the whole claim - so a skill outside their
 * scope can be recorded `recommended_not_kept` though their card did not print
 * it. That is telemetry about the RUN's offer; it changes nothing about what
 * executes, and the alternative - drawing the whole claim to every reader -
 * would leak the wider reader's scoped skill names.
 */
export async function confirmRunSkillSelection(
  input: ConfirmRunSkillSelectionInput,
): Promise<ConfirmRunSkillSelectionResult> {
  // A FAILED READ IS A FAILURE, NOT AN ANSWER. Swallowing it into an empty
  // result would turn "the database did not answer" into "this hold offered
  // nothing" and walk straight onto the compatibility path — re-scoring live
  // state for a card that DOES have a recorded offer, which is the exact defect
  // this closes, arriving by a quieter route. So an unreadable offer refuses,
  // writes nothing, and is retryable.
  let offered: OfferedSkill[] = [];
  if (input.holdId) {
    try {
      offered = await readRunRecommendationOfferedSet(input.holdId);
    } catch (err) {
      console.error(
        "[recommendation-interception] offered-set read failed for run=%s — refusing:",
        input.runId,
        err,
      );
      return {
        ok: false,
        refusal: { reason: OFFERED_SET_UNREADABLE_REASON, staleSkillIds: [] },
      };
    }
  }
  if (offered.length === 0) return confirmWithoutOfferedSet(input);

  // HONOURABILITY, WHICH IS NOT RE-SCORING. Candidate GENERATION answers the
  // only two questions a recorded pin can still fail on — is the skill still
  // assigned to this agent, and is it still in the installed catalogue — and
  // ranks nothing, so no confirm-time score can reach the written set. The probe
  // is bounded BY THE OFFER, so a skill can never read as "gone" merely because
  // newly-installed lower-sorting ids displaced it past the candidate cap.
  const assigned = input.restrictToSkillIds ? new Set(input.restrictToSkillIds) : null;
  const probeIds = offered
    .map((o) => o.skillId)
    .filter((skillId) => (assigned ? assigned.has(skillId) : true));
  let honourableSkillIds: string[] = [];
  if (probeIds.length > 0) {
    const candidates = await buildRecommendationCandidatesForAgent({
      agentId: input.agentId,
      intent: input.intent,
      restrictToSkillIds: probeIds,
      maxCandidates: probeIds.length,
    }).catch(() => null);
    // FAIL-CLOSED: a catalogue read that did not answer is not "everything is
    // still there". Nothing is honourable, the confirm refuses, and nothing is
    // written — which the reader can retry. Guessing cannot be undone.
    honourableSkillIds = candidates === null ? [] : candidates.map((c) => c.skillId);
  }

  const derived = deriveSelectionFromOfferedSet({
    offered,
    confirmedSkillIds: input.confirmedSkillIds,
    adjustedSkillIds: input.adjustedSkillIds,
    honourableSkillIds,
  });
  if (!derived.ok) {
    // BEFORE ANY WRITE. The run carries no selection row, no rejected-
    // recommendation evidence, and its hold stays exactly as it was.
    return {
      ok: false,
      refusal: {
        reason: OFFERED_SET_STALE_REASON,
        staleSkillIds: derived.staleSkillIds,
      },
    };
  }

  const selection = derived.selection;
  // THE SELECTION IS THE LATEST ONE, UNTIL THE RUN STARTS (cinatra#3047).
  //
  // The Skills step keeps its boxes editable while the run is still at its
  // setup, its schedule or any other pre-start moment, so a second Continue must
  // be able to take a skill OUT again — and an INSERT alone cannot, because the
  // selection set is first-write-wins per (run, skill). So the hold-bound
  // confirm writes through the REPLACE: one transaction, scoped to THIS hold's
  // own offer, with both statements testing the run's status, and an answer
  // rather than silence when the run has already started.
  //
  // A FIRST confirm takes exactly this path too, and nothing about it changes:
  // the run owns no row for those ids yet, so the replace deletes nothing and
  // inserts what a plain write would have. What it gains is the guard — a
  // confirm can no longer add rows to a run whose ledger execution has already
  // materialized, whether it is a re-decision or a stale first press.
  const applied = replaceRunSelectedSkillRevisionsBeforeStart({
    runId: input.runId,
    scopeSkillIds: offered.map((o) => o.skillId),
    selections: selection,
  });
  if (!applied) {
    return {
      ok: false,
      refusal: { reason: RUN_ALREADY_STARTED_REASON, staleSkillIds: [] },
    };
  }
  const efficacy = summarizeRecommendationEfficacy({
    recommendations: offered,
    selectedSkillIds: selection.map((s) => s.skillId),
  });
  persistRejectedHalf(input.runId, offered, efficacy);
  return { ok: true, written: selection.length, selection, efficacy };
}

/**
 * THE NO-OFFERED-SET PATH — the pre-cinatra#2906 behaviour, kept verbatim for a
 * hold that has no recorded offer: one parked before the offer was recorded at
 * all, or one whose draw could not record it.
 *
 * It scores at confirm time and resolves the reader's ids against THAT result,
 * which is exactly the seam #2906 closes — so it is reached only where the
 * alternative is refusing a hold that is already live and otherwise perfectly
 * decidable. It is a compatibility path, not a fallback anything new may rely
 * on: every card drawn since #2906 records its offer as it draws it.
 */
async function confirmWithoutOfferedSet(
  input: ConfirmRunSkillSelectionInput,
): Promise<ConfirmRunSkillSelectionResult> {
  const recommendations = await recommendSkillsForAgentTask({
    agentId: input.agentId,
    intent: input.intent,
    restrictToSkillIds: input.restrictToSkillIds,
  });
  const selection = deriveConfirmedSelection({
    recommendations,
    confirmedSkillIds: input.confirmedSkillIds,
    forcedRevisions: input.forcedRevisions,
    adjustedSkillIds: input.adjustedSkillIds,
  });
  writeRunSelectedSkillRevisions({ runId: input.runId, selections: selection });
  const efficacy = summarizeRecommendationEfficacy({
    recommendations,
    selectedSkillIds: selection.map((s) => s.skillId),
  });
  persistRejectedHalf(input.runId, recommendations, efficacy);
  return { ok: true, written: selection.length, selection, efficacy };
}
