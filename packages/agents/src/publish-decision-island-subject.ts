import "server-only";

// ---------------------------------------------------------------------------
// THE PUBLISH-DECISION ISLAND'S SUBJECT (cinatra#4150 W4 C1b): the agents-domain half of the island loader.
//
// "Which artifact revisions does this artifacts row of this publish card show this reader?" Answered from the run, its
// NEWEST decision (the one the card shows) and the template's declared rows, through the same access door the card's
// own read takes (publish-decision-card-core.ts). The targets come from the decision's surfaced values, which are frozen
// at park, so the reader sees the exact revisions the decision is about; they are NEVER taken from a caller.
//
// The subject read proves the row; `readRevisionsMadeByRun` proves the targets. The island loader (src/lib/lifecycle/
// publish-decision-island.ts) runs both, in that order with the reader's organization check between them, and prepares
// the proven set through the one review core, which applies the reader's own read access to each artifact.
//
// EVERY REFUSAL IS `null`, with no reason, and a read that throws is a refusal: the island draws one empty document for
// "you may not read this" and "there is nothing here".
// ---------------------------------------------------------------------------

import { and, eq, inArray } from "drizzle-orm";
import { pgSchema, text } from "drizzle-orm/pg-core";

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import {
  normalizeReviewTargets,
  type ArtifactReviewTarget,
} from "@/lib/artifacts/artifact-review-target";

import type { ActorRoleHints } from "./auth-policy";
import { db } from "./db";
import { declaredPublishRowsFor, publishRowKind } from "./publish-decision-card";
import { readLatestDecisionForRun } from "./publish-decision-store";
import { readAgentRunById, readAgentTemplateById } from "./store";

/** The proven row: the run's organization, whether the decision is settled, and the frozen targets (1 to 50). */
export type PublishDecisionIslandSubject = {
  runId: string;
  orgId: string;
  decided: boolean;
  targets: ArtifactReviewTarget[];
};

const ID_MAX = 128;
const boundedId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= ID_MAX;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

type Who = { actor: PrimitiveActorContext; roleHints?: ActorRoleHints };

/**
 * The card a reader may see on a run: the run access door ("read"), then the run's NEWEST decision, still a card (not
 * run_ended) of this run and its organization, and the rows that card declares. `null` for every refusal.
 */
async function openCardOfRun(runId: string, who: Who) {
  if (!boundedId(runId)) return null;
  // 1. The run access door, the card's own: a reader who may not read the run reaches nothing below.
  const run = await readAgentRunById(runId, who.actor, who.roleHints);
  if (!run || run.id !== runId || !boundedId(run.orgId)) return null;
  // 2. The decision the card shows: the run's NEWEST. An older decision, another run's, one the run left another way
  //    (run_ended) and one recorded for another organization draw nothing.
  const decision = await readLatestDecisionForRun(run.id);
  if (!decision || decision.runId !== run.id) return null;
  if (decision.status === "run_ended") return null;
  if (decision.orgId !== null && decision.orgId !== run.orgId) return null;
  // 3. The declared rows. The rows the decision kept at its park are the card's rows; only a decision older than that
  //    record (declaredRows null) reads the template's current rows, as the card does.
  const template = await readAgentTemplateById(run.templateId);
  if (!template) return null;
  const declared = decision.declaredRows ?? declaredPublishRowsFor(template.publishRows, decision.nodeId);
  return { run: { id: run.id, orgId: run.orgId }, decision, declared };
}

/**
 * Prove one artifacts row of the run's open card for one verified reader, in this order: the run access door ("read"),
 * the run's newest decision is the named one and still a card (not run_ended) of this run and its organization, the
 * template declares an artifacts row over the named input for the decision's own node, and the decision's frozen value
 * for that input is a valid target list (one malformed entry refuses the whole set).
 */
