// The inventory guard for `RUN_CREATION_CALL_SITES` (cinatra#2813 S1).
//
// The inventory is only worth having if it cannot rot. This suite WALKS THE
// SOURCE for calls to the run-creation primitives and refuses any it was not
// told about — so a new writer that creates a run without a snapshot
// disposition fails here rather than shipping a run whose assignment scope
// nobody decided.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RUN_PRODUCERS, UNROUTED_PRODUCERS } from "../lifecycle-coordinator";
import {
  PRODUCERS_BEHIND_CALL_SITES,
  RUN_CREATION_CALL_SITES,
  RUN_CREATION_PRIMITIVES,
} from "./run-creation-call-sites";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");
const SCAN_ROOTS = ["packages", "src", "extensions"];
/** The store module DEFINES the primitives; it is not a call site. */
const DEFINITION_MODULE = "packages/agents/src/store.ts";

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) yield* walk(full);
    else if (s.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) yield full;
  }
}

/** Every production module that CALLS a run-creation primitive. Comments,
 *  import lists, re-exports and test files are not call sites. */
function scanCallingModules(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const callRe = new RegExp(`\\b(${RUN_CREATION_PRIMITIVES.join("|")})\\s*\\(`, "g");
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, file).replaceAll("\\", "/");
      if (rel.includes("__tests__") || rel.includes(".test.")) continue;
      if (rel === DEFINITION_MODULE) continue;
      const source = readFileSync(file, "utf8");
      // An ALIASED import calls the same primitive under another name, and a
      // scan for the literal names alone would never see it. Every local alias
      // is added to this file's call pattern and recorded under the PRIMITIVE
      // it stands for, so the inventory keeps naming primitives.
      const aliasRe = new RegExp(
        `\\b(${RUN_CREATION_PRIMITIVES.join("|")})\\s+as\\s+([A-Za-z_$][\\w$]*)`,
        "g",
      );
      const aliasMap = new Map<string, string>();
      for (const a of source.matchAll(aliasRe)) aliasMap.set(a[2], a[1]);
      const fileCallRe = aliasMap.size
        ? new RegExp(
            `\\b(${[...RUN_CREATION_PRIMITIVES, ...aliasMap.keys()].join("|")})\\s*\\(`,
            "g",
          )
        : callRe;
      for (const line of source.split("\n")) {
        const trimmed = line.trim();
        // Prose about the primitives is not a call to them.
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        fileCallRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = fileCallRe.exec(line))) {
          // `export function createAgentRun(` is a declaration, not a call.
          if (/\b(function|export)\s+[A-Za-z]*$/.test(line.slice(0, m.index))) continue;
          const set = found.get(rel) ?? new Set<string>();
          set.add(aliasMap.get(m[1]) ?? m[1]);
          found.set(rel, set);
        }
      }
    }
  }
  return found;
}

describe("run-creation call sites — the inventory is complete", () => {
  const scanned = scanCallingModules();

  it("names at least one call site", () => {
    expect(RUN_CREATION_CALL_SITES.length).toBeGreaterThan(0);
  });

  it("every module the source calls a run-creation primitive from is inventoried", () => {
    const inventoried = new Set(RUN_CREATION_CALL_SITES.map((c) => c.module));
    const strangers = [...scanned.keys()].filter((m) => !inventoried.has(m));
    expect(
      strangers,
      `A production module creates runs without an entry in run-creation-call-sites.ts. Add it, WITH its snapshot disposition and its launch anchor. Strangers: ${strangers.join(", ")}`,
    ).toEqual([]);
  });

  it("every inventoried (module, primitive) pair really exists in the source", () => {
    const stale = RUN_CREATION_CALL_SITES.filter(
      (c) => !scanned.get(c.module)?.has(c.entry),
    ).map((c) => `${c.module}:${c.entry}`);
    expect(stale, `Inventory entries with no call behind them: ${stale.join(", ")}`).toEqual([]);
  });
});

describe("run-creation call sites — every entry states its dispositions", () => {
  it.each(RUN_CREATION_CALL_SITES.map((c) => [`${c.module}:${c.entry}`, c] as const))(
    "%s carries a snapshot disposition and a non-empty launch anchor",
    (_name, site) => {
      expect(["derived_at_store", "supplied_by_caller"]).toContain(site.snapshot);
      expect(site.launchAnchor.trim().length).toBeGreaterThan(0);
      expect(site.what.trim().length).toBeGreaterThan(0);
    },
  );

  it("no run is created without a decided assignment scope", () => {
    // Both dispositions are answers. The failure this guards is a THIRD state —
    // a site that creates a run and leaves the scope to chance — which can only
    // enter the inventory as a new disposition member.
    for (const site of RUN_CREATION_CALL_SITES) {
      expect(site.snapshot).not.toBeUndefined();
    }
  });
});

describe("run-creation call sites — the producers behind them", () => {
  it("stands for every named run producer", () => {
    expect([...PRODUCERS_BEHIND_CALL_SITES].sort()).toEqual(
      RUN_PRODUCERS.map((p) => p.key).sort(),
    );
  });

  it("every producer reaches the primitives through the launch fence", () => {
    // An unrouted producer would be a run born outside the fence — and therefore
    // outside the snapshot. The coordinator's own list must stay empty.
    expect(UNROUTED_PRODUCERS.map((p) => p.key)).toEqual([]);
  });
});
