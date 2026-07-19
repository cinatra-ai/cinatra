import "server-only";

// Durable Postgres-backed `EnvironmentLayerStore` (exec-plane S3 A2,
// cinatra#1708; epic #1705).
//
// The exec-plane `EnvironmentLayerCache` runs over an injectable
// `EnvironmentLayerStore`. The in-memory implementation is process-local, so
// GC/teardown decisions in one process are invisible to another. This durable
// store makes the cache CROSS-PROCESS: a later process reuses an earlier build
// (a cache HIT), and lifecycle reference drops + the retention GC are one shared
// source of truth. It backs the two tables the same-PR schema leaf
// (environment-layer-schema.ts) + migration (core__0057) create.
//
// CONCURRENCY (Codex r2 #4 — the cross-process reap race). A bare
// `DELETE … NOT EXISTS (references)` is NOT MVCC-safe under READ COMMITTED: a
// concurrent `addReference` INSERT is invisible to the delete's snapshot
// (write-skew). So BOTH the reference-INSERT and the reap-DELETE run inside a
// transaction that first takes `pg_advisory_xact_lock(hashtext(recipe_key))` —
// serializing reap vs addReference on the SAME recipe. The reaper deletes the
// row and COMMITs FIRST, then the caller best-effort `docker rmi`s the image
// (delete-then-rmi: a failed rmi leaves a benign disk orphan swept by
// `docker image prune`, never a retained row pointing at a deleted image).
//
// I/O runs through `runPostgresQueriesSync` (the established durable-store
// primitive — a per-call worker-thread + pg Client, one transaction per call),
// wrapped to satisfy the async store contract.

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import type {
  EnvironmentLayerCacheEntry,
  EnvironmentLayerPartition,
  EnvironmentLayerStore,
  EnvironmentRecipeReference,
  ReferenceMatch,
} from "@cinatra-ai/execution-plane";
import type { SignedEnvironmentLayerProvenance } from "@cinatra-ai/execution-plane";

type Row = Record<string, unknown>;

/** Stable surrogate ids derived from the natural keys (idempotent UPSERT). */
const layerId = (recipeKey: string, partition: string): string =>
  `env-layer:${partition}:${recipeKey}`;

function mapLayerRow(row: Row): EnvironmentLayerCacheEntry {
  return {
    recipeKey: String(row.recipe_key),
    specKey: String(row.spec_key),
    imageRef: String(row.image_ref),
    imageDigest: String(row.image_digest),
    partition: String(row.partition) as EnvironmentLayerPartition,
    // jsonb → already a parsed object from node-postgres.
    provenance: row.provenance as SignedEnvironmentLayerProvenance,
    builtAtMs: Number(row.built_at_ms),
    lastUsedAtMs: Number(row.last_used_at_ms),
  };
}

function mapReferenceRow(row: Row): EnvironmentRecipeReference {
  return {
    recipeKey: String(row.recipe_key),
    orgId: String(row.org_id),
    holder: {
      ...(row.holder_package_name != null ? { packageName: String(row.holder_package_name) } : {}),
      ...(row.holder_template_id != null ? { templateId: String(row.holder_template_id) } : {}),
      ...(row.holder_version_id != null ? { versionId: String(row.holder_version_id) } : {}),
    },
  };
}

/**
 * Extra (beyond the `EnvironmentLayerStore` contract) durable-reap operations
 * the A2 execution service drives. Kept on the concrete pg store so the service
 * can run the advisory-lock delete→commit protocol; the in-memory store never
 * needs them (its single-threaded reap is the package's own
 * `reapUnreferencedLayers`).
 */
