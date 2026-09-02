/**
 * THE PIPELINE'S STORED-IDEAS GATE, the part that reads and writes (cinatra#3035,
 * epic #3023 W11; plan (C) §5.1, §6.1 step 2, §8.4).
 *
 * Three steps of the pipeline's flow, each one call:
 *
 *   prepareStoredIdeas   — the preparation step in front of the gate: list every
 *                          blog-idea artifact of the organisation through the
 *                          pipeline's DECLARED dependency (item 0.26), read each
 *                          candidate's text (one read per unused idea), subtract
 *                          what the relation table holds, and emit the rest as the
 *                          message the gate renderer already reads.
 *   reserveStoredIdea    — the pick: one reservation row under the uniqueness rule
 *                          that allows one live row per idea, so of two runs
 *                          offering the same idea only one takes it.
 *   completeIdeaRelation — after the draft is written: the reservation becomes the
 *                          relation, keyed by run and idea, so a retry after a
 *                          failure completes the SAME row and never a second.
 *
 * EVERY READ AND WRITE IS A PORT. The real ports are the extension-scoped tools
 * W7 landed — the dependency-scoped artifact reads and the extension-data tool on
 * the pipeline's own declared table — and nothing here knows that, so the whole
 * gate is provable without a database and the two fixtures plan (C) §8.8 says the
 * fleet cannot supply ("two runs picking the same idea at once", "a run that
 * fails after its draft is written") are ordinary tests.
 */

import {
  IDEA_RELATION_TABLE,
  IDEA_TAKEN_REASON,
  offerStoredIdeas,
  takenArtifactIdsFromRows,
  type OfferedIdea,
  type StoredIdeaCandidate,
  type StoredIdeaOffer,
} from "./stored-ideas-gate";

/** How many stored ideas one gate reads content for. The listing is paged at a
 *  hundred per page (plan (C) §8.9); a person choosing from more than this is
 *  choosing from a list nobody reads, and each entry costs a content read. */
export const MAX_OFFERED_IDEAS = 100;

export interface StoredIdeaReference {
  readonly artifactId: string;
  readonly representationRevisionId: string;
}

export type RelationWriteResult =
  | { readonly ok: true }
  /** `conflict` distinguishes the uniqueness rule firing — another run holds this
   *  idea — from a write that failed for any other reason. */
  | { readonly ok: false; readonly conflict: boolean };

export interface StoredIdeasPorts {
  /** Every blog-idea artifact of the organisation, newest first, through the
   *  pipeline's declared dependency. */
  listIdeaArtifacts(): Promise<StoredIdeaReference[]>;
  /** One idea's text. Null when the content cannot be read. */
  readIdeaText(artifactId: string): Promise<string | null>;
  /** The pipeline's own relation rows for this organisation. */
  listRelationRows(): Promise<Array<Record<string, unknown>>>;
  insertRelationRow(row: Record<string, unknown>): Promise<RelationWriteResult>;
  updateRelationRow(
    keys: { run_id: string; idea_artifact_id: string },
    patch: Record<string, unknown>,
  ): Promise<RelationWriteResult>;
}

/**
 * The list the gate offers. A refusal here ends the run with the sentence it
 * carries — plan (C) §6.1 step 2: "an empty list ends the run with a plain
 * reason".
 */
export async function prepareStoredIdeas(input: {
  readonly ports: StoredIdeasPorts;
  readonly orgId: string;
  readonly runId: string;
}): Promise<StoredIdeaOffer> {
  const [references, rows] = await Promise.all([
    input.ports.listIdeaArtifacts(),
    input.ports.listRelationRows(),
  ]);
  const taken = new Set(takenArtifactIdsFromRows(rows));
  // ONE CONTENT READ PER UNUSED IDEA, and none for an idea already taken: the
  // subtraction happens before the reads, not after them, so a list of a hundred
  // ideas of which two are free costs two reads.
  const candidates: StoredIdeaCandidate[] = [];
  for (const reference of references) {
    if (taken.has(reference.artifactId)) continue;
    if (candidates.length >= MAX_OFFERED_IDEAS) break;
    const text = await input.ports.readIdeaText(reference.artifactId).catch(() => null);
    candidates.push({ ...reference, text: text ?? "" });
  }
  return offerStoredIdeas({ candidates, takenArtifactIds: [] });
}

