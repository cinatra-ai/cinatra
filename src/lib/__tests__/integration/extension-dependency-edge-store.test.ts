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

  it("#1040 S3: write-time resolution prefers the CONSTRAINT-SATISFYING sibling version (side-by-side), default-first only among satisfying candidates", async () => {
    const { installExtensionManifest, recordExtensionDependencies } = await import(
      "@cinatra-ai/extensions/lifecycle-primitive"
    );
    const { readInstalledExtensionById, listInstalledExtensions } = await import(
      "@cinatra-ai/extensions/canonical-store"
    );
    const { computeClosure, makeScopedManifestLookup } = await import(
      "@cinatra-ai/extensions/dependency-closure"
    );

    // The acceptance topology: D DEFAULT at 0.1.4, D side-by-side (non-default)
    // at 0.2.0, both platform-scoped.
    const dDefault = await installExtensionManifest(
      {
        id: "iext_t_sbs_D_default",
        packageName: "@sbs-test/D",
        ownerLevel: "platform",
        ownerId: null,
        organizationId: null,
        kind: "skill",
        source: VSRC("@sbs-test/D", "0.1.4"),
        requiredInProd: false,
        dependencies: [],
        manifestHash: null,
      },
      actor,
    );
    const dSide = await installExtensionManifest(
      {
        id: "iext_t_sbs_D_020",
        packageName: "@sbs-test/D",
        ownerLevel: "platform",
        ownerId: null,
        organizationId: null,
        kind: "skill",
        source: VSRC("@sbs-test/D", "0.2.0"),
        requiredInProd: false,
        dependencies: [],
        manifestHash: null,
        version: "0.2.0",
        isDefault: false,
      },
      actor,
    );
    expect(dDefault.version).toBe("0.1.4");
    expect(dSide.isDefault).toBe(false);

    // C requires D@^0.2.0 — its edge must bind the SIDE-BY-SIDE row, even
    // though the default (0.1.4) would win the pre-S3 default-first rule.
    const c = await installExtensionManifest(
      {
        id: "iext_t_sbs_C",
        packageName: "@sbs-test/C",
        ownerLevel: "platform",
        ownerId: null,
        organizationId: null,
        kind: "skill",
        source: VSRC("@sbs-test/C", "1.0.0"),
        requiredInProd: false,
        dependencies: [],
        manifestHash: null,
      },
      actor,
    );
    await recordExtensionDependencies(
      c.id,
      [
        {
          packageName: "@sbs-test/D",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "^0.2.0" },
          requirement: "required",
        },
      ],
      actor,
    );
    const cRead = (await readInstalledExtensionById(c.id))!;
    expect(cRead.dependencyEdges![0]!.resolvedInstallId).toBe(dSide.id);

    // A requires D@^0.1.0 — its edge binds the DEFAULT row (satisfying +
    // default-first among satisfying candidates).
    const a2 = await installExtensionManifest(
      {
        id: "iext_t_sbs_A",
        packageName: "@sbs-test/A",
        ownerLevel: "platform",
        ownerId: null,
        organizationId: null,
        kind: "skill",
        source: VSRC("@sbs-test/A", "1.0.0"),
        requiredInProd: false,
        dependencies: [],
        manifestHash: null,
      },
      actor,
    );
    await recordExtensionDependencies(
      a2.id,
      [
        {
          packageName: "@sbs-test/D",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "^0.1.0" },
          requirement: "required",
        },
      ],
      actor,
    );
    const aRead = (await readInstalledExtensionById(a2.id))!;
    expect(aRead.dependencyEdges![0]!.resolvedInstallId).toBe(dDefault.id);

    // Closure-gate green over the snapshot: each dependent validates against
    // ITS pinned row — no range violation despite two live versions of D.
    const snapshot = await listInstalledExtensions({});
    for (const dependent of [cRead, aRead]) {
      const result = computeClosure(
        dependent,
        makeScopedManifestLookup(snapshot, dependent.organizationId),
        snapshot,
      );
      expect(result.rangeViolations).toEqual([]);
      expect(result.missingRequired).toEqual([]);
    }
  });

  it("#1040 S3: the guarded side-by-side teardown refuses while a LIVE dependent's edge resolves to the row, then deletes once unbound", async () => {
    const { recordExtensionDependencies, deleteSideBySideVersionRow } = await import(
      "@cinatra-ai/extensions/lifecycle-primitive"
    );
    const { readInstalledExtensionById } = await import(
      "@cinatra-ai/extensions/canonical-store"
    );

    // Reuses the acceptance topology from the previous case: C (live) is
    // resolved-edge-bound to the side-by-side row iext_t_sbs_D_020.
    await expect(deleteSideBySideVersionRow("iext_t_sbs_D_020")).rejects.toThrow(
      /live dependent\(s\) still resolve to 'iext_t_sbs_D_020'/,
    );
    await expect(deleteSideBySideVersionRow("iext_t_sbs_D_020")).rejects.toThrow(/@sbs-test\/C/);
    expect(await readInstalledExtensionById("iext_t_sbs_D_020")).not.toBeNull();

    // codex round-2: even an ARCHIVED dependent's edge refuses (a concurrent
    // restore could re-activate it; status transitions never lock the target).
    const { transitionExtensionLifecycle } = await import(
      "@cinatra-ai/extensions/lifecycle-primitive"
    );
    await transitionExtensionLifecycle("iext_t_sbs_C", "archive", actor);
    await expect(deleteSideBySideVersionRow("iext_t_sbs_D_020")).rejects.toThrow(/@sbs-test\/C/);
    await transitionExtensionLifecycle("iext_t_sbs_C", "activate", actor);

    // Unbind C (compensation removes dependents first), then teardown succeeds.
    await recordExtensionDependencies("iext_t_sbs_C", [], actor);
    await deleteSideBySideVersionRow("iext_t_sbs_D_020");
    expect(await readInstalledExtensionById("iext_t_sbs_D_020")).toBeNull();
    // The DEFAULT row and the other dependent are untouched.
    expect((await readInstalledExtensionById("iext_t_sbs_D_default"))?.status).toBe("active");
    expect((await readInstalledExtensionById("iext_t_sbs_A"))?.status).toBe("active");
    // Idempotent re-delete is a no-op.
    await deleteSideBySideVersionRow("iext_t_sbs_D_020");

    // Guard regression: the DEFAULT row itself is refused.
    await expect(deleteSideBySideVersionRow("iext_t_sbs_D_default")).rejects.toThrow(
      /is the DEFAULT row/,
    );
  });
});