export interface DurableEnvironmentLayerStore extends EnvironmentLayerStore {
  /** Layers with ZERO references whose last use is older than the cutoff (a
   * pre-filter; the per-candidate reap re-checks under the advisory lock). */
  listReapableLayers(
    cutoffMs: number,
  ): Promise<Array<{ recipeKey: string; partition: EnvironmentLayerPartition; imageRef: string }>>;
  /**
   * Atomically reap ONE candidate under `pg_advisory_xact_lock(hashtext(
   * recipe_key))`: re-check zero references + the unused window, DELETE the row,
   * COMMIT. Returns the removed layer's IMMUTABLE `imageDigest` (image ID) for
   * the caller's best-effort post-commit `docker rmi` — NOT the content-addressed
   * `imageRef` TAG (Codex convergence): the tag `cinatra-sandbox-l1:<recipeKey>`
   * is deterministic, so a run that rebuilds the SAME recipe in the post-commit
   * window (the advisory lock is released at commit) re-points that tag to a NEW
   * image; removing by the tag would then delete the freshly-rebuilt, now-in-use
   * image. Removing by the OLD digest targets only the specific (now dangling)
   * image the reaped row named — never the rebuild. Null when the candidate
   * re-acquired a reference / was refreshed after the pre-filter (no-op).
   */
  reapCandidateUnderLock(
    recipeKey: string,
    partition: EnvironmentLayerPartition,
    cutoffMs: number,
  ): Promise<{ removedImageDigest: string } | null>;
}

