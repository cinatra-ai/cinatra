import "server-only";

// THE TEXT OF AN ARTIFACT REVISION A PERSON DECIDED ON, READ ONLY WHILE IT IS
// STILL THE ARTIFACT'S CURRENT REVISION (cinatra#3089).
//
// A caller that acts on a decided revision (the campaign send mails the bodies
// a person decided on) names the revision it was handed and reads it here. The
// read refuses, by name, every revision that is not safe to act on:
//
//   - the ACTING actor may not read the artifact: the lookup is the artifact
//     read surface's own actor-scoped read (`getArtifact` with the actor: the
//     objects ownership filter in SQL plus the kernel `object.read` decision),
//     the same admission `artifact_content_read` reads a representation under.
//     A row the actor may not read and a row that does not exist get the SAME
//     refusal, so the answer never tells that an artifact exists;
//   - the artifact is not of the declared object type the caller expects;
//   - the REVISION was not filed in the caller's run: no finalized row of the
//     materialization ledger links that run to this artifact AT THIS REVISION
//     (the drafting step's mid-run filing, or a message bound in an earlier
//     drive of the same run). A revision another run filed of the same artifact
//     is not a body of this send;
//   - the revision is not the artifact's CURRENT revision: the newest row of
//     the append-only `representation` table for the artifact (the highest
//     `revision`, allocated under the unique index on organisation, artifact
//     and revision; the table refuses UPDATE and DELETE by trigger), so a body
//     produced again after the decision supersedes the old revision. The
//     pointer the objects row caches (`latestRepresentationRevisionId`)
//     decides nothing: it is written when the artifact is created and moved
//     by some appends only (the editor's save leaves it on an older revision,
//     see `resolveEditorRevisionId`), and an ordinary object update can merge
//     any value into it. An older revision never passes as current, because
//     the table's order alone answers which revision is newest;
//   - no PERSON APPROVED this exact revision. An approval is an
//     `artifact_review_audit` row of disposition approve for the revision that
//     belongs to the decision which resolved its gate (the row's
//     `decision_fingerprint` is the gate's `fingerprint`, same run and task),
//     on a gate of the organisation that pinned the revision and resolved as
//     approve. That decision is a person's only when (a) its fingerprint is
//     the sha256 the decision core computes, so a gate resolved by its expiry
//     (`expiry:<gate id>`, and no audit row) is no approval; (b) the gate
//     names its decider (`resolved_by`, the user id the decision core takes
//     from the deciding session), not null and not a `system:` principal;
//     (c) that user's row is a person's (`"userType"` human, or null on rows
//     older than the column; an assistant or fixture account is not a person);
//     and (d) the user is a member of the organisation. The audit row records
//     no actor of its own: it is tied to the decider through the decision
//     fingerprint the same transaction stamped on the gate.
//     The objects row's own fields decide nothing either: the text mailed is
//     the immutable revision's, and the subject is the caller's, so a later
//     object update (a title, a status, the cached pointer) changes nothing
//     this read answers;
//   - a gate decided against the revision (an `artifact_review_audit` row of
//     disposition reject or changes_requested), a gate that pins it is still
//     open, or a repair names it as its base (`lifecycle_repair`): each of these
//     means the revision is not the decided one;
//   - its text cannot be read whole (not a text form, or over the read cap).
//
// It reads the text through the one representation-text reader
// (`readArtifactRepresentationText`, live rows only), so a cap or a liveness
// rule cannot drift between two readers. It writes nothing. The object type is
// the caller's argument: this module names no type.

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { runPostgresQueriesAsync } from "@/lib/postgres-async";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { getObjectById } from "@/lib/objects-store";
import type { ActorContext } from "@/lib/authz/actor-context";

export type CurrentDecidedRevisionRead =
  | {
      ok: true;
      artifactId: string;
      representationRevisionId: string;
      /** The revision's text, whole. */
      text: string;
      /** The artifact's own declared fields (its typed data), as stored. */
      data: Record<string, unknown>;
    }
  | { ok: false; error: string };

/** One approve audit row of the revision, with the gate decision it belongs to. */
type ApprovalRow = {
  resolvedBy?: unknown;
  fingerprint?: unknown;
  deciderUserType?: unknown;
  deciderIsMember?: unknown;
};

/** The fingerprint the decision core stamps on a gate a decision resolved: the
 *  sha256 of the decision (`reviewDecisionFingerprint`). A gate resolved by its
 *  expiry carries `expiry:<gate id>` instead. */
const DECISION_FINGERPRINT = /^[a-f0-9]{64}$/;

/** A person of the organisation decided: a decision fingerprint, a named
 *  decider that is not a system principal, a person's user row and a
 *  membership of the organisation. Anything missing reads as no person. */