/**
 * Take the picked idea for this run.
 *
 * THE UNIQUENESS RULE IS THE RACE'S ONLY ARBITER: the insert either lands or is
 * refused by the table's own one-live-row-per-idea index, so two runs that offer
 * the same idea at the same moment cannot both take it, however close their picks
 * are. The loser is told the idea was just taken and the list refreshes; nothing
 * is silently re-picked for them.
 */
export async function reserveStoredIdea(input: {
  readonly ports: StoredIdeasPorts;
  readonly orgId: string;
  readonly runId: string;
  readonly idea: OfferedIdea;
  /** How long a reservation is held before a failed or abandoned run releases it. */
  readonly reservationTtlMs?: number;
  readonly now?: Date;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = input.now ?? new Date();
  const ttl = input.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
  const written = await input.ports.insertRelationRow({
    org_id: input.orgId,
    run_id: input.runId,
    idea_artifact_id: input.idea.artifactId,
    idea_revision_id: input.idea.representationRevisionId,
    state: "reserved",
    draft_artifact_id: null,
    expires_at: new Date(now.getTime() + ttl).toISOString(),
    created_at: now.toISOString(),
  });
  if (written.ok) return { ok: true };
  if (written.conflict) return { ok: false, reason: IDEA_TAKEN_REASON };
  return {
    ok: false,
    reason:
      `The reservation for this blog idea could not be written to ${IDEA_RELATION_TABLE}, so the ` +
      "run stops rather than drafting an idea another run may also be drafting.",
  };
}

/** Two days: long enough for a run that parks at a review over a weekend, short
 *  enough that an abandoned run does not hold an idea for ever. */
const DEFAULT_RESERVATION_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Complete the reservation into the relation: this idea, this draft.
 *
 * KEYED BY RUN AND IDEA, so a retry after a failure completes the SAME row and
 * never a second — "that row is what 'not yet used' means". The expiry is cleared
 * because a drafted relation is not a reservation and never lapses; the draft
 * written before a later failure stays, as an audited draft, and only its
 * reservation is released.
 */
export async function completeIdeaRelation(input: {
  readonly ports: StoredIdeasPorts;
  readonly orgId: string;
  readonly runId: string;
  readonly ideaArtifactId: string;
  readonly draftArtifactId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const written = await input.ports.updateRelationRow(
    { run_id: input.runId, idea_artifact_id: input.ideaArtifactId },
    { state: "drafted", draft_artifact_id: input.draftArtifactId, expires_at: null },
  );
  if (written.ok) return { ok: true };
  return {
    ok: false,
    reason:
      `The idea-to-draft relation for run ${input.runId} could not be completed in ` +
      `${IDEA_RELATION_TABLE}; the idea stays reserved until the reservation lapses.`,
  };
}

/**
 * Release this run's reservation.
 *
 * "A reservation whose run fails or expires is released; a draft written before
 * such a failure stays, as an audited draft without a relation, and the idea
 * returns to the list." A row already completed into a relation is NOT released —
 * the update names the reserved state, so a drafted row is left alone.
 */
export async function releaseIdeaReservation(input: {
  readonly ports: StoredIdeasPorts;
  readonly runId: string;
  readonly ideaArtifactId: string;
}): Promise<{ ok: boolean }> {
  const written = await input.ports.updateRelationRow(
    { run_id: input.runId, idea_artifact_id: input.ideaArtifactId },
    { state: "released", expires_at: null },
  );
  return { ok: written.ok };
}
