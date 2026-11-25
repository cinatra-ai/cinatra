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
//     pointer the objects row carries (`latestRepresentationRevisionId`) is
//     object data an ordinary object update can merge, so it never decides; it
//     must agree with the table when present, and a disagreement is a refusal;
//   - no person APPROVED this exact revision: an `artifact_review_audit` row of
//     disposition approve for the revision, on a gate of the organisation that
//     pinned the revision and resolved as approve (a gate that lapsed at its
//     expiry writes no audit row, so it is no approval);
//   - the objects row changed after that approval (`objects.updated_at`, set by
//     the store on every write, later than the approval's audit row): the
//     body's own fields (`subject`, `contactId`) are object data, so a change
//     after the decision is content no person decided on;
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
  SELECT max(a.created_at) AS approved_at
    FROM "${s}"."artifact_review_audit" a
    JOIN "${s}"."artifact_review_gates" g ON g.id = a.gate_id
   WHERE g.org_id = $1 AND a.artifact_id = $2 AND a.representation_revision_id = $3
     AND a.disposition = 'approve'
     AND g.status = 'resolved' AND g.disposition = 'approve'
     AND g.pinned_targets @> jsonb_build_array(
           jsonb_build_object('artifactId', $2::text, 'representationRevisionId', $3::text))
)
SELECT
  (SELECT p.id FROM "${s}"."representation" p
    WHERE p.org_id = $1 AND p.artifact_id = $2
    ORDER BY p.revision DESC LIMIT 1) AS latest_revision_id,
  (SELECT approved_at IS NOT NULL FROM approval) AS approved,
  EXISTS (
    SELECT 1 FROM "${s}"."objects" o, approval
     WHERE o.id = $2 AND o.org_id = $1 AND o.updated_at > approval.approved_at
  ) AS changed_after_approval,
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
          approved?: boolean;
          changed_after_approval?: boolean;
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
    const pointer = data.latestRepresentationRevisionId;
    if (pointer !== undefined && pointer !== latest) {
      return {
        ok: false,
        error: `${name} is the newest revision of the artifact, but the artifact names ${String(pointer)} as its current one`,
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
    if (row.approved !== true) {
      return { ok: false, error: `${name} was not approved by a person` };
    }
    if (row.changed_after_approval === true) {
      return { ok: false, error: `artifact ${artifactId} was changed after ${name} was approved` };
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
