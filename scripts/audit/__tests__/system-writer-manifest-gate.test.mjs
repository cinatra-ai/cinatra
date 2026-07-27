// Fixture tests for the non-registry system writer manifest gate (cinatra#1941 S3).
//
// The gate's value is two-directional: a NEW non-registry org writer that is
// not enumerated fails CI, and a manifest row the scanner no longer finds fails
// too. These tests hold every half of that claim, plus the two lockstep pins
// that keep this gate from silently diverging from the sources it mirrors:
//
//   1. A synthetic out-of-manifest writer FAILS — in each of the three forms
//      (raw-SQL qualified DML, Drizzle builder, write-registry call site),
//      including alias/rename shapes.
//   2. Legitimate non-write traffic does NOT trip the gate (prose, FK
//      REFERENCES, SELECT, COPY..TO, a bare import) — the false-positive half,
//      with the deliberate totally-bare MISS pinned as a decision.
//   3. Two-directional drift: unlisted, stale row, and count drift each fail.
//   4. TABLE-UNIVERSE lockstep: the org-axis subset equals org-write-table-
//      sweep.mjs's list (the two gates cannot diverge on the universe).
//   5. WRITER-SET lockstep: the exportNames extracted from write-registry.ts
//      SOURCE equal the real ORG_WRITE_REGISTRY's exportNames.
//   6. The gate is green on the real tree and its committed manifest matches
//      the current surface (zero-baseline). This case also makes the gate RUN
//      in CI: scripts/audit/__tests__/** is inside the root Vitest include glob.
//
// The matcher is IMPORTED from the gate, so a fixture can never assert a rule
// that differs from what CI enforces.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanSource,
  computeSurface,
  diffManifest,
  loadManifest,
  loadWriterNames,
  collectScanFiles,
  isScannable,
  extractWriteRegistryWriters,
  resolveLocalSymbols,
  resolveWriterLocalNames,
  SWEEP_ORG_AXIS_TABLES,
  MAINTENANCE_TABLES,
  ORG_AXIS_TABLES,
  ORG_AXIS_SYMBOLS,
  WRITE_REGISTRY_REL,
  SWEEP_REL,
} from "../system-writer-manifest-gate.mjs";
import { ORG_WRITE_REGISTRY } from "../../../src/lib/org-write/write-registry";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE_REL = "scripts/audit/system-writer-manifest-gate.mjs";
const WRITER_NAMES = loadWriterNames(REPO_ROOT);

// --------------------------------------------------------------------------
// 1. A synthetic out-of-manifest writer FAILS — all three forms.
// --------------------------------------------------------------------------

describe("a new non-registry writer is caught — form 1 (raw SQL)", () => {
  it.each([
    ["schema-qualified bare (the seed.mjs shape)", "await q(`DELETE FROM cinatra.objects WHERE x=$1`);", "objects"],
    ["quoted + interpolated schema (the src/ shape)", 'await q(`INSERT INTO "${schema}"."objects" (id) VALUES ($1)`);', "objects"],
    ["TRUNCATE", "await q(`TRUNCATE cinatra.agent_runs CASCADE`);", "agent_runs"],
    ["unqualified but quoted", 'await q(`UPDATE "agent_runs" SET status=$1`);', "agent_runs"],
    ["a maintenance table", "await q(`DELETE FROM cinatra.artifact_provider_cache WHERE org_id=$1`);", "artifact_provider_cache"],
    ["COPY .. FROM (the writing direction)", "await q(`COPY cinatra.objects (id) FROM STDIN`);", "objects"],
    ["not the FIRST truncate target", "await q(`TRUNCATE scratch, cinatra.agent_runs`);", "agent_runs"],
  ])("catches %s", (_label, code, table) => {
    const hits = scanSource(code);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ form: "raw-sql", target: table, ref: `raw-sql:${table}` });
  });
});

