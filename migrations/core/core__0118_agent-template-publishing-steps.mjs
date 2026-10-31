// core__0118 — the publishing-step declaration on `agent_templates`
// (cinatra#4150). The operator-upgrade twin of the fresh-install bootstrap DDL
// (`agentTemplateRunGateSchemaQueries` in src/lib/extension-grant-schema.ts,
// spread into `buildCreateStoreSchemaQueries`), added in the SAME change — the
// core__0091 / core__0101 precedent.
//
// ONE additive nullable column on `agent_templates`:
//
//   - `publishing_steps` (text, JSON-as-text like `gated_steps`): the ids of
//     the flow nodes the compiled OAS document declares
//     `metadata.cinatra.publishes: true`. Written by every install and
//     recompile writer from the compiler's `publishingSteps`. null = a row
//     compiled before this column existed.
//
// No backfill, no default, no constraint change: every existing row reads
// NULL. A legacy row cannot declare the flag (the key is new, so every pack
// that declares it is compiled by a host that writes this column). The
// schema-migration gate classifies this NON-destructive.
//
// SEQ 0118 — 0113 is the highest sequence on main at authoring time; 0114, 0115,
// 0116 and 0117 are claimed by other open changes. A concurrent change may land a
// sequence first, in which case a rename-only renumber is normal.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const agentTemplatePublishingStepsDdlSql = `
  ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS publishing_steps text;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(agentTemplatePublishingStepsDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the added column and the persisted declaration with it.
  pgm.sql(`
    ALTER TABLE agent_templates DROP COLUMN IF EXISTS publishing_steps;
  `);
}
