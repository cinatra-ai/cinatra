import { describe, expect, it } from "vitest";
import {
  OBJECTS_WRITE_COLUMNS,
  OBJECTS_UPSERT_CHANGE_COLUMNS,
  buildObjectsWithOutboxQuery,
} from "@/lib/objects-store";

// The shared objects+outbox single-CTE builder (cinatra#1894 tier-b). These are
// DB-FREE contract tests: the GOLDEN insert string pins behaviour-preservation
// for the extracted createSemanticArtifact hot path; the upsert assertions pin
// the delta-D3 change-gate. The DB-backed column-parity proof (OBJECTS_WRITE_
// COLUMNS == the live objects write columns) rides the substrate kill-tests.

const sampleInput = {
  id: "art-1",
  type: "@cinatra-ai/dashboard-artifact:dashboard",
  parentId: null,
  parentType: null,
  dataJson: JSON.stringify({ dashboardId: "art-1" }),
  createdBy: "u-1",
  orgId: "org-1",
  source: "route",
  ownerLevel: "user",
  ownerId: "u-1",
  visibility: "private",
  projectId: null,
};

describe("objects-outbox-cte — shared column set", () => {
  it("pins the ordered objects write column set", () => {
    expect([...OBJECTS_WRITE_COLUMNS]).toEqual([
      "id",
      "type",
      "parent_id",
      "parent_type",
      "data",
      "created_by",
      "org_id",
      "source",
      "graphiti_sync_status",
      "version",
      "owner_level",
      "owner_id",
      "visibility",
      "project_id",
    ]);
  });

  it("the INSERT column list in BOTH modes is exactly OBJECTS_WRITE_COLUMNS in order", () => {
    for (const mode of ["insert", "upsert"] as const) {
      const { text } = buildObjectsWithOutboxQuery("cinatra", mode, sampleInput);
      const cols = text
        .slice(text.indexOf('."objects"'))
        .match(/\(([^)]*)\)/)?.[1]
        .split(",")
        .map((c) => c.trim().replace(/\s+/g, " "))
        // collapse the multi-line column list into single tokens
        .join(",")
        .split(",")
        .map((c) => c.trim());
      expect(cols).toEqual([...OBJECTS_WRITE_COLUMNS]);
    }
  });
});

describe("objects-outbox-cte — insert mode (golden, behaviour-preserving)", () => {
  const EXPECTED_INSERT = `WITH upserted AS (
  INSERT INTO "cinatra"."objects"
    (id, type, parent_id, parent_type, data, created_by, org_id, source,
     graphiti_sync_status, version, owner_level, owner_id, visibility,
     project_id)
  VALUES ($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::text, $7::text, 'route',
          'pending', 1, $8::text, $9::text, $10::text,
          $11::text)
  RETURNING id, version, org_id
)
INSERT INTO "cinatra"."graphiti_projection_outbox"
  (id, object_id, object_version, org_id, operation, payload_hash, status, attempts)
SELECT gen_random_uuid()::text, upserted.id, upserted.version, upserted.org_id,
       'upsert', NULL, 'pending', 0
FROM upserted`;

  it("reproduces the extracted createSemanticArtifact objects+outbox SQL verbatim", () => {
    const { text, values } = buildObjectsWithOutboxQuery("cinatra", "insert", sampleInput);
    expect(text).toBe(EXPECTED_INSERT);
    expect(values).toEqual([
      "art-1",
      "@cinatra-ai/dashboard-artifact:dashboard",
      null,
      null,
      JSON.stringify({ dashboardId: "art-1" }),
      "u-1",
      "org-1",
      "user",
      "u-1",
      "private",
      null,
    ]);
  });

  it("escapes an embedded quote in the schema name", () => {
    const { text } = buildObjectsWithOutboxQuery('cin"atra', "insert", sampleInput);
    expect(text).toContain('"cin""atra"."objects"');
  });

  it("is a plain INSERT (no ON CONFLICT) so a PK collision rolls back", () => {
    const { text } = buildObjectsWithOutboxQuery("cinatra", "insert", sampleInput);
    expect(text).not.toContain("ON CONFLICT");
  });
});

describe("objects-outbox-cte — upsert mode (twin, delta D3 gate)", () => {
  it("is an ON CONFLICT (id) DO UPDATE with a no-op change-gate + resurrection", () => {
    const { text } = buildObjectsWithOutboxQuery("cinatra", "upsert", sampleInput);
    expect(text).toContain("ON CONFLICT (id) DO UPDATE SET");
    // version bumps off the existing row.
    expect(text).toContain(`version = COALESCE("cinatra"."objects".version, 0) + 1`);
    // resurrection: a tombstoned row is un-deleted on re-upsert.
    expect(text).toContain("deleted_at = NULL");
    // the change-gate compares every scope-axis column + data + tombstone flip.
    for (const col of OBJECTS_UPSERT_CHANGE_COLUMNS) {
      expect(text).toContain(`"cinatra"."objects".${col} IS DISTINCT FROM EXCLUDED.${col}`);
    }
    expect(text).toContain(`"cinatra"."objects".deleted_at IS NOT NULL`);
  });

  it("keeps the SAME outbox tail (outbox fires only FROM upserted)", () => {
    const { text } = buildObjectsWithOutboxQuery("cinatra", "upsert", sampleInput);
    expect(text).toContain(
      `INSERT INTO "cinatra"."graphiti_projection_outbox"`,
    );
    expect(text.trimEnd().endsWith("FROM upserted")).toBe(true);
  });

  it("carries the cross-tenant org guard", () => {
    const { text } = buildObjectsWithOutboxQuery("cinatra", "upsert", sampleInput);
    expect(text).toContain(`"cinatra"."objects".org_id = EXCLUDED.org_id`);
    expect(text).toContain(`"cinatra"."objects".org_id IS NULL`);
    expect(text).toContain(`EXCLUDED.org_id IS NULL`);
  });
});

describe("objects-outbox-cte — source literal safety", () => {
  it("inlines a valid twin source tag", () => {
    const { text } = buildObjectsWithOutboxQuery("cinatra", "upsert", {
      ...sampleInput,
      source: "dashboards-twin",
    });
    expect(text).toContain("'dashboards-twin'");
  });

  it("throws on an unsafe source tag (never a bound-injection vector)", () => {
    expect(() =>
      buildObjectsWithOutboxQuery("cinatra", "insert", {
        ...sampleInput,
        source: "route'); DROP TABLE objects;--",
      }),
    ).toThrow(/invalid source tag/);
  });
});
