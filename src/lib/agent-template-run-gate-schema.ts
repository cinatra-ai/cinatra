// agent_templates run-gate + artifact-binding columns — the
// buildCreateStoreSchemaQueries leaf for that one cohesive column group,
// extracted from drizzle-store.ts (cinatra#3208 file-size ratchet) on the same
// seam idiom as projectInstancesSchemaQueries in ./extension-grant-schema.
// Pure strings, no db handle. The statements are returned in their original
// order and spread back in at the position they have always held, so the
// bootstrap DDL sequence is byte-identical.
export function agentTemplateRunGateSchemaQueries(schemaName: string): { text: string }[] {
  return [
    // trigger_mode + gated_steps on agent_templates (read by execution.ts and the Trigger tab UI). has_artifact_bindings (cinatra#2498) is the locally-persisted binding-presence authority the run-completion materializer consults BEFORE any registry read, so a registry outage only fails a run whose package declares bindings; NULLABLE — null (legacy, no backfill) reads exactly like the pre-#2498 fail-closed posture. Full rationale on the column in packages/agents/src/schema.ts; operator-upgrade twin in migrations/core/core__0091.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS trigger_mode text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS gated_steps text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS has_artifact_bindings boolean` },
    // artifact_bindings (cinatra#3208): the EXECUTED artifact-binding declaration
    // as JSON-as-text — the normalized bindings the compile that produced this
    // template version found plus the typed produces refs they were validated
    // against. The run-completion materializer reads it INSTEAD of re-reading the
    // package registry, so a run is never materialized against a declaration it
    // did not execute. NULLABLE, three-valued like has_artifact_bindings: null =
    // unknown (legacy row / no readable sibling manifest) and falls through to the
    // pre-#3208 registry read. Operator-upgrade twin in migrations/core/core__0101.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS artifact_bindings text` },
  ];
}