function isPersonsApproval(a: ApprovalRow): boolean {
  return (
    typeof a.fingerprint === "string" &&
    DECISION_FINGERPRINT.test(a.fingerprint) &&
    typeof a.resolvedBy === "string" &&
    a.resolvedBy.trim().length > 0 &&
    !a.resolvedBy.startsWith("system:") &&
    a.deciderUserType === "human" &&
    a.deciderIsMember === true
  );
}

/**
 * Read the text of `representationRevisionId` of `artifactId`, refusing every
 * revision that is not the artifact's current, undisputed revision. Never
 * throws: a refusal is a returned error naming the reason.
 */
export async function readCurrentDecidedRevision(input: {
  orgId: string;
  /** The acting actor: the read is admitted for this actor or refused. */
  actor: ActorContext;
  /** The run the artifact must have been filed in. */
  runId: string;
  artifactId: string;
  representationRevisionId: string;
  objectTypeId: string;
}): Promise<CurrentDecidedRevisionRead> {
  const { orgId, actor, runId, artifactId, representationRevisionId, objectTypeId } = input;
  const name = `revision ${representationRevisionId} of artifact ${artifactId}`;
  // One answer for "absent" and "not readable by this actor".
  const unseen: CurrentDecidedRevisionRead = {
    ok: false,
    error: `artifact ${artifactId} is not an artifact this organisation can see`,
  };
  try {
    const { getArtifact } = await import("./artifact-service");
    if (!getArtifact({ artifactId, orgId, actor })) return unseen;
    const rec = getObjectById(artifactId, { orgId }, actor);
    if (!rec) return unseen;
    if (rec.type !== objectTypeId) {
      return {
        ok: false,
        error: `artifact ${artifactId} is of type "${rec.type}", not "${objectTypeId}"`,
      };
    }
    const data =
      rec.data && typeof rec.data === "object" && !Array.isArray(rec.data)
        ? (rec.data as Record<string, unknown>)
        : {};
    ensurePostgresSchema();
    const s = postgresSchema.replaceAll('"', '""');
    const [res] = await runPostgresQueriesAsync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `WITH approval AS (
  SELECT g.resolved_by, g.fingerprint,
    (SELECT COALESCE(u."userType", 'human') FROM public."user" u WHERE u.id = g.resolved_by) AS decider_user_type,
    EXISTS (SELECT 1 FROM public."member" m
             WHERE m."organizationId" = $1 AND m."userId" = g.resolved_by) AS decider_is_member
    FROM "${s}"."artifact_review_audit" a
    JOIN "${s}"."artifact_review_gates" g ON g.id = a.gate_id
   WHERE g.org_id = $1 AND a.artifact_id = $2 AND a.representation_revision_id = $3
     AND a.disposition = 'approve'
     AND g.status = 'resolved' AND g.disposition = 'approve'
     AND a.decision_fingerprint = g.fingerprint
     AND a.run_id = g.run_id AND a.review_task_id = g.review_task_id
     AND g.pinned_targets @> jsonb_build_array(
           jsonb_build_object('artifactId', $2::text, 'representationRevisionId', $3::text))
)
SELECT
  (SELECT p.id FROM "${s}"."representation" p
    WHERE p.org_id = $1 AND p.artifact_id = $2
    ORDER BY p.revision DESC LIMIT 1) AS latest_revision_id,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'resolvedBy', resolved_by, 'fingerprint', fingerprint,
      'deciderUserType', decider_user_type, 'deciderIsMember', decider_is_member)), '[]'::jsonb)
     FROM approval) AS approvals,
  EXISTS (
    SELECT 1 FROM "${s}"."artifact_review_audit" a
      JOIN "${s}"."artifact_review_gates" g ON g.id = a.gate_id
     WHERE g.org_id = $1 AND a.artifact_id = $2 AND a.representation_revision_id = $3
       AND a.disposition IN ('reject', 'changes_requested')
  ) AS decided_against,
  EXISTS (
    SELECT 1 FROM "${s}"."artifact_review_gates" g
     WHERE g.org_id = $1 AND g.status = 'pending'
       AND g.pinned_targets @> jsonb_build_array(
             jsonb_build_object('artifactId', $2::text, 'representationRevisionId', $3::text))
  ) AS open_gate,
  EXISTS (
    SELECT 1 FROM "${s}"."lifecycle_repair" r
     WHERE r.org_id = $1 AND r.base_artifact_id = $2
       AND r.base_representation_revision_id = $3
  ) AS repaired,
  EXISTS (
    SELECT 1 FROM "${s}"."artifact_materializations" m
     WHERE m.org_id = $1 AND m.run_id = $4 AND m.artifact_id = $2
       AND m.representation_revision_id = $3 AND m.phase = 'finalized'
  ) AS filed_in_run`,
          values: [orgId, artifactId, representationRevisionId, runId],
        },
      ],
    });
    const row = (res?.rows?.[0] ?? null) as
      | {
          latest_revision_id?: string | null;
          approvals?: unknown;
          decided_against?: boolean;
          open_gate?: boolean;
          repaired?: boolean;
          filed_in_run?: boolean;
        }
      | null;
    if (!row) return { ok: false, error: `the decision state of ${name} could not be read` };
    const latest = row.latest_revision_id;
    if (typeof latest !== "string" || latest.length === 0) {
      return { ok: false, error: `artifact ${artifactId} carries no current revision` };
    }
    if (latest !== representationRevisionId) {
      return {
        ok: false,
        error: `${name} is not its current revision (the current one is ${latest}); a revision filed after the decision supersedes it`,
      };
    }
    if (row.filed_in_run !== true) {
      return { ok: false, error: `${name} was not filed in run ${runId}` };
    }
    if (row.decided_against === true) {
      return { ok: false, error: `${name} was decided against (rejected or sent back for changes)` };
    }
    if (row.open_gate === true) {
      return { ok: false, error: `${name} still waits on an open decision` };
    }
    if (row.repaired === true) {
      return { ok: false, error: `${name} has a repair filed against it` };
    }
    const approvals = Array.isArray(row.approvals) ? (row.approvals as ApprovalRow[]) : [];
    if (approvals.length === 0) {
      return { ok: false, error: `${name} was not approved by a person` };
    }
    if (!approvals.some(isPersonsApproval)) {
      return { ok: false, error: `${name} was approved, but not by a person of organisation ${orgId}` };
    }

    const { readArtifactRepresentationText } = await import("./extension-artifact-reads");
    const read = await readArtifactRepresentationText({
      orgId,
      actor,
      artifactId,
      representationRevisionId,
      knownLatestRevisionId: latest,
    });
    if (read.representationRevisionId !== representationRevisionId) {
      return { ok: false, error: `${name} was read at another revision` };
    }
    if (read.truncated) {
      return { ok: false, error: `${name} is too long to be read whole` };
    }
    return { ok: true, artifactId, representationRevisionId, text: read.text, data };
  } catch (err) {
    return {
      ok: false,
      error: `${name} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// THE REVIEW FILINGS OF A RUN (cinatra#3089), for a caller that must not act on
// a run's unreviewed copy of work a person reviews elsewhere.
//
// The run's filings come from the materialization ledger
// (`listRunFiledArtifactIds`: mid-run paths only, scoped to the organization,
// so a run id of another organization answers exactly like an unknown one),
// and each filed artifact's type is read through the access-checked objects
// read (`getObjectById` under the acting kernel actor). The answer fails
// closed: a run that filed more artifacts than the cap, or a filed artifact
// that cannot be read (absent for this actor, or a read error), counts as
// filed. The caller names the type; this module names none.
// ---------------------------------------------------------------------------

/** The code an action carries when its run filed artifacts for review and the
 *  action names none of the reviewed ones. */
export const REVIEWED_ARTIFACTS_REQUIRED = "REVIEWED_ARTIFACTS_REQUIRED";

/** Refuses an action of a run whose steps filed artifacts for review, when the
 *  action does not use what a person released; nothing is done. */
export class ReviewedArtifactsRequiredError extends Error {
  readonly code = REVIEWED_ARTIFACTS_REQUIRED;
  constructor(message: string) {
    super(`${REVIEWED_ARTIFACTS_REQUIRED}: ${message}`);
    this.name = "ReviewedArtifactsRequiredError";
  }
}

/** The most filed artifacts one answer reads; a run that filed more counts as
 *  filed without reading them. */
export const RUN_FILINGS_READ_CAP = 200;

export async function runHasFiledReviewArtifacts(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  objectTypeId: string;
  cap?: number;
}): Promise<boolean> {
  const { listRunFiledArtifactIds } = await import("./materialization-ledger");
  const { artifactIds, overCap } = await listRunFiledArtifactIds({
    orgId: input.orgId,
    runId: input.runId,
    cap: input.cap ?? RUN_FILINGS_READ_CAP,
  });
  if (overCap) return true;
  for (const artifactId of artifactIds) {
    let type: string | undefined;
    try {
      type = getObjectById(artifactId, { orgId: input.orgId }, input.actor)?.type;
    } catch {
      return true;
    }
    if (type === undefined || type === input.objectTypeId) return true;
  }
  return false;
}
