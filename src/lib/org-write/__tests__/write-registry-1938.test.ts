/**
 * cinatra#1938 — write-registry lockstep: the typed registry stays in step
 * with reality. Source-scans (no imports of heavy modules): the dashboards
 * mutation service's exported writer set must equal the registry's rows for
 * that module; every dashboards row carries the landed twin substrate
 * tables; and the declared FK catalog is reconciled against the actual DDL
 * strings (the live pg_constraint check is the CI-tier integration test).
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import {
  ORG_WRITE_REGISTRY,
  DECLARED_FKLESS_ORG_REFERENCES,
  DECLARED_ORG_FK_CASCADES,
} from "../write-registry";

const MUTATION_SERVICE = "packages/dashboards/src/mutation-service.ts";
const DRIZZLE_STORE = "src/lib/drizzle-store.ts";
// The kernel's archive tables bootstrap in their own leaf module (spread into
// drizzle-store's DDL array); FK scans must cover BOTH files.
const ORG_WRITE_SCHEMA = "src/lib/org-write-schema.ts";

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
    expect(registered.size).toBe(17);
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
    const orgWriteDdl = readFileSync(ORG_WRITE_SCHEMA, "utf-8");
    // The kernel tables must actually bootstrap from the leaf module — an
    // empty scan target would make this pin vacuous.
    expect(orgWriteDdl).toContain('."org_archive_lease"');
    expect(orgWriteDdl).toContain('."org_write_completion_ticket"');
    const ddl = readFileSync(DRIZZLE_STORE, "utf-8") + orgWriteDdl;
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

describe("per-function write-site ratchet + R4 seed", () => {
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

});

describe("R4 import-ban ratchet (#1939 wave 3, Decision 4)", () => {
  // The boundary gate STATICALLY parses write-registry.ts to derive its R4
  // rules. If that parser ever drifts from the EXECUTED registry, a banned
  // writer could be silently un-banned and the coverage proof would lie. This
  // runs the real registry against the gate's `--emit-r4-rules` extraction —
  // they must be byte-identical. (`--emit-r4-rules` returns before any module
  // resolution or tree walk, so this stays fast.)
  it("gate static extraction == executed registry (no parser drift)", () => {
    const raw = execFileSync(
      "node",
      ["scripts/audit/org-write-boundary-gate.mjs", "--emit-r4-rules"],
      { encoding: "utf-8", cwd: process.cwd() },
    );
    const emitted = JSON.parse(raw);
    const norm = (r: (typeof ORG_WRITE_REGISTRY)[number]) => ({
      module: r.module,
      exportName: r.exportName,
      importBanned: r.importBanned,
      allowedImporters: r.allowedImporters ? [...r.allowedImporters].sort() : null,
      importBanExemption: r.importBanExemption ?? null,
    });
    const byKey = (a: { module: string; exportName: string }, b: typeof a) =>
      `${a.module}#${a.exportName}`.localeCompare(`${b.module}#${b.exportName}`);
    expect(emitted).toEqual(ORG_WRITE_REGISTRY.map(norm).sort(byKey));
  });

  it("banned rows carry allowedImporters; unbanned rows never do; exemptions only on unbanned rows", () => {
    for (const r of ORG_WRITE_REGISTRY) {
      if (r.importBanned) {
        expect(Array.isArray(r.allowedImporters), `${r.exportName}: banned without allowedImporters`).toBe(true);
        expect(r.importBanExemption, `${r.exportName}: banned yet exempted`).toBeUndefined();
      } else {
        expect(r.allowedImporters, `${r.exportName}: unbanned yet has allowedImporters`).toBeUndefined();
      }
    }
  });

  it("every allowlisted importer path exists on disk (no stale/typo'd entries)", () => {
    for (const r of ORG_WRITE_REGISTRY) {
      for (const f of r.allowedImporters ?? []) {
        expect(() => readFileSync(f, "utf-8"), `${r.exportName} allowlists a missing file: ${f}`).not.toThrow();
      }
    }
  });

  it("the Stage-A exception ledger is EXACTLY the workflows-extension (#1939) + new-run (#1940) rows", () => {
    const ledger = ORG_WRITE_REGISTRY.filter((r) => r.importBanExemption)
      .map((r) => `${r.exportName}#${r.importBanExemption!.issue}`)
      .sort();
    expect(ledger).toEqual([
      "createAgentRun#1940",
      "createAgentRunPendingInput#1940",
      "materializeExtensionInstanceForProject#1939",
      "materializeExtensionTemplate#1939",
      "upgradeExtensionDashboards#1939",
    ]);
  });

  it("the Stage-A flip set (already-converted writers + kernel rows) is import-banned", () => {
    const banned = new Set(
      ORG_WRITE_REGISTRY.filter((r) => r.importBanned).map((r) => r.exportName),
    );
    for (const w of [
      // 12 converted dashboards writers (callers all in-repo)
      "createDashboard", "updateDashboard", "publishDashboard", "archiveDashboard",
      "upsertDashboardConfig", "ensureOverview", "createEntityDashboard", "renameDashboard",
      "deleteEntityDashboard", "archiveExtensionDashboards", "restoreExtensionDashboards",
      "adoptExtensionDashboards",
      // twin backfill + host twin writer
      "pairOneUntwinnedDashboardTwin", "backfillDashboardArtifactTwins", "dashboardArtifactTwinWriter",
      // agent-run lifecycle
      "transitionRunStatus", "updateAgentRunStatus", "resumeRunFromSetupApproval",
      // kernel entry points
      "redeemCompletionTicket", "snapshotLeasesQuery",
    ]) {
      expect(banned.has(w), `${w} must be import-banned in Stage A`).toBe(true);
    }
    expect(banned.size).toBe(20);
  });
});

describe("org.delete capability vocab — delete row swap (#1939 wave 3, stage B)", () => {
  const DELETE_MODULE = "src/lib/organization-delete.ts";
  const deleteRow = ORG_WRITE_REGISTRY.find(
    (e) =>
      e.module === DELETE_MODULE &&
      e.exportName === "deleteOrganizationReferenceGuarded",
  )!;

  it("the guarded delete writer demands org.delete, not org.lifecycle", () => {
    expect(deleteRow).toBeDefined();
    expect(deleteRow.capability).toBe("org.delete");
  });

  it("discloses org.lifecycle as the pre-activation transitional demand (Decision 1)", () => {
    // The transitional fallback lives ONLY here (and in the writer's own
    // module-private gate helper, stage C) — a reviewed, per-surface disclosure
    // that the S6 closeout removes.
    expect(deleteRow.conditionalCapabilities).toEqual(["org.lifecycle"]);
  });

  it("swaps ONLY the capability — the rest of the delete row is untouched", () => {
    // importBanned flips in stage C, not here; the delete-furniture taxonomy and
    // org-axis extractor are unchanged by the vocab stage.
    expect(deleteRow.importBanned).toBe(false);
    expect(deleteRow.cascadeOwnership).toBe("app-furniture");
    expect(deleteRow.storageReferences).toEqual([
      "organization",
      "member",
      "invitation",
      "session",
      "dashboards",
    ]);
  });

  it("the archive lease-snapshot writer KEEPS org.lifecycle (only the delete row swapped)", () => {
    const leaseRow = ORG_WRITE_REGISTRY.find(
      (e) => e.exportName === "snapshotLeasesQuery",
    )!;
    expect(leaseRow.capability).toBe("org.lifecycle");
    expect(leaseRow.conditionalCapabilities).toBeUndefined();
  });
});
