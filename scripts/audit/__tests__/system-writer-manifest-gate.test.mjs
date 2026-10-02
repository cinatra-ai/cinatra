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

import { afterEach, describe, it, expect } from "vitest";
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
  FLOOR_FILE,
  FLOOR_BASE_VAR,
  PERMIT_FILE,
  PERMIT_LIST,
  PERMIT_ROAD,
  checkFloorAgainstBase,
} from "../system-writer-manifest-gate.mjs";
import {
  NO_PULL_REQUEST_RUN,
  PULL_REQUEST_RUN,
  UNREADABLE_BASE_RUN,
  envWithoutBase,
  makeFloorRepo,
  makeOneCommitCheckout,
} from "./floor-base-fixture.mjs";
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

// --------------------------------------------------------------------------
// cinatra#3832: the committed manifest is compared with the copy on the base
// branch, so a pull request cannot add its own writer to the manifest.
// --------------------------------------------------------------------------

describe("system-writer-manifest — floor compared with the base", () => {
  const fixtures = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop().cleanup();
  });
  const manifest = (writers) => ({ note: "fixture", version: 1, writers });
  const row = (file, ref, count) => ({ file, ref, count });
  function repo(baseWriters, headWriters, make = makeFloorRepo) {
    const f = make({ base: { [FLOOR_FILE]: manifest(baseWriters) }, head: { [FLOOR_FILE]: manifest(headWriters) } });
    fixtures.push(f);
    return f.root;
  }
  const SEED = row("scripts/seed.mjs", "raw-sql:objects", 6);

  it("names its floor file and its own base variable", () => {
    expect(FLOOR_FILE).toBe("scripts/audit/system-writer-manifest.json");
    expect(FLOOR_BASE_VAR).toBe("SYSTEM_WRITER_MANIFEST_BASE");
  });

  it("a raised floor FAILS: a new manifest row and a raised count are growth", () => {
    const root = repo([SEED], [row("scripts/seed.mjs", "raw-sql:objects", 7), row("scripts/new.mjs", "drizzle:agentRuns", 1)]);
    const r = checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN });
    expect(r.ok).toBe(false);
    expect(r.growth).toEqual(["scripts/new.mjs [drizzle:agentRuns] (0 -> 1)", "scripts/seed.mjs [raw-sql:objects] (6 -> 7)"]);
  });

  it("a lowered floor PASSES: a removed stale row and a lowered count are not growth", () => {
    const root = repo([SEED, row("scripts/gone.mjs", "raw-sql:objects", 1)], [row("scripts/seed.mjs", "raw-sql:objects", 5)]);
    expect(checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN })).toMatchObject({ ok: true, status: "held" });
  });

  it("a base that cannot be read on a pull request's run FAILS with its reason", () => {
    const root = repo([], []);
    const r = checkFloorAgainstBase({ repoRoot: root, env: UNREADABLE_BASE_RUN });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/cannot be compared with the base: the base "origin\/no-such-base-3832" did not resolve/);
  });

  it("a base copy that is not a manifest FAILS with its reason", () => {
    const f = makeFloorRepo({ base: { [FLOOR_FILE]: { writers: [{ file: "x" }] } }, head: { [FLOOR_FILE]: manifest([]) } });
    fixtures.push(f);
    const r = checkFloorAgainstBase({ repoRoot: f.root, env: PULL_REQUEST_RUN });
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toMatch(/is not a readable floor/);
  });

  it("no pull request PASSES with its line", () => {
    const root = repo([], [SEED]);
    const r = checkFloorAgainstBase({ repoRoot: root, env: NO_PULL_REQUEST_RUN });
    expect(r).toMatchObject({ ok: true, status: "no-base" });
    expect(r.lines[0]).toContain(FLOOR_BASE_VAR);
  });

  it("in a checkout of one commit the base is fetched: a raised floor FAILS, a lowered one PASSES", () => {
    let root = repo([SEED], [SEED, row("scripts/new.mjs", "raw-sql:objects", 1)], makeOneCommitCheckout);
    let r = checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN });
    expect(r.status).toBe("grew");
    expect(r.fetched).toEqual({ remote: "origin", branch: "main" });
    root = repo([SEED], [], makeOneCommitCheckout);
    r = checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN });
    expect(r).toMatchObject({ ok: true, status: "held" });
  });

  it("the gate itself runs the guard first: an unreadable base fails it with the reason", () => {
    const res = spawnSync(process.execPath, [GATE_REL], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...envWithoutBase(process.env), ...UNREADABLE_BASE_RUN },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/\[system-writer-manifest\] FAIL — the floor scripts\/audit\/system-writer-manifest\.json cannot be compared with the base/);
  });
});

