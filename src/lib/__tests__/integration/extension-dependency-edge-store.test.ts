/**
 * DB-integration proof for the extension_dependency_edge store path
 * (cinatra#1040 S2): the canonical store persists declared edges as
 * first-class rows with WRITE-TIME RESOLUTION, hydrates every read with
 * `dependencyEdges` + the derived `dependencies` projection, and REPLACES a
 * dependent's edges on re-record. Exercises ONLY the public primitive
 * (installExtensionManifest / recordExtensionDependencies) + public readers —
 * never the `_internal*` writers.
 *
 * Runs in the DB tier (CINATRA_DB_INTEGRATION_TESTS=1 + a live
 * SUPABASE_DB_URL); self-skips without a database, like its siblings.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";

import { connect, createTestSchema, dropSchema } from "./_fixture";

const dbUrl = process.env.SUPABASE_DB_URL;
const suite = dbUrl ? describe : describe.skip;

suite("extension_dependency_edge store path (cinatra#1040 S2)", () => {
  let client: Client;
  let schema = "";
  let prevSchemaEnv: string | undefined;

  beforeAll(async () => {
    client = await connect();
    schema = await createTestSchema(client);
    // The canonical store reads SUPABASE_SCHEMA at module load; every store
    // import below is dynamic (after this assignment), pinning all canonical
    // writes to the per-test schema (same pattern as the demote suite).
    prevSchemaEnv = process.env.SUPABASE_SCHEMA;
    process.env.SUPABASE_SCHEMA = schema;
  });

  afterAll(async () => {
    if (prevSchemaEnv === undefined) delete process.env.SUPABASE_SCHEMA;
    else process.env.SUPABASE_SCHEMA = prevSchemaEnv;
    if (schema) await dropSchema(client, schema);
    await client.end();
  });

  const VSRC = (pkg: string, version: string) => ({
    type: "verdaccio" as const,
    registryUrl: "http://localhost:4873",
    packageName: pkg,
    version,
    integrity: "sha512-edge-store-test",
  });

  const actor = { actor: { source: "cli" as const }, reason: "S2 edge-store integration test" };

  it("resolves at write time (own-org row preferred), hydrates reads, and replaces on re-record", async () => {
    const { installExtensionManifest, recordExtensionDependencies } = await import(
      "@cinatra-ai/extensions/lifecycle-primitive"
    );
    const { readInstalledExtensionById, listInstalledExtensions } = await import(
      "@cinatra-ai/extensions/canonical-store"
    );

    // Targets: package D live at BOTH org1 and platform scope — the org
    // dependent's edge must bind the ORG row (scoped:org), never platform's.
    const dPlatform = await installExtensionManifest(
      {
        id: "iext_t_D_platform",
        packageName: "@edge-test/D",
        ownerLevel: "platform",
        ownerId: null,
        organizationId: null,
        kind: "skill",
        source: VSRC("@edge-test/D", "1.2.0"),
        requiredInProd: false,
        dependencies: [],
        manifestHash: null,
      },
      actor,
    );
    const dOrg = await installExtensionManifest(
      {
        id: "iext_t_D_org",
        packageName: "@edge-test/D",
        ownerLevel: "organization",
        ownerId: "org_edge_1",
        organizationId: "org_edge_1",
        kind: "skill",
        source: VSRC("@edge-test/D", "1.4.0"),
        requiredInProd: false,
        dependencies: [],
        manifestHash: null,
      },
      actor,
    );
    expect(dPlatform.dependencyEdges).toEqual([]);

    // Dependent A (org1) — edges recorded at the finalize seam.
    const a = await installExtensionManifest(
      {
        id: "iext_t_A_org",
        packageName: "@edge-test/A",
        ownerLevel: "organization",
        ownerId: "org_edge_1",
        organizationId: "org_edge_1",
        kind: "agent",
        source: VSRC("@edge-test/A", "1.0.0"),
        requiredInProd: false,
        dependencies: [],
        manifestHash: null,
      },
      actor,
    );
    const recorded = await recordExtensionDependencies(
      a.id,
      [
        {
          packageName: "@edge-test/D",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "^1.0.0" },
          requirement: "required",
        },
        {
          packageName: "@edge-test/MISSING",
          kind: "connector",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "*" },
          requirement: "optional",
        },
      ],
      actor,
    );

    // The mutation RETURN is hydrated: write-time resolution bound the
    // DECLARING row's own-org D row, and the missing target persisted
    // unresolved (the gates' name-fallback heals it if installed later).
    expect(recorded.dependencyEdges).toEqual([
      expect.objectContaining({
        packageName: "@edge-test/D",
        resolvedInstallId: dOrg.id,
        resolutionReason: "scoped:org",
      }),
      expect.objectContaining({
        packageName: "@edge-test/MISSING",
        kind: "connector",
        resolvedInstallId: null,
        resolutionReason: null,
      }),
    ]);
    // The derived `dependencies` projection keeps the exact declared shape +
    // order for every pre-S2 consumer.
    expect(recorded.dependencies).toEqual([
      {
        packageName: "@edge-test/D",
        edgeType: "runtime",
        versionConstraint: { kind: "semver-range", range: "^1.0.0" },
        requirement: "required",
      },
      {
        packageName: "@edge-test/MISSING",
        kind: "connector",
        edgeType: "runtime",
        versionConstraint: { kind: "semver-range", range: "*" },
        requirement: "optional",
      },
    ]);

    // Fresh reads hydrate identically (single + list).
    const readBack = await readInstalledExtensionById(a.id);
    expect(readBack?.dependencyEdges).toEqual(recorded.dependencyEdges);
    const listed = await listInstalledExtensions({ organizationId: "org_edge_1" });
    expect(listed.find((r) => r.id === a.id)?.dependencyEdges).toEqual(recorded.dependencyEdges);

    // The raw table carries declared order + positional uniqueness.
    const raw = await client.query(
      `SELECT declared_package_name, declared_index, resolved_install_id, resolution_reason
         FROM "${schema}".extension_dependency_edge
        WHERE dependent_install_id = $1 ORDER BY declared_index`,
      [a.id],
    );
    expect(raw.rows).toEqual([
      {
        declared_package_name: "@edge-test/D",
        declared_index: 0,
        resolved_install_id: dOrg.id,
        resolution_reason: "scoped:org",
      },
      {
        declared_package_name: "@edge-test/MISSING",
        declared_index: 1,
        resolved_install_id: null,
        resolution_reason: null,
      },
    ]);

    // Re-record REPLACES (delete + insert): only the new edge remains, now
    // resolving to the platform row (the dependent is re-scoped to platform
    // fallback because org1 has no live row of P).
    const replaced = await recordExtensionDependencies(
      a.id,
      [
        {
          packageName: "@edge-test/D",
          edgeType: "install-time",
          versionConstraint: { kind: "exact", version: "1.4.0" },
          requirement: "required",
        },
      ],
      actor,
    );
    expect(replaced.dependencyEdges).toHaveLength(1);
    expect(replaced.dependencyEdges![0]).toEqual(
      expect.objectContaining({
        packageName: "@edge-test/D",
        edgeType: "install-time",
        resolvedInstallId: dOrg.id,
        resolutionReason: "scoped:org",
      }),
    );
    const rawAfter = await client.query(
      `SELECT count(*)::int AS n FROM "${schema}".extension_dependency_edge WHERE dependent_install_id = $1`,
      [a.id],
    );
    expect(rawAfter.rows[0].n).toBe(1);
  });

  it("an install row carrying declared dependencies persists resolved edges at insert", async () => {
    const { installExtensionManifest } = await import(
      "@cinatra-ai/extensions/lifecycle-primitive"
    );
    const b = await installExtensionManifest(
      {
        id: "iext_t_B_platform",
        packageName: "@edge-test/B",
        ownerLevel: "platform",
        ownerId: null,
        organizationId: null,
        kind: "agent",
        source: VSRC("@edge-test/B", "1.0.0"),
        requiredInProd: false,
        dependencies: [
          {
            packageName: "@edge-test/D",
            edgeType: "runtime",
            versionConstraint: { kind: "semver-range", range: "^1.0.0" },
            requirement: "required",
          },
        ],
        manifestHash: null,
      },
      actor,
    );
    // A PLATFORM dependent binds only platform rows — never org1's D.
    expect(b.dependencyEdges).toEqual([
      expect.objectContaining({
        packageName: "@edge-test/D",
        resolvedInstallId: "iext_t_D_platform",
        resolutionReason: "scoped:platform",
      }),
    ]);
  });
});
