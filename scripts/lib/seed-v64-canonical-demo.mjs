// Canonical-extension demo fixtures (cinatra.installed_extension +
// extension_dependency_edge) for the ACME demo seed — cinatra#1238.
//
// EXTRACTED from scripts/seed.mjs so the collision/adoption semantics are
// unit-testable against a real Postgres schema (the monolithic script cannot
// be imported piecemeal). Schema-parameterized + q-injected: the runtime seed
// calls it with schema "cinatra" and the shared pool's query fn; the DB test
// calls it with a per-test schema and a pg Client.
//
// ADOPT-NOT-SHADOW (the #1238 live-acceptance fix):
//   The two PLATFORM rows (code-reviewer-agent, assistant-skills) share their
//   identity (owner_level=platform, owner_id='__platform__', package_name) with
//   the REAL bundled installs that land at boot with is_default=true. Claiming
//   is_default=true again collides on installed_extension_one_default_platform_idx
//   (one default per platform package) and the old `INSERT … ON CONFLICT DO
//   NOTHING` SILENTLY skipped the row — then the dependency edge resolved its
//   target from the IN-MEMORY row array (blind to the skip) and pointed at a
//   never-inserted id → FK 23503 → the whole seed aborted mid-write.
//
//   The fix has two halves:
//     1. Before inserting a demo row, if a DEFAULT install already owns this
//        identity scope, DO NOT insert a competing shadow — ADOPT the real one.
//     2. Resolve every dependency edge's target from the DATABASE (the store's
//        canonical write-time rule), so it binds to whichever install actually
//        owns the package — the real bundled install when present, else the
//        demo's own seeded row. Never an in-memory id that may not exist.

const PLATFORM_SENTINEL = "__platform__";

/** Schema-qualified, double-quote-safe table identifier. */
function tbl(schema, table) {
  return `"${schema.replaceAll('"', '""')}"."${table}"`;
}

/**
 * Seed the canonical-extension demo fixtures.
 *
 * @param {object} args
 * @param {(sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>} args.q
 *   Query runner (the seed's shared pool.query, or a pg Client.query in tests).
 * @param {string} [args.schema="cinatra"]  Target schema (quoted internally).
 * @param {string} [args.orgAcmeId="org-acme-group"]  The acme-group org id.
 * @param {(message: string) => void} [args.log=console.log]  Progress logger.
 */