// --------------------------------------------------------------------------
// cinatra#3832: the record road. The manifest is a register of writers
// allowed after a review: a new or raised row passes in the pull request that
// carries it, with its record in the permits file.
// --------------------------------------------------------------------------

describe("system-writer-manifest — the record road for a new writer", () => {
  const fixtures = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop().cleanup();
  });
  const manifest = (writers) => ({ note: "fixture", version: 1, writers });
  const row = (file, ref, count) => ({ file, ref, count });
  const REASON = "the new backfill writes org rows at every start";
  const record = (file, ref, reason = REASON, pr = 3900) => ({ list: PERMIT_LIST, row: { file, ref }, reason, pr });
  const records = (...permits) => ({ note: "fixture", permits });
  function repo({ baseRows, headRows, basePermits, headPermits }) {
    const base = { [FLOOR_FILE]: manifest(baseRows) };
    if (basePermits !== undefined) base[PERMIT_FILE] = basePermits;
    const head = { [FLOOR_FILE]: manifest(headRows) };
    if (headPermits !== undefined) head[PERMIT_FILE] = headPermits;
    const f = makeFloorRepo({ base, head });
    fixtures.push(f);
    return f.root;
  }
  const check = (root, env = PULL_REQUEST_RUN) => checkFloorAgainstBase({ repoRoot: root, env });
  const SEED = row("scripts/seed.mjs", "raw-sql:objects", 6);
  const NEW = row("scripts/new.mjs", "drizzle:agentRuns", 1);
  const NEW_KEY = "scripts/new.mjs [drizzle:agentRuns]";

  it("the permits file of this commit holds no records", () => {
    const doc = JSON.parse(readFileSync(join(REPO_ROOT, PERMIT_FILE), "utf8"));
    expect(doc.permits).toEqual([]);
  });

  it("an addition with its record in the same change PASSES, with a NOTICE naming row, reason and pull request", () => {
    const r = check(repo({ baseRows: [SEED], headRows: [SEED, NEW], basePermits: records(), headPermits: records(record(NEW.file, NEW.ref)) }));
    expect(r).toMatchObject({ ok: true, status: "held", absorbed: [NEW_KEY] });
    expect(r.lines).toContain(`[system-writer-manifest] NOTICE — ADDITION ABSORBED: ${NEW_KEY}, reason: "${REASON}", pull request #3900`);
  });

  it("an addition without its record FAILS, and the refusal names the permits file and the record's form", () => {
    const r = check(repo({ baseRows: [SEED], headRows: [SEED, NEW] }));
    expect(r.ok).toBe(false);
    expect(r.growth).toEqual(["scripts/new.mjs [drizzle:agentRuns] (0 -> 1)"]);
    expect(r.lines).toContain(`[system-writer-manifest] ${PERMIT_ROAD}`);
    expect(PERMIT_ROAD).toContain(PERMIT_FILE);
    expect(PERMIT_ROAD).toMatch(/"list": "system-writer-manifest", "row": \{ "file": .*"ref": .*"reason": .*"pr"/);
  });

  it("a raised count passes with a record written or updated in the change, and FAILS on a record carried unchanged", () => {
    const raised = row("scripts/seed.mjs", "raw-sql:objects", 7);
    let r = check(repo({ baseRows: [SEED], headRows: [raised], headPermits: records(record(SEED.file, SEED.ref)) }));
    expect(r).toMatchObject({ ok: true, status: "held" });
    const carried = records(record(SEED.file, SEED.ref));
    r = check(repo({ baseRows: [SEED], headRows: [raised], basePermits: carried, headPermits: carried }));
    expect(r.ok).toBe(false);
    expect(r.permitProblems).toEqual([
      "scripts/seed.mjs [raw-sql:objects]: grows on a record carried from the base; update the record for this change",
    ]);
    r = check(repo({ baseRows: [SEED], headRows: [raised], basePermits: carried, headPermits: records(record(SEED.file, SEED.ref, REASON, 3901)) }));
    expect(r).toMatchObject({ ok: true, status: "held" });
  });

  it("a record for a row the manifest does not hold is an orphan and FAILS", () => {
    const r = check(repo({ baseRows: [SEED], headRows: [SEED], headPermits: records(record("scripts/gone.mjs", "raw-sql:objects")) }));
    expect(r.ok).toBe(false);
    expect(r.permitProblems).toEqual([
      "scripts/gone.mjs [raw-sql:objects]: orphan record, the register does not hold its row; remove the record",
    ]);
  });

  it("a carried-forward record PASSES unchanged, and FAILS altered or deleted while its row stands", () => {
    const base = { baseRows: [SEED, NEW], headRows: [SEED, NEW], basePermits: records(record(NEW.file, NEW.ref)) };
    expect(check(repo(base))).toMatchObject({ ok: true, status: "held" });
    let r = check(repo({ ...base, headPermits: records(record(NEW.file, NEW.ref, "a different sentence of reasons for this row")) }));
    expect(r.permitProblems).toEqual([`${NEW_KEY}: the record is altered while its row stands; carry it unchanged`]);
    r = check(repo({ ...base, headPermits: records() }));
    expect(r.permitProblems).toEqual([`${NEW_KEY}: the record is deleted while its row stands; carry it unchanged`]);
  });

  it("a record removed together with its row PASSES", () => {
    const r = check(repo({ baseRows: [SEED, NEW], headRows: [SEED], basePermits: records(record(NEW.file, NEW.ref)), headPermits: records() }));
    expect(r).toMatchObject({ ok: true, status: "held" });
  });

  it("a reason of one repeated word FAILS", () => {
    const r = check(repo({ baseRows: [SEED], headRows: [SEED, NEW], headPermits: records(record(NEW.file, NEW.ref, "writer writer writer writer writer writer")) }));
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toMatch(/at least 6 words of three letters or more, at least 4 of them different/);
  });

  it("an unreadable permits file on a pull request's run FAILS with its reason (head or base)", () => {
    let r = check(repo({ baseRows: [SEED], headRows: [SEED], basePermits: records(), headPermits: "{ not json" }));
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toMatch(/the permit file scripts\/audit\/system-writer-manifest\.permits\.json is not readable/);
    r = check(repo({ baseRows: [SEED], headRows: [SEED], basePermits: "{ not json", headPermits: records() }));
    expect(r.status).toBe("unreadable");
    const foreign = records({ list: "system-extensions", row: { file: NEW.file, ref: NEW.ref }, reason: REASON, pr: 3900 });
    r = check(repo({ baseRows: [SEED], headRows: [SEED], basePermits: records(), headPermits: foreign }));
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toMatch(/names the list "system-extensions", not "system-writer-manifest"/);
  });

  it("no pull request PASSES with its line", () => {
    const r = check(repo({ baseRows: [SEED], headRows: [SEED, NEW], headPermits: "{ not json" }), NO_PULL_REQUEST_RUN);
    expect(r).toMatchObject({ ok: true, status: "no-base" });
    expect(r.lines[0]).toContain(FLOOR_BASE_VAR);
  });
});
