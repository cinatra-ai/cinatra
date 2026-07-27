// Bootstrap DDL for the durable L1 environment-layer store (exec-plane S3 A2,
// cinatra#1708; epic #1705) — two tables: `environment_layers` (content-
// addressed cache entries) and `environment_layer_references` (org-scoped
// recipe→layer references).
//
// WHY DURABLE: the exec-plane `EnvironmentLayerCache` runs over an injectable
// `EnvironmentLayerStore`. The in-memory implementation is process-local, so
// GC/teardown decisions taken in one process are invisible to another. The
// durable Postgres store makes the cache CROSS-PROCESS: a later process reuses
// an earlier build (a cache HIT), and the retention GC / lifecycle reference
// drops are one shared source of truth. This is the precondition for the S3
// GC/teardown acceptance criteria (AC1 reuse, AC3/AC6 lifecycle references).
//
// CONSTRAINT MODEL the DB itself enforces:
//   - environment_layers_recipe_partition_uniq — UNIQUE (recipe_key, partition).
//     The SAME recipe may exist as an instance-shared layer AND as one-or-more
//     org-partitioned layers (private packages); one org's UPSERT must never
//     clobber another's. `partition` is text NOT NULL (the internal type is
//     `"instance" | org:${string}` — never null; `'instance'` is the shared
//     sentinel), so a nullable-column duplicate-row hazard cannot arise.
//   - environment_layer_references_dedup_uniq — UNIQUE NULLS NOT DISTINCT over
//     (recipe_key, org_id, holder_package_name, holder_template_id,
//     holder_version_id). The holder columns are nullable (a packaged agent
//     leaves template/version null; a project agent leaves package null); NULLS
//     NOT DISTINCT (PG15+) makes two refs that both leave a holder column NULL
//     COLLIDE, reproducing the in-memory `addReference` dedup (which treats
//     `undefined === undefined` as equal). Without it, a nullable-tuple UNIQUE
//     would treat every NULL as distinct and let duplicate refs accumulate.
//
// NO foreign keys ON PURPOSE (the artifact_uninstall_operations / dispatch-
// ledger precedent): durable references outlive the referencing install rows;
// the recipe/holder ids are validated at WRITE time (a reference is only added
// for a layer the builder just produced), not FK-enforced at rest.
//
// A pure string builder with ZERO imports — a synchronous leaf safe for
// drizzle-store.ts's synchronous composition (same contract as
// publication-operation-schema.ts / skill-lifecycle-schema.ts). On an EXISTING
// deployment the tables arrive via migration core__0057; on a fresh bootstrap
// they ship directly here — the two paths converge (idempotent DDL).

export function environmentLayerStoreSchemaQueries(
  schemaName: string,
): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."environment_layers" (
  id                  text PRIMARY KEY,
  recipe_key          text NOT NULL,
  spec_key            text NOT NULL,
  image_ref           text NOT NULL,
  image_digest        text NOT NULL,
  partition           text NOT NULL,
  provenance          jsonb NOT NULL,
  built_at_ms         bigint NOT NULL,
  last_used_at_ms     bigint NOT NULL
)`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS environment_layers_recipe_partition_uniq ON "${q}"."environment_layers" (recipe_key, partition)`,
    },
    {
      // Builder fast path: nominate candidates by spec key before the full
      // recipe-key verify.
      text: `CREATE INDEX IF NOT EXISTS environment_layers_spec_key_idx ON "${q}"."environment_layers" (spec_key)`,
    },
    {
      // Retention GC scan seam: sweep unused layers oldest-first.
      text: `CREATE INDEX IF NOT EXISTS environment_layers_last_used_idx ON "${q}"."environment_layers" (last_used_at_ms)`,
    },
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."environment_layer_references" (
  id                    text PRIMARY KEY,
  recipe_key            text NOT NULL,
  org_id                text NOT NULL,
  holder_package_name   text,
  holder_template_id    text,
  holder_version_id     text
)`,
    },
    {
      // Dedup over the nullable holder tuple — NULLS NOT DISTINCT so two refs
      // that both leave a holder column NULL still collide (PG15+).
      text: `CREATE UNIQUE INDEX IF NOT EXISTS environment_layer_references_dedup_uniq ON "${q}"."environment_layer_references" (recipe_key, org_id, holder_package_name, holder_template_id, holder_version_id) NULLS NOT DISTINCT`,
    },
    {
      // countReferences(recipe_key) — one indexed `SELECT count(*)`.
      text: `CREATE INDEX IF NOT EXISTS environment_layer_references_recipe_idx ON "${q}"."environment_layer_references" (recipe_key)`,
    },
    {
      // Hard-removal / archive reference drops filter by holder package + org.
      text: `CREATE INDEX IF NOT EXISTS environment_layer_references_holder_idx ON "${q}"."environment_layer_references" (holder_package_name, org_id)`,
    },
  ];
}

/**
 * Bootstrap DDL for the PER-AGENT execution config (exec-plane S3 slice B,
 * cinatra#1708) — the two additive `agent_templates` columns the per-agent
 * configuration surface writes:
 *
 *   - `execution_environment` (text, JSON-as-text — the compiled_plan /
 *     gated_steps / lifecycle_config convention already used on that table):
 *     the PROJECT-agent authoring surface for the L1 declared environment. It
 *     is read through the SAME fail-closed `parseExecutionEnvironment` that
 *     packaged-agent manifests go through, so both authoring surfaces resolve
 *     to one internal type and two same-recipe agents share one cache entry.
 *   - `execution_enabled` (boolean, NULLABLE — three-valued ON PURPOSE): NULL
 *     inherits the instance/org posture (epic D4's default-on availability),
 *     true/false are explicit per-agent decisions. A DEFAULT would silently
 *     re-decide the posture for every pre-slice-B row.
 *
 * Lives in this execution-slice leaf (rather than inline in drizzle-store.ts,
 * a tracked file-size bottleneck) alongside the layer-store DDL: one place for
 * the execution slice's bootstrap schema. On an EXISTING deployment the columns
 * arrive via migration core__0085; on a fresh bootstrap they ship here — the
 * two paths converge (idempotent `ADD COLUMN IF NOT EXISTS`).
 */
export function agentExecutionConfigSchemaQueries(
  schemaName: string,
): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    {
      text: `ALTER TABLE "${q}"."agent_templates" ADD COLUMN IF NOT EXISTS execution_environment text, ADD COLUMN IF NOT EXISTS execution_enabled boolean`,
    },
  ];
}