export async function seedV64CanonicalDemo({
  q,
  schema = "cinatra",
  orgAcmeId = "org-acme-group",
  log = console.log,
} = {}) {
  const installed = tbl(schema, "installed_extension");
  const edges = tbl(schema, "extension_dependency_edge");
  log("Seeding canonical-extension demo fixtures (cinatra.installed_extension)…");

  // Idempotent wipe by seed marker (manifest_hash prefix). NEVER touches the
  // real bundled installs (their manifest_hash is not `seed-v64-%`).
  await q(`DELETE FROM ${installed} WHERE manifest_hash LIKE 'seed-v64-%'`);

  const orgAcme = orgAcmeId;

  const rows = [
    {
      id: "iext_seed-v64-01",
      pkg: "@cinatra-ai/code-reviewer-agent",
      ownerLevel: "platform",
      ownerId: PLATFORM_SENTINEL,
      orgId: null,
      kind: "agent",
      status: "locked",
      source: { type: "verdaccio", registryUrl: "http://localhost:4873", packageName: "@cinatra-ai/code-reviewer-agent", version: "1.2.3", integrity: "sha512-seed-v64-01" },
      requiredInProd: true,
      deps: [],
    },
    {
      id: "iext_seed-v64-02",
      pkg: "@cinatra-ai/demo-research-skill",
      ownerLevel: "organization",
      ownerId: orgAcme,
      orgId: orgAcme,
      kind: "skill",
      status: "active",
      source: { type: "github", repo: "acme-demo.invalid/demo-research-skill", ref: "v0.3.1", resolvedSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
      requiredInProd: false,
      deps: [],
    },
    {
      id: "iext_seed-v64-03",
      pkg: "@cinatra-ai/demo-legacy-connector",
      ownerLevel: "organization",
      ownerId: orgAcme,
      orgId: orgAcme,
      kind: "connector",
      status: "archived",
      source: { type: "verdaccio", registryUrl: "http://localhost:4873", packageName: "@cinatra-ai/demo-legacy-connector", version: "0.9.0", integrity: "sha512-seed-v64-03" },
      requiredInProd: false,
      deps: [],
    },
    {
      id: "iext_seed-v64-04",
      pkg: "@cinatra-ai/demo-local-artifact",
      ownerLevel: "organization",
      ownerId: orgAcme,
      orgId: orgAcme,
      kind: "artifact",
      status: "active",
      source: { type: "local", path: "/opt/cinatra/extensions/demo-local-artifact", resolvedCommitOrTreeHash: "f0e1d2c3b4a5968778695a4b3c2d1e0f12345678" },
      requiredInProd: false,
      deps: [],
    },
    {
      id: "iext_seed-v64-06",
      pkg: "@cinatra-ai/demo-dependent-agent",
      ownerLevel: "organization",
      ownerId: orgAcme,
      orgId: orgAcme,
      kind: "agent",
      status: "active",
      source: { type: "verdaccio", registryUrl: "http://localhost:4873", packageName: "@cinatra-ai/demo-dependent-agent", version: "0.4.0", integrity: "sha512-seed-v64-06" },
      requiredInProd: false,
      // Declares a REQUIRED runtime dep on the code-reviewer-agent — exercises
      // the assertCanonicalArchiveClosure block when an admin tries to archive
      // it: this dependent makes that archive refuse. The edge now binds to the
      // REAL bundled code-reviewer-agent install (adopted), so the demo protects
      // the actual platform agent rather than a shadow fixture. The constraint is
      // the WILDCARD `*` (not a pinned `^1.0.0`): this fixture exists ONLY to
      // exercise archive-closure, and the adopted bundled install can carry ANY
      // version — a pinned range that the bundled version fails to satisfy would
      // resolve to a non-satisfying row (canonical-store resolveDeclaredEdges) and
      // poison later update-plan checks.
      deps: [{ packageName: "@cinatra-ai/code-reviewer-agent", edgeType: "runtime", versionConstraint: { kind: "semver-range", range: "*" }, requirement: "required" }],
    },
    {
      id: "iext_seed-v64-07",
      pkg: "@cinatra-ai/assistant-skills",
      ownerLevel: "platform",
      ownerId: PLATFORM_SENTINEL,
      orgId: null,
      kind: "skill",
      status: "locked",
      source: { type: "verdaccio", registryUrl: "http://localhost:4873", packageName: "@cinatra-ai/assistant-skills", version: "0.2.1", integrity: "sha512-seed-v64-07" },
      requiredInProd: true,
      deps: [],
    },
    {
      id: "iext_seed-v64-08",
      pkg: "@cinatra-ai/demo-archived-from-github",
      ownerLevel: "organization",
      ownerId: orgAcme,
      orgId: orgAcme,
      kind: "agent",
      status: "archived",
      source: { type: "github", repo: "acme-demo.invalid/demo-archived", ref: "v0.1.0", resolvedSha: "1122334455667788990011223344556677889900" },
      requiredInProd: false,
      deps: [],
    },
  ];

  let inserted = 0;
  let adopted = 0;

  for (const r of rows) {
    // ADOPT-NOT-SHADOW: a real install may already own the DEFAULT slot for this
    // identity (the bundled platform installs land at boot with is_default=true,
    // owner_id='__platform__' — exactly rows 01 & 07's identity). Claiming the
    // default again collides on the one-default partial index; inserting a
    // competing shadow is both impossible and undesirable. If a default already
    // exists at this identity scope, defer to it — the edges below resolve to
    // whatever install owns the package.
    const existingDefault = await q(
      `SELECT id FROM ${installed}
        WHERE owner_level = $1 AND owner_id = $2 AND package_name = $3
          AND organization_id IS NOT DISTINCT FROM $4
          AND is_default = true
        LIMIT 1`,
      [r.ownerLevel, r.ownerId, r.pkg, r.orgId],
    );
    if (existingDefault.rows.length > 0) {
      adopted++;
      log(`  adopting existing install for ${r.pkg} (${r.ownerLevel}) — not shadowing it`);
      continue;
    }

    const res = await q(
      `INSERT INTO ${installed}
         (id, package_name, owner_level, owner_id, organization_id, kind, status,
          source, required_in_prod, manifest_hash, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        r.id,
        r.pkg,
        r.ownerLevel,
        r.ownerId,
        r.orgId,
        r.kind,
        r.status,
        JSON.stringify(r.source),
        r.requiredInProd,
        `seed-v64-${r.id.split("-").pop()}`,
        // version is NOT NULL since cinatra#1040 S1 (version identity) and has
        // no DB default. Mirror the backfill floor: a source's own version
        // (verdaccio rows carry one) else '0.0.0' (github/local sources).
        r.source?.version ?? "0.0.0",
      ],
    );
    if (res.rows.length > 0) inserted++;
  }

  // Dependency edges are FIRST-CLASS ROWS since cinatra#1040 S2
  // (extension_dependency_edge; the row jsonb column is gone). Resolve + insert
  // each edge in ONE atomic statement that mirrors the core__0025 backfill /
  // canonical-store write-time rule: the edge is inserted ONLY when the dependent
  // row actually EXISTS (`FROM installed dep WHERE dep.id = $2` yields nothing
  // otherwise — the dependent_install_id FK can never be violated), and the
  // target is resolved by a LATERAL against the dependent's OWN org scope:
  // own-org (active|locked) first, then platform, DEFAULT version first, then id.
  // A missing target persists unresolved (resolved_install_id NULL) — the closure
  // gates' name-fallback heals it when the dependency installs later. This ADOPTS
  // the real bundled install when present and never references an in-memory id.
  for (const r of rows) {
    for (const [index, dep] of r.deps.entries()) {
      await q(
        `INSERT INTO ${edges}
           (id, dependent_install_id, declared_package_name, declared_kind, edge_type,
            requirement, version_constraint, declared_index, resolved_install_id, resolution_reason)
         SELECT
           $1, dep.id, $3, $4, $5, $6, $7::jsonb, $8, tgt.id,
           CASE WHEN tgt.id IS NULL THEN NULL
                WHEN tgt.organization_id IS NOT NULL THEN 'seed:org'
                ELSE 'seed:platform' END
         FROM ${installed} dep
         LEFT JOIN LATERAL (
           SELECT t.id, t.organization_id
           FROM ${installed} t
           WHERE t.package_name = $3
             AND t.status IN ('active', 'locked')
             AND (t.organization_id IS NULL OR t.organization_id = dep.organization_id)
           ORDER BY (t.organization_id IS NOT NULL) DESC, t.is_default DESC, t.id
           LIMIT 1
         ) tgt ON TRUE
         WHERE dep.id = $2
         ON CONFLICT DO NOTHING`,
        [
          `iede_${r.id.replace(/^iext_/, "")}-${index}`,
          r.id,
          dep.packageName,
          dep.kind ?? null,
          dep.edgeType,
          dep.requirement,
          JSON.stringify(dep.versionConstraint),
          index,
        ],
      );
    }
  }

  log(
    `  installed_extension demo rows: ${inserted} inserted, ${adopted} adopted ` +
      `(3 statuses × 3 source types × 5 kinds + 1 dep edge)`,
  );
}