export function createDurableEnvironmentLayerStore(): DurableEnvironmentLayerStore {
  const s = postgresSchema.replaceAll('"', '""');
  const conn = () => getPostgresConnectionString();
  const T = (name: string) => `"${s}"."${name}"`;

  const run = (
    queries: Array<{ text: string; values?: unknown[] }>,
    transaction = false,
  ): Array<{ rows: Row[]; rowCount: number }> => {
    ensurePostgresSchema();
    return runPostgresQueriesSync({
      connectionString: conn(),
      queries,
      transaction,
    }) as Array<{ rows: Row[]; rowCount: number }>;
  };

  return {
    listByRecipeKey: (recipeKey) =>
      Promise.resolve(
        run([
          { text: `SELECT * FROM ${T("environment_layers")} WHERE recipe_key = $1`, values: [recipeKey] },
        ])[0].rows.map(mapLayerRow),
      ),

    listBySpecKey: (specKey) =>
      Promise.resolve(
        run([
          { text: `SELECT * FROM ${T("environment_layers")} WHERE spec_key = $1`, values: [specKey] },
        ])[0].rows.map(mapLayerRow),
      ),

    listAll: () =>
      Promise.resolve(
        run([{ text: `SELECT * FROM ${T("environment_layers")}` }])[0].rows.map(mapLayerRow),
      ),

    put: (entry) => {
      run([
        {
          text: `INSERT INTO ${T("environment_layers")}
              (id, recipe_key, spec_key, image_ref, image_digest, partition, provenance, built_at_ms, last_used_at_ms)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
            ON CONFLICT (recipe_key, partition) DO UPDATE SET
              spec_key = EXCLUDED.spec_key,
              image_ref = EXCLUDED.image_ref,
              image_digest = EXCLUDED.image_digest,
              provenance = EXCLUDED.provenance,
              built_at_ms = EXCLUDED.built_at_ms,
              last_used_at_ms = EXCLUDED.last_used_at_ms`,
          values: [
            layerId(entry.recipeKey, entry.partition),
            entry.recipeKey,
            entry.specKey,
            entry.imageRef,
            entry.imageDigest,
            entry.partition,
            JSON.stringify(entry.provenance),
            entry.builtAtMs,
            entry.lastUsedAtMs,
          ],
        },
      ]);
      return Promise.resolve();
    },

    delete: (recipeKey, partition) => {
      run([
        {
          text: `DELETE FROM ${T("environment_layers")} WHERE recipe_key = $1 AND partition = $2`,
          values: [recipeKey, partition],
        },
      ]);
      return Promise.resolve();
    },

    listReferences: () =>
      Promise.resolve(
        run([{ text: `SELECT * FROM ${T("environment_layer_references")}` }])[0].rows.map(
          mapReferenceRow,
        ),
      ),

    addReference: (ref) => {
      // Serialize against the reaper on the SAME recipe (advisory-xact lock),
      // then dedup-insert. NULLS NOT DISTINCT unique makes a re-add a no-op.
      run(
        [
          { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [ref.recipeKey] },
          {
            text: `INSERT INTO ${T("environment_layer_references")}
                (id, recipe_key, org_id, holder_package_name, holder_template_id, holder_version_id)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (recipe_key, org_id, holder_package_name, holder_template_id, holder_version_id)
              DO NOTHING`,
            values: [
              `env-ref:${crypto.randomUUID()}`,
              ref.recipeKey,
              ref.orgId,
              ref.holder.packageName ?? null,
              ref.holder.templateId ?? null,
              ref.holder.versionId ?? null,
            ],
          },
        ],
        true,
      );
      return Promise.resolve();
    },

    removeReferences: (match: ReferenceMatch) => {
      const clauses: string[] = [];
      const values: unknown[] = [];
      const add = (col: string, val: string) => {
        values.push(val);
        clauses.push(`${col} = $${values.length}`);
      };
      if (match.recipeKey !== undefined) add("recipe_key", match.recipeKey);
      if (match.orgId !== undefined) add("org_id", match.orgId);
      if (match.packageName !== undefined) add("holder_package_name", match.packageName);
      if (match.templateId !== undefined) add("holder_template_id", match.templateId);
      if (match.versionId !== undefined) add("holder_version_id", match.versionId);
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      const result = run([
        {
          text: `DELETE FROM ${T("environment_layer_references")}${where} RETURNING id`,
          values,
        },
      ]);
      return Promise.resolve(result[0].rowCount);
    },

    countReferences: (recipeKey) =>
      Promise.resolve(
        Number(
          run([
            {
              text: `SELECT count(*)::int AS n FROM ${T("environment_layer_references")} WHERE recipe_key = $1`,
              values: [recipeKey],
            },
          ])[0].rows[0]?.n ?? 0,
        ),
      ),

    listReapableLayers: (cutoffMs) =>
      Promise.resolve(
        run([
          {
            text: `SELECT l.recipe_key, l.partition, l.image_ref
                FROM ${T("environment_layers")} l
                WHERE l.last_used_at_ms < $1
                  AND NOT EXISTS (
                    SELECT 1 FROM ${T("environment_layer_references")} r
                    WHERE r.recipe_key = l.recipe_key
                  )`,
            values: [cutoffMs],
          },
        ])[0].rows.map((row) => ({
          recipeKey: String(row.recipe_key),
          partition: String(row.partition) as EnvironmentLayerPartition,
          imageRef: String(row.image_ref),
        })),
      ),

    reapCandidateUnderLock: (recipeKey, partition, cutoffMs) => {
      // Under the advisory lock, the `NOT EXISTS` reference re-check is fenced
      // against a concurrent addReference (which holds the SAME lock), so the
      // delete-then-commit is race-free. `RETURNING image_digest` yields the
      // IMMUTABLE image ID the caller rmis AFTER commit — never the mutable
      // content-addressed tag (a post-commit rebuild re-points the tag; removing
      // by the old digest never touches the rebuilt image).
      const result = run(
        [
          { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [recipeKey] },
          {
            text: `DELETE FROM ${T("environment_layers")}
                WHERE recipe_key = $1 AND partition = $2 AND last_used_at_ms < $3
                  AND NOT EXISTS (
                    SELECT 1 FROM ${T("environment_layer_references")} r
                    WHERE r.recipe_key = $1
                  )
                RETURNING image_digest`,
            values: [recipeKey, partition, cutoffMs],
          },
        ],
        true,
      );
      const deletedRow = result[1]?.rows?.[0];
      if (!deletedRow) return Promise.resolve(null);
      return Promise.resolve({ removedImageDigest: String(deletedRow.image_digest) });
    },
  };
}