describe("a new non-registry writer is caught — form 2 (Drizzle builder)", () => {
  it("catches .insert(agentRuns)", () => {
    const hits = scanSource("await db.insert(agentRuns).values(row);");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ form: "drizzle", target: "agentRuns", ref: "drizzle:agentRuns" });
  });
  it("catches a namespace-qualified symbol", () => {
    const hits = scanSource("await db.delete(schema.agentRunPmLinks).where(x);");
    expect(hits[0]).toMatchObject({ form: "drizzle", target: "agentRunPmLinks" });
  });
  it("catches a symbol renamed at import (rename is not an escape)", () => {
    const hits = scanSource(`
      import { agentRuns as runs } from "@cinatra-ai/agents/schema";
      await db.update(runs).set({ status: "done" });
    `);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ form: "drizzle", target: "agentRuns" });
  });
  it("catches a formatter-wrapped multi-line builder", () => {
    const hits = scanSource("await tx\n  .insert(\n    agentRunPmLinks,\n  )\n  .values(row);");
    expect(hits).toHaveLength(1);
    expect(hits[0].target).toBe("agentRunPmLinks");
  });
});

describe("a new non-registry writer is caught — form 3 (write-registry call site)", () => {
  const NAMES = ["transitionRunStatus", "backfillDashboardArtifactTwins", "createSemanticArtifact"];
  it("catches a bare call to a canonical writer", () => {
    const hits = scanSource("await transitionRunStatus({ runId });", { writerNames: NAMES });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ form: "write-registry", target: "transitionRunStatus" });
  });
  it("catches a renamed-at-import call (rename is not an escape)", () => {
    const hits = scanSource(
      'import { backfillDashboardArtifactTwins as run } from "@/lib/org-write/write-registry";\nawait run({ log });',
      { writerNames: NAMES },
    );
    // The rename maps back to the canonical name; the import line itself is not
    // a call, so exactly one finding (the call).
    const calls = hits.filter((h) => h.form === "write-registry");
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe("backfillDashboardArtifactTwins");
  });
  it("does NOT flag a bare import with no call", () => {
    const hits = scanSource(
      'import { createSemanticArtifact } from "@/lib/artifacts/artifact-creation";',
      { writerNames: NAMES },
    );
    expect(hits.filter((h) => h.form === "write-registry")).toEqual([]);
  });
  it("form 3 is inert when no writer names are supplied", () => {
    expect(scanSource("await transitionRunStatus({ runId });")).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// 2. Legitimate / non-write traffic is NOT flagged (the false-positive half).
// --------------------------------------------------------------------------

describe("legitimate traffic is not flagged", () => {
  it.each([
    ["a Drizzle SELECT", "await db.select().from(agentRuns).where(x);"],
    ["a raw SELECT", 'await q(`SELECT id FROM cinatra.objects WHERE id=$1`);'],
    ["CREATE TABLE (DDL)", 'text: `CREATE TABLE IF NOT EXISTS "${q}"."objects" (id text)`'],
    ["ALTER TABLE (migration)", "sql`ALTER TABLE cinatra.agent_runs ADD COLUMN x text`"],
    ["DROP TABLE (migration down)", "sql`DROP TABLE IF EXISTS cinatra.objects`"],
    ["an FK REFERENCES .. ON DELETE CASCADE", 'sql`child text REFERENCES "objects"(id) ON DELETE CASCADE`'],
    ["COPY .. TO (an export = a read)", "await q(`COPY cinatra.objects TO STDOUT`);"],
    ["fluent JS .update on an object", "await objectsRepo.update({ id, patch });"],
    ["a prefix of another table", "await q(`INSERT INTO cinatra.objects_archive (id) VALUES ($1)`);"],
  ])("does not flag %s", (_label, code) => {
    expect(scanSource(code, { writerNames: WRITER_NAMES })).toEqual([]);
  });

  it("does not flag prose mentioning a write (comments are stripped)", () => {
    const code = `
      // we UPDATE cinatra.objects here via the store
      /* INSERT INTO cinatra.agent_runs is the runner's job */
      await store.doThing();
    `;
    expect(scanSource(code, { writerNames: WRITER_NAMES })).toEqual([]);
  });

  // --- deliberate MISS, pinned as a decision -----------------------------
  // A TOTALLY-bare target (no schema, no quotes) is intentionally NOT matched:
  // the org-wide table-sweep lesson (a bare-word anchor matches prose / fluent
  // JS, greening for the wrong reason). Every real raw-SQL org-axis write in
  // the scan roots is quoted or schema-qualified, so this loses nothing. If a
  // future change makes it match, that is a real widening and this test says so.
  it("deliberately does NOT match a totally-bare target", () => {
    expect(scanSource("await q(`INSERT INTO objects (id) VALUES ($1)`);")).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// 3. Two-directional drift.
// --------------------------------------------------------------------------

describe("two-directional drift", () => {
  it("computeSurface reports file, ref and count for a synthetic tree", () => {
    const surface = computeSurface({
      files: ["scripts/rogue-reconciler.mjs"],
      repoRoot: REPO_ROOT,
      writerNames: ["transitionRunStatus"],
      readFileImpl: () =>
        "await q(`INSERT INTO cinatra.objects (id) VALUES ($1)`);\n" +
        "await q(`DELETE FROM cinatra.objects WHERE id=$1`);\n" +
        "await transitionRunStatus({ runId });\n",
    });
    expect(surface).toEqual([
      { file: "scripts/rogue-reconciler.mjs", ref: "raw-sql:objects", count: 2 },
      { file: "scripts/rogue-reconciler.mjs", ref: "write-registry:transitionRunStatus", count: 1 },
    ]);
  });

  it("flags an UNLISTED writer (in the tree, absent from the manifest)", () => {
    const surface = [{ file: "scripts/x.mjs", ref: "raw-sql:objects", count: 1 }];
    const { unlisted, stale, drifted } = diffManifest(surface, []);
    expect(unlisted).toHaveLength(1);
    expect(stale).toEqual([]);
    expect(drifted).toEqual([]);
  });

  it("flags a STALE manifest row (in the manifest, gone from the tree)", () => {
    const manifest = [{ file: "scripts/gone.mjs", ref: "raw-sql:objects", count: 1 }];
    const { unlisted, stale, drifted } = diffManifest([], manifest);
    expect(stale).toHaveLength(1);
    expect(unlisted).toEqual([]);
    expect(drifted).toEqual([]);
  });

  it("flags COUNT DRIFT in either direction", () => {
    const manifest = [{ file: "scripts/x.mjs", ref: "raw-sql:objects", count: 3 }];
    const up = diffManifest([{ file: "scripts/x.mjs", ref: "raw-sql:objects", count: 5 }], manifest);
    const down = diffManifest([{ file: "scripts/x.mjs", ref: "raw-sql:objects", count: 1 }], manifest);
    expect(up.drifted).toEqual([{ file: "scripts/x.mjs", ref: "raw-sql:objects", found: 5, manifest: 3 }]);
    expect(down.drifted).toEqual([{ file: "scripts/x.mjs", ref: "raw-sql:objects", found: 1, manifest: 3 }]);
  });
});

// --------------------------------------------------------------------------
// 4. Table-universe lockstep vs org-write-table-sweep.mjs.
// --------------------------------------------------------------------------

describe("table-universe lockstep", () => {
  it("the org-axis subset equals org-write-table-sweep.mjs's ORG_AXIS_TABLES", () => {
    const sweepSrc = readFileSync(join(REPO_ROOT, SWEEP_REL), "utf8");
    const block = sweepSrc.match(/const ORG_AXIS_TABLES\s*=\s*\[([\s\S]*?)\]/);
    expect(block, "could not locate ORG_AXIS_TABLES in the sweep source").toBeTruthy();
    const sweepTables = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...SWEEP_ORG_AXIS_TABLES].sort()).toEqual([...sweepTables].sort());
  });

  it("the full universe = sweep tables + the #1941 maintenance tables", () => {
    expect(ORG_AXIS_TABLES).toEqual([...SWEEP_ORG_AXIS_TABLES, ...MAINTENANCE_TABLES]);
    expect(ORG_AXIS_SYMBOLS).toHaveLength(ORG_AXIS_TABLES.length);
    // A couple of real symbols, to prove the camelCase derivation is right.
    expect(ORG_AXIS_SYMBOLS).toContain("agentRuns");
    expect(ORG_AXIS_SYMBOLS).toContain("agentRunPmLinks");
  });
});

// --------------------------------------------------------------------------
// 5. Writer-set lockstep vs the real ORG_WRITE_REGISTRY.
// --------------------------------------------------------------------------

describe("writer-set lockstep", () => {
  it("the extracted exportNames equal the real ORG_WRITE_REGISTRY's", () => {
    const src = readFileSync(join(REPO_ROOT, WRITE_REGISTRY_REL), "utf8");
    const extracted = new Set(extractWriteRegistryWriters(src));
    const actual = new Set(ORG_WRITE_REGISTRY.map((e) => e.exportName));
    expect([...extracted].sort()).toEqual([...actual].sort());
    // Non-vacuous: the registry has writers and both known shapes are present.
    expect(extracted.size).toBeGreaterThan(0);
    expect(extracted.has("transitionRunStatus")).toBe(true); // exportName: "..." shape
    expect(extracted.has("createDashboard")).toBe(true); // dashboardsWriter("...") shape
  });
});

// --------------------------------------------------------------------------
// 6. Alias-resolution helpers (exported for reuse / clarity).
// --------------------------------------------------------------------------

describe("alias resolution", () => {
  it("resolveLocalSymbols picks up an import rename and a const alias", () => {
    const local = resolveLocalSymbols(
      "import { agentRuns as r } from './s';\nconst q = agentRunPmLinks;",
    );
    expect(local).toContain("r");
    expect(local).toContain("q");
    for (const s of ORG_AXIS_SYMBOLS) expect(local).toContain(s);
  });
  it("resolveWriterLocalNames maps a rename back to the canonical name", () => {
    const map = resolveWriterLocalNames(
      "import { transitionRunStatus as go } from './s';",
      ["transitionRunStatus"],
    );
    expect(map.get("go")).toBe("transitionRunStatus");
  });
});

// --------------------------------------------------------------------------
// 7. The gate header cross-links the S4 contract doc (§7 requirement).
// --------------------------------------------------------------------------

describe("documentation cross-link", () => {
  it("names the schema-migrations contract doc in its own source", () => {
    const gateSrc = readFileSync(join(REPO_ROOT, GATE_REL), "utf8");
    expect(gateSrc).toContain(
      "docs/internals/contracts/schema-migrations-and-org-write-policy.md",
    );
  });
});

// --------------------------------------------------------------------------
// 8. Green on the real tree (zero-baseline), and thereby runs in CI.
// --------------------------------------------------------------------------

describe("the gate on the current tree", () => {
  it("scan roots are enumerable and exclude the gate corpus + tests", () => {
    const files = collectScanFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.startsWith("src/lib/boot/"))).toBe(true);
    expect(files.some((f) => f === "scripts/seed.mjs")).toBe(true);
    expect(files.every((f) => isScannable(f) || f.startsWith("src/"))).toBe(true);
    expect(files.some((f) => f.startsWith("scripts/audit/"))).toBe(false);
    expect(files.some((f) => f.includes("__tests__"))).toBe(false);
  });

  it("the committed manifest matches the current surface (zero-baseline)", () => {
    const surface = computeSurface({ repoRoot: REPO_ROOT, writerNames: WRITER_NAMES });
    const manifest = loadManifest(REPO_ROOT);
    const { unlisted, stale, drifted } = diffManifest(surface, manifest.writers ?? []);
    expect({ unlisted, stale, drifted }).toEqual({ unlisted: [], stale: [], drifted: [] });
  });

  it("exits 0 against the repo as checked out", () => {
    const result = spawnSync("node", [GATE_REL], { encoding: "utf8", cwd: REPO_ROOT });
    expect(result.stderr ?? "").toBe("");
    expect(result.status).toBe(0);
  });
});
