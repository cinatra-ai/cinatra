/**
 * cinatra#2570 (epic #2564 S6a) — "zero writes to `auditor_proposal_snapshots`
 * after cutover", the GREP half.
 *
 * The runtime half lives beside the store
 * (`packages/agents/src/__tests__/auditor-snapshot-store.test.ts`): the retired
 * writer throws. This file is the structural half, and it exists because a
 * throwing function only protects the paths that go THROUGH it — a future lane
 * could open its own `INSERT` against the same table and never touch the store
 * at all. So the assertions here are about the repository, not about a call:
 *
 *   1. No production module calls the retired writer.
 *   2. No production module writes the legacy table by any route — drizzle
 *      builder or raw SQL — outside the store that owns it.
 *   3. The gate-bound successor DOES have a production writer, which is the
 *      whole point of the slice: the acceptance criterion is not "nothing
 *      writes", it is "the run-scoped path stopped and the gate-bound path
 *      started".
 *   4. `/api/auditor/apply` — the reader whose deletion made the legacy write
 *      pointless — is still gone.
 *
 * WHAT THIS CANNOT PROVE, stated so nobody mistakes it for more than it is: a
 * text scan is defeated by a table name assembled at runtime. It closes the
 * reachable, nameable ways back — a direct write, a write from inside the owning
 * store, and a renamed binding — and it is paired with a writer that refuses at
 * runtime. Deleting the table is the only complete answer, and that is a
 * migration waiting on an owner.
 *
 * Run: pnpm exec vitest run src/lib/__tests__/legacy-auditor-proposal-writer-retired.test.ts
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();

/**
 * The two modules allowed to NAME the legacy drizzle table symbol: its
 * definition and the store that owns it. (The bootstrap DDL names the table in
 * raw SQL, not through the symbol, and is covered by the write scan.) Nothing is
 * exempt from the "no writes" scan — the whole point of the round-1 review's
 * finding is that exempting the owning store would let a SECOND writer be added
 * inside it and evade both guards. The exemption below is only about NAMING the
 * table, and it is asserted in both directions.
 */
const TABLE_NAMERS = new Set([
  "packages/agents/src/auditor-snapshot-store.ts",
  "packages/agents/src/schema.ts",
]);

const SEARCH_ROOTS = ["src", "packages", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "__tests__",
  "tests",
  "coverage",
  "__generated__",
]);
const CODE_EXT = /\.(ts|tsx|mjs|mts|js|jsx)$/;

function walkProductionFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walkProductionFiles(full, out);
      continue;
    }
    if (!CODE_EXT.test(entry)) continue;
    if (entry.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

/** EVERY production file, including the owning store. */
function productionFiles(): { path: string; source: string }[] {
  const files: { path: string; source: string }[] = [];
  for (const root of SEARCH_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const full of walkProductionFiles(abs)) {
      const rel = relative(REPO_ROOT, full).replaceAll("\\", "/");
      files.push({ path: rel, source: readFileSync(full, "utf8") });
    }
  }
  return files;
}

