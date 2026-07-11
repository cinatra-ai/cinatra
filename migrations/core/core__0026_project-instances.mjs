// core__0026 — project-instance registry (cinatra#1032 deliverable 3).
//
// Adds `project_instances`: one row per instantiated PM project, keyed
// (org_id, project_ref). The row is the STICKY, fail-closed binding record the
// install/kind-gate enforcement wiring persists at project instantiation:
//
//   - template_package / template_id — which installed agent package's
//     `cinatra/project-template.json` this project was instantiated from (the
//     template's stable id is pinned so a later dispatch can refuse a template
//     swap under the same project ref).
//   - template_digest — the finalized-install digest the template was read
//     from at instantiation. PROVENANCE, deliberately NOT a dispatch gate: the
//     merged dispatch semantics allow a template to evolve mid-project (the
//     anchor-repair rule; a binding change requires a new action version and
//     the ledger's immutable attempt identity refuses drift under the same
//     one) — the digest makes content drift AUDITABLE and is the operand the
//     future instantiation-time rebinding/migration valve will verify against.
//   - pm_agent_package — the PM SEAT: the project-management agent (the
//     pm-work-store capability binding, proven at instantiation) that owns this
//     project's template at runtime. Only this agent's tick runs may dispatch
//     workers for the project.
//   - provider_id / provider_mode — the PM work-store provider chosen ONCE at
//     instantiation (mode 'configured' = an explicitly configured provider won;
//     'auto' = exactly one connected provider existed). Selection fails closed
//     on none/several; the persisted value is the ONLY provider any runtime
//     path may use — a project can never silently migrate between PM tools.
//   - project_id — nullable cinatra project refinement (mirrors
//     agent_runs.project_id semantics; the PM project scope is a PM-tool
//     concept and need not be a cinatra project).
//
// NUMBER CLAIM (recorded at claim time): core__0024 is the highest number on
// main; open PR #1304 claims core__0023 and open PR #1331 claims core__0025 —
// re-verified via an open-PR scan when this module was authored, so 0026 is
// the next free number.
//
// ADDITIVE change (one brand-new table, see migrations/README.md "Additive"):
// it rides the idempotent bootstrap DDL (`projectInstancesSchemaQueries`,
// spread into buildCreateStoreSchemaQueries in the SAME PR), so an artifact is
// NOT required. This module ships anyway — the core__0007/core__0024 precedent
// — to keep the fresh-bootstrap and operator-upgrade paths aligned and give
// the table a ledgered row; it is pure CREATE … IF NOT EXISTS, so it is a
// no-op on a bootstrap-seeded schema and ledger-faked on a fresh install.
// Unqualified names ride the runner's search_path (the app schema).

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`CREATE TABLE IF NOT EXISTS project_instances (
    org_id text NOT NULL,
    project_ref text NOT NULL,
    project_id text,
    template_package text NOT NULL,
    template_id text NOT NULL,
    template_digest text NOT NULL,
    pm_agent_package text NOT NULL,
    provider_id text NOT NULL,
    provider_mode text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, project_ref),
    CONSTRAINT project_instances_provider_mode_check
      CHECK (provider_mode IN ('configured', 'auto'))
  );`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: the table is a fresh #1032 addition, so down() restores the
  // exact pre-0026 shape on any lineage.
  pgm.sql(`DROP TABLE IF EXISTS project_instances;`);
}
