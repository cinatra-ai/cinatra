import "server-only";
import type { Pool } from "pg";
import type { RunArtifactRecord } from "@cinatra-ai/agents/run-artifact-list";
import { getPooledDb } from "@/lib/db/pooled";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

// ---------------------------------------------------------------------------
// The read behind the run page's "what this run made" list (§6 step 6; the
// artifact half of #3002, which W5 delivers).
//
// TWO SOURCES, ONE READING:
//   * WROTE — every FINALIZED row of `artifact_materializations` for the run.
//     That is the whole point of the ledger: a row exists because the work
//     REACHED AN ARTIFACT, on ANY road (a declared binding, the materialize
//     tool, an authoring emit, the default road). The page therefore lists what
//     the run made, not what one road made.
//   * USED — every `run_context_selections` row of the run: the artifact and the
//     pinned revision the run READ to make the others.
//
// Org-scoped on both sides. The caller has already proved the person may read
// the run (the run page's own door); this adds no wider read.
// ---------------------------------------------------------------------------

function pool(): Pool {
  return getPooledDb({
    name: "run-artifact-records",
    connectionString: () => getPostgresConnectionString(),
  });
}

function schema(): string {
  return postgresSchema.replaceAll('"', '""');
}

/** A title carried by an artifact's own object data, when its type declares
 *  one. Never invented: an artifact with no title reads as its type. */
function titleFromObjectData(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  for (const key of ["title", "name", "headline"]) {
    const v = d[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/** A placement/state annotation an artifact's own type data carries — the blog
 *  image's `placement`, for one. Read from the row, never guessed. */
function annotationFromObjectData(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const v = d.placement;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Every artifact this run WROTE and every artifact it USED, oldest first inside
 * each role. Returns `[]` for a run that reached neither — which the list model
 * draws as the EMPTY reading, not as an empty panel.
 */
export async function readRunArtifactRecords(input: {
  orgId: string;
  runId: string;
}): Promise<RunArtifactRecord[]> {
  ensurePostgresSchema();
  const s = schema();

  const wrote = await pool().query(
    `SELECT DISTINCT ON (m.artifact_id)
            m.artifact_id,
            m.representation_revision_id,
            o.type   AS object_type_id,
            o.data   AS object_data,
            r.mime   AS mime
       FROM "${s}"."artifact_materializations" m
       JOIN "${s}"."objects" o ON o.id = m.artifact_id
       LEFT JOIN "${s}"."representation" rep
              ON rep.id = m.representation_revision_id AND rep.org_id = m.org_id
       LEFT JOIN "${s}"."resource" r
              ON r.id = rep.resource_id AND r.org_id = m.org_id
      WHERE m.run_id = $1 AND m.org_id = $2 AND m.phase = 'finalized'
        AND m.artifact_id IS NOT NULL AND m.representation_revision_id IS NOT NULL
      ORDER BY m.artifact_id, m.created_at ASC`,
    [input.runId, input.orgId],
  );

  const used = await pool().query(
    `SELECT DISTINCT ON (c.artifact_id)
            c.artifact_id,
            c.representation_revision_id,
            o.type   AS object_type_id,
            o.data   AS object_data,
            r.mime   AS mime
       FROM "${s}"."run_context_selections" c
       JOIN "${s}"."objects" o ON o.id = c.artifact_id
       LEFT JOIN "${s}"."representation" rep
              ON rep.id = c.representation_revision_id AND rep.org_id = c.org_id
       LEFT JOIN "${s}"."resource" r
              ON r.id = rep.resource_id AND r.org_id = c.org_id
      WHERE c.parent_run_id = $1 AND c.org_id = $2
      ORDER BY c.artifact_id, c.created_at ASC`,
    [input.runId, input.orgId],
  );

  const writtenIds = new Set<string>();
  const records: RunArtifactRecord[] = [];
  for (const row of wrote.rows as Array<Record<string, unknown>>) {
    writtenIds.add(String(row.artifact_id));
    records.push({
      artifactId: String(row.artifact_id),
      representationRevisionId: String(row.representation_revision_id),
      role: "wrote",
      title: titleFromObjectData(row.object_data),
      objectTypeId: String(row.object_type_id),
      mime: row.mime == null ? null : String(row.mime),
      annotation: annotationFromObjectData(row.object_data),
    });
  }
  for (const row of used.rows as Array<Record<string, unknown>>) {
    const id = String(row.artifact_id);
    // An artifact the run both READ and WROTE is one row, listed as written —
    // the stronger fact about the run, and a reader never sees it twice.
    if (writtenIds.has(id)) continue;
    records.push({
      artifactId: id,
      representationRevisionId: String(row.representation_revision_id),
      role: "used",
      title: titleFromObjectData(row.object_data),
      objectTypeId: String(row.object_type_id),
      mime: row.mime == null ? null : String(row.mime),
      annotation: "read by this run",
    });
  }
  return records;
}