/** A drizzle DML call or a raw SQL write against the legacy table. */
function writesLegacyTable(source: string): boolean {
  const drizzleWrite = /\.(insert|update|delete)\(\s*auditorProposalSnapshots/.test(source);
  const rawWrite =
    /(insert\s+into|update|delete\s+from)[\s\S]{0,80}auditor_proposal_snapshots/i.test(source);
  return drizzleWrite || rawWrite;
}

describe("the run-scoped auditor proposal writer is retired", () => {
  const files = productionFiles();

  it("scans a real slice of the repository (guards against a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("`writeProposalSnapshot` is named ONLY where it is declared", () => {
    const mentions = files
      .filter((f) => f.source.includes("writeProposalSnapshot"))
      .map((f) => f.path);
    expect(mentions).toEqual(["packages/agents/src/auditor-snapshot-store.ts"]);
  });

  it("NO production module writes `auditor_proposal_snapshots` — the owning store included", () => {
    // Drizzle builder writes go through the table symbol; raw SQL writes name
    // the table. Nothing is exempt: a second writer added INSIDE the owning
    // store would otherwise slip past both this scan and the runtime refusal,
    // which only covers `writeProposalSnapshot` itself.
    const writers = files.filter((f) => writesLegacyTable(f.source)).map((f) => f.path);
    expect(writers).toEqual([]);
  });

  it("the legacy table symbol is CONFINED, so a re-bound table cannot hide elsewhere", () => {
    // The DML scan keys on the `auditorProposalSnapshots` identifier, so a
    // module that re-bound the table under another name would evade it. Confining
    // which modules may name the table at all closes that: an alias has to be
    // created somewhere, and that somewhere would show up here.
    const namers = files
      .filter((f) => f.source.includes("auditorProposalSnapshots"))
      .map((f) => f.path)
      .sort();
    expect(namers).toEqual([...TABLE_NAMERS].sort());
  });

  it("the legacy table symbol is never RENAMED — confinement plus no alias is what binds", () => {
    // Confinement alone is not enough (Codex round 3): inside a confined module,
    // `import { auditorProposalSnapshots as legacyTable }` followed by
    // `.insert(legacyTable)` would satisfy both the DML scan and the namer set,
    // and an alias EXPORTED from the schema would let a third module write
    // without ever spelling the original name. Banning the rename closes both,
    // because every alias form — import, export, or local const — has to write
    // the original identifier next to the new one.
    const aliased = files
      .filter(
        (f) =>
          /auditorProposalSnapshots\s+as\s+\w/.test(f.source) ||
          /\b(const|let|var)\s+\w+\s*=\s*auditorProposalSnapshots\b/.test(f.source),
      )
      .map((f) => f.path);
    expect(aliased).toEqual([]);
  });

  it("the owning store imports the table under its own name and nothing else", () => {
    const store = readFileSync(
      join(REPO_ROOT, "packages/agents/src/auditor-snapshot-store.ts"),
      "utf8",
    );
    expect(store).toContain('import { auditorProposalSnapshots } from "./schema";');
  });

  it("the owning store carries NO write statement of any kind against the table", () => {
    const store = readFileSync(
      join(REPO_ROOT, "packages/agents/src/auditor-snapshot-store.ts"),
      "utf8",
    );
    expect(writesLegacyTable(store)).toBe(false);
    // ...and the retired writer is still the only exported write-shaped symbol,
    // refusing rather than absent.
    expect(store).toContain("legacy_writer_retired");
  });

  it("the auditor run-skills route no longer imports the legacy snapshot store's writer", () => {
    const route = readFileSync(
      join(REPO_ROOT, "src/app/api/auditor/run-skills/route.ts"),
      "utf8",
    );
    expect(route).not.toContain("writeProposalSnapshot");
    expect(route).not.toContain("AuditorSnapshotError");
    // The response contract the WayFlow auditor OAS consumes is UNCHANGED.
    expect(route).toContain("Response.json({ preview, edited: editedSignal })");
    // ...and the module header no longer describes the retired write as current
    // behaviour (a doc that contradicts the code is a false contract claim).
    expect(route).toContain("Persistence: NONE");
  });

  it("the gate-bound successor DOES have a production writer", () => {
    const lane = files.find(
      (f) => f.path === "packages/agents/src/lifecycle-suggestion-producer-lane.ts",
    );
    expect(lane).toBeDefined();
    const store = readFileSync(
      join(REPO_ROOT, "packages/agents/src/gate-suggestion-snapshot-store.ts"),
      "utf8",
    );
    expect(store).toContain("export async function writeGateSuggestionSnapshot");
    expect(store).toMatch(/\.insert\(gateSuggestionSnapshots\)/);
  });

  it("nothing UPDATES a frozen suggestion snapshot — the row is immutable", () => {
    const updaters = files
      .filter((f) => /\.(update|delete)\(\s*gateSuggestionSnapshots/.test(f.source))
      .map((f) => f.path);
    expect(updaters).toEqual([]);
  });

  it("`/api/auditor/apply` — the deleted reader — is still gone", () => {
    expect(existsSync(join(REPO_ROOT, "src/app/api/auditor/apply"))).toBe(false);
  });
});