export async function readPublishDecisionIslandSubject(input: {
  runId: string;
  decisionId: string;
  input: string;
  who: Who;
}): Promise<PublishDecisionIslandSubject | null> {
  try {
    if (!boundedId(input.runId) || !boundedId(input.decisionId) || !boundedId(input.input)) return null;
    const card = await openCardOfRun(input.runId, input.who);
    if (!card || card.decision.id !== input.decisionId) return null;
    const { run, decision, declared } = card;
    // The declared row: an artifacts row over the named input, on the decision's own node (own keys only).
    const row = declared.find((r) => publishRowKind(r) === "artifacts" && r.input === input.input);
    if (!row) return null;
    // 4. The frozen targets, read by own key. Normalized as a review gate's set is: 1 to 50, deduped, and one entry that
    //    is not `{artifactId, representationRevisionId}` refuses all of them rather than drawing the rest.
    const surfaced = decision.surfacedValues;
    if (!own(surfaced, input.input)) return null;
    const targets = normalizeReviewTargets(surfaced[input.input]);
    if (!targets.ok) return null;
    return { runId: run.id, orgId: run.orgId, decided: decision.status !== "parked", targets: targets.targets };
  } catch {
    return null;
  }
}

/**
 * The artifacts rows of the card a reader may see on a run (cinatra#4738 round 2): the newest decision's id and the
 * input each of its artifacts rows reads, behind the same door and decision checks as the subject read. The sealed
 * byte and capture roads of a publish row carry only the row's subject key, so their serving path reads these to find
 * which row a key names, and then proves that row with `readPublishDecisionIslandSubject`. `null` for every refusal.
 */
export async function readPublishDecisionIslandRows(input: {
  runId: string;
  who: Who;
}): Promise<{ decisionId: string; inputs: string[] } | null> {
  try {
    const card = await openCardOfRun(input.runId, input.who);
    if (!card) return null;
    const inputs = card.declared.filter((r) => publishRowKind(r) === "artifacts").map((r) => r.input);
    return { decisionId: card.decision.id, inputs };
  } catch {
    return null;
  }
}

// The `representation` table, referenced the narrow way lifecycle-declared-review-store.ts references `objects`: this
// package owns no artifact schema, and this read needs four columns of it. The table is append-only (a revision row is
// never updated), so the run that created a revision is a fact that cannot change after it is read.
const appSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");
const representationRef = appSchema.table("representation", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  artifactId: text("artifact_id").notNull(),
  createdByRunId: text("created_by_run_id"),
});

const REVISION_ID_MAX = 256;

/**
 * True only when EVERY target's revision row exists in the run's organization, for that target's artifact, and was
 * created by this run. One read keyed by organization and creating run, then the set compared pair by pair, so a
 * revision of the run that is named with another artifact is not one of the run's targets. Never throws: a store
 * failure is `false`, which refuses the island.
 */
export async function readRevisionsMadeByRun(input: {
  orgId: string;
  runId: string;
  targets: readonly ArtifactReviewTarget[];
}): Promise<boolean> {
  const { orgId, runId, targets } = input;
  if (!boundedId(orgId) || !boundedId(runId) || targets.length === 0) return false;
  if (!targets.every((t) => t.representationRevisionId.length > 0 && t.representationRevisionId.length <= REVISION_ID_MAX)) {
    return false;
  }
  try {
    const ids = [...new Set(targets.map((t) => t.representationRevisionId))];
    const rows = await db
      .select({ id: representationRef.id, artifactId: representationRef.artifactId })
      .from(representationRef)
      .where(
        and(
          eq(representationRef.orgId, orgId),
          eq(representationRef.createdByRunId, runId),
          inArray(representationRef.id, ids),
        ),
      );
    const made = new Map<string, string>();
    for (const row of rows) {
      if (typeof row.id === "string" && typeof row.artifactId === "string") made.set(row.id, row.artifactId);
    }
    return targets.every((t) => made.get(t.representationRevisionId) === t.artifactId);
  } catch {
    return false;
  }
}
