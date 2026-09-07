import "server-only";
import type { Pool } from "pg";
import { getPooledDb } from "@/lib/db/pooled";
import {
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import type { RunMadeArtifactRow } from "@cinatra-ai/agents/run-made-reading";

// ---------------------------------------------------------------------------
// WHAT A RUN MADE — the run-scoped artifact read behind the run page's last
// step (cinatra#3029, acceptance item 5).
//
// Two halves, in the drawing's own order:
//   WROTE — every FINALIZED materialization-ledger row of this run, whatever
//           path wrote it (a declared binding, a materialize tool, an authored
//           emit, or the DEFAULT ROAD). The ledger is the one journal every
//           write path claims through, so "what the run made" is one read of it
//           rather than a union of the paths.
//   USED  — the artifacts the run READ (its context selections), which the
//           drawing's reading names after the written ones.
//
// The deciding RUNG rides along on the written rows: it is what the default
// road recorded when it named the output's form.
// ---------------------------------------------------------------------------

function pool(): Pool {
  return getPooledDb({
    name: "run-made-artifacts",
    connectionString: () => getPostgresConnectionString(),
  });
}

function schema(): string {
  return postgresSchema.replaceAll('"', '""');
}

/** An artifact's own page. */
export function artifactOwnPagePath(artifactId: string): string {
  return `/artifacts/${encodeURIComponent(artifactId)}`;
}

/** Best-effort title from the object row's data. */
function readTitle(data: unknown, fallback: string): string {
  if (data !== null && typeof data === "object") {
    const title = (data as { title?: unknown }).title;
    if (typeof title === "string" && title.trim().length > 0) return title;
    const name = (data as { name?: unknown }).name;
    if (typeof name === "string" && name.trim().length > 0) return name;
  }
  return fallback;
}

/**
 * The run's artifacts, written first and used after — the rows the last step
 * lists. Never throws: the step draws the empty reading rather than an error.
 */
export async function listRunMadeArtifacts(input: {
  orgId: string;
  runId: string;
}): Promise<RunMadeArtifactRow[]> {
  try {
    ensurePostgresSchema();
    const s = schema();
    const written = await pool().query(
      `SELECT m.artifact_id, m.extension, m.detection_rung, o.data
         FROM "${s}"."artifact_materializations" m
         LEFT JOIN "${s}"."objects" o ON o.id = m.artifact_id
        WHERE m.org_id = $1 AND m.run_id = $2 AND m.phase = 'finalized'
          AND m.artifact_id IS NOT NULL
        ORDER BY m.created_at ASC`,
      [input.orgId, input.runId],
    );
    const used = await pool().query(
      `SELECT DISTINCT ON (s.artifact_id) s.artifact_id, s.extension, o.data
         FROM "${s}"."run_context_selections" s
         LEFT JOIN "${s}"."objects" o ON o.id = s.artifact_id
        WHERE s.org_id = $1 AND s.parent_run_id = $2
        ORDER BY s.artifact_id, s.selected_at ASC`,
      [input.orgId, input.runId],
    );
    const rows: RunMadeArtifactRow[] = [];
    const seen = new Set<string>();
    for (const r of written.rows as Array<{
      artifact_id: string;
      extension: string;
      detection_rung: string | null;
      data: unknown;
    }>) {
      if (seen.has(r.artifact_id)) continue;
      seen.add(r.artifact_id);
      rows.push({
        artifactId: r.artifact_id,
        title: readTitle(r.data, "an artifact this run wrote"),
        href: artifactOwnPagePath(r.artifact_id),
        extension: r.extension,
        rung: r.detection_rung,
        used: false,
      });
    }
    for (const r of used.rows as Array<{
      artifact_id: string;
      extension: string;
      data: unknown;
    }>) {
      // An artifact the run both wrote and read is what it WROTE.
      if (seen.has(r.artifact_id)) continue;
      seen.add(r.artifact_id);
      rows.push({
        artifactId: r.artifact_id,
        title: readTitle(r.data, "an artifact this run read"),
        href: artifactOwnPagePath(r.artifact_id),
        extension: r.extension,
        rung: null,
        used: true,
      });
    }
    return rows;
  } catch (err) {
    console.warn(
      `[run-made] the run's artifacts could not be read for run=${input.runId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
