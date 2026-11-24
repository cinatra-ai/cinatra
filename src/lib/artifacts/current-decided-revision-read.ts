import "server-only";

// THE TEXT OF AN ARTIFACT REVISION A PERSON DECIDED ON, READ ONLY WHILE IT IS
// STILL THE ARTIFACT'S CURRENT REVISION (cinatra#3089).
//
// A caller that acts on a decided revision (the campaign send mails the bodies
// a person decided on) names the revision it was handed and reads it here. The
// read refuses, by name, every revision that is not safe to act on:
//
//   - the artifact is not a live row of the caller's organisation, or is not of
//     the declared object type the caller expects;
//   - the revision is not the artifact's CURRENT revision: the objects row
//     points at its latest representation (`latestRepresentationRevisionId`,
//     moved by every append and refile, artifact-revision-append.ts), so a body
//     produced again after the decision supersedes the old revision and the old
//     one is refused;
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
  artifactId: string;
  representationRevisionId: string;
  objectTypeId: string;
}): Promise<CurrentDecidedRevisionRead> {
  const { orgId, artifactId, representationRevisionId, objectTypeId } = input;
  const name = `revision ${representationRevisionId} of artifact ${artifactId}`;
  try {
    const rec = getObjectById(artifactId, { orgId });
    if (!rec) {
      return { ok: false, error: `artifact ${artifactId} is not a live artifact of organization ${orgId}` };
    }
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
    const latest = data.latestRepresentationRevisionId;
    if (typeof latest !== "string" || latest.length === 0) {
      return { ok: false, error: `artifact ${artifactId} carries no current revision` };
    }
    if (latest !== representationRevisionId) {
      return {
        ok: false,
        error: `${name} is not its current revision (the current one is ${latest}); a revision filed after the decision supersedes it`,
      };
    }

    ensurePostgresSchema();
    const s = postgresSchema.replaceAll('"', '""');
    const [res] = await runPostgresQueriesAsync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT
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
  ) AS repaired`,
          values: [orgId, artifactId, representationRevisionId],
        },
      ],
    });
    const row = (res?.rows?.[0] ?? null) as
      | { decided_against?: boolean; open_gate?: boolean; repaired?: boolean }
      | null;
    if (!row) return { ok: false, error: `the decision state of ${name} could not be read` };
    if (row.decided_against === true) {
      return { ok: false, error: `${name} was decided against (rejected or sent back for changes)` };
    }
    if (row.open_gate === true) {
      return { ok: false, error: `${name} still waits on an open decision` };
    }
    if (row.repaired === true) {
      return { ok: false, error: `${name} has a repair filed against it` };
    }

    const { readArtifactRepresentationText } = await import("./extension-artifact-reads");
    const read = await readArtifactRepresentationText({
      orgId,
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
