/**
 * cinatra#1938 — write-registry lockstep: the typed registry stays in step
 * with reality. Source-scans (no imports of heavy modules): the dashboards
 * mutation service's exported writer set must equal the registry's rows for
 * that module; every dashboards row carries the landed twin substrate
 * tables; and the declared FK catalog is reconciled against the actual DDL
 * strings (the live pg_constraint check is the CI-tier integration test).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  ORG_WRITE_REGISTRY,
  DECLARED_FKLESS_ORG_REFERENCES,
  DECLARED_ORG_FK_CASCADES,
} from "../write-registry";

const MUTATION_SERVICE = "packages/dashboards/src/mutation-service.ts";
const DRIZZLE_STORE = "src/lib/drizzle-store.ts";

const READ_ONLY_EXPORTS = new Set(["listDashboardsForEntity", "getEntityDashboard"]);

function exportedAsyncFunctions(file: string): Set<string> {
  const src = readFileSync(file, "utf-8");
  const names = new Set<string>();
  for (const m of src.matchAll(/export async function (\w+)/g)) names.add(m[1]);
  return names;
}

describe("org-write registry lockstep (#1938)", () => {
  it("covers every dashboards writer, exactly (new writers must register)", () => {
    const exported = exportedAsyncFunctions(MUTATION_SERVICE);
    for (const r of READ_ONLY_EXPORTS) exported.delete(r);
    const registered = new Set(
      ORG_WRITE_REGISTRY.filter((e) => e.module === MUTATION_SERVICE).map(
        (e) => e.exportName,
      ),
    );
    expect([...exported].sort()).toEqual([...registered].sort());
    expect(registered.size).toBe(15);
  });

  it("every dashboards row carries the landed twin substrate tables", () => {
    const rows = ORG_WRITE_REGISTRY.filter((e) => e.module === MUTATION_SERVICE);
    for (const row of rows) {
      expect(row.storageReferences).toContain("objects");
      expect(row.storageReferences).toContain("graphiti_projection_outbox");
      expect(row.storageReferences).toContain("artifact_audit");
      expect(row.capability).toBe("content.write");
    }
    const del = rows.find((r) => r.exportName === "deleteEntityDashboard")!;
    expect(del.storageReferences).toContain("change_set");
    expect(del.storageReferences).toContain("object_change_event");
    const publish = rows.find((r) => r.exportName === "publishDashboard")!;
    expect(publish.storageReferences).toContain("dashboardRevisions");
  });

  it("registry hygiene: no empty storage sets, module paths exist on disk", () => {
    for (const row of ORG_WRITE_REGISTRY) {
      expect(row.storageReferences.length).toBeGreaterThan(0);
      expect(row.orgIdExtractor.length).toBeGreaterThan(0);
      expect(() => readFileSync(row.module, "utf-8")).not.toThrow();
    }
  });

  it("the three declared org FK cascades exist verbatim in the DDL", () => {
    const ddl = readFileSync(DRIZZLE_STORE, "utf-8");
    expect(DECLARED_ORG_FK_CASCADES).toHaveLength(3);
    for (const fk of ["connector_access_policy_org_fkey", "role_grant_org_fkey", "project_access_org_fkey"]) {
      expect(ddl).toContain(fk);
    }
    const cascadeCount = (
      ddl.match(/REFERENCES public\."organization"\(id\) ON DELETE CASCADE/g) ?? []
    ).length;
    expect(cascadeCount).toBe(3);
  });

  it("declared FK-less references stay FK-less (no new silent org cascade)", () => {
    const ddl = readFileSync(DRIZZLE_STORE, "utf-8");
    for (const ref of DECLARED_FKLESS_ORG_REFERENCES) {
      const [table] = ref.split(".");
      // A new `<table>… REFERENCES public."organization"` clause would mean a
      // cascade this registry does not model — force a deliberate update.
      const tableFk = new RegExp(
        `"${table}"[^;]{0,400}REFERENCES public\\."organization"`,
        "s",
      );
      expect(ddl).not.toMatch(tableFk);
    }
  });
});

describe("per-function write-site ratchet + R4 seed (codex diff round)", () => {
  it("each dashboards writer's drizzle write-site count matches its registry row", () => {
    const src = readFileSync(MUTATION_SERVICE, "utf-8");
    const parts = src.split(/export async function (\w+)/);
    const counts = new Map<string, number>();
    for (let i = 1; i < parts.length; i += 2) {
      const body = parts[i + 1] ?? "";
      counts.set(parts[i], (body.match(/\.(insert|update|delete)\(/g) ?? []).length);
    }
    for (const row of ORG_WRITE_REGISTRY.filter((e) => e.module === MUTATION_SERVICE)) {
      expect(
        counts.get(row.exportName),
        `${row.exportName} write sites drifted — update the registry row deliberately`,
      ).toBe(row.writeSites);
    }
  });

  it("no entry is import-banned in S2 (the ban flips per-writer in S3 wiring)", () => {
    for (const row of ORG_WRITE_REGISTRY) {
      expect(row.importBanned).toBe(false);
    }
  });
});
