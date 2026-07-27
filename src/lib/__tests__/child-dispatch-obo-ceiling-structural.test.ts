/**
 * STRUCTURAL OBO-ceiling guard for child agent-run dispatch (epic W5 / #1035).
 *
 * The deleted release-workflow `agent_task` executor was the ONE dispatch path
 * that spawned a child agent run WITHOUT threading the parent run's persisted
 * OBO scope-ceiling chain (the un-ceilinged path, deferred in #1271 because the
 * engine was being deleted). This test proves nothing like it survives the
 * engine deletion — and, critically, that a NEW un-ceilinged dispatch path
 * cannot be added silently.
 *
 * It is REGISTRY-DRIVEN + GREP-ANCHORED, not a hard-coded allow-list of the
 * three known sites:
 *
 *   1. It STATICALLY scans the whole product tree (src/ + packages/{*}/src,
 *      excluding tests/dist/node_modules) for EVERY `createAgentRun(` call site
 *      — createAgentRun is the single dispatch primitive; a partial-unique
 *      idempotency insert is its only inserter (asserted below), so every child
 *      run is minted here.
 *   2. Each call-site FILE must appear in DISPATCH_SITES with an explicit
 *      classification. A newly-added call site in an unlisted file FAILS the
 *      completeness assertion — forcing the author to classify it.
 *   3. Every site classified "child-dispatch" (spawns a child run under an
 *      active parent agent run) MUST pass `parentOboCeiling` in its call — the
 *      store folds it onto the freshly-derived child anchor via the shared
 *      compose primitive and throws OboCeilingCompositionError on a
 *      provably-disjoint chain (fail-closed). A "child-dispatch" site missing
 *      `parentOboCeiling` FAILS.
 *   4. `db.insert(agentRuns)` may live ONLY in the store (the primitive), so no
 *      code can bypass createAgentRun to mint an un-ceilinged child run.
 *
 * A pure static test — no DB, no runtime. The behavioural proof that the ceiling
 * is SERVER-READ (never client input) + composed satisfy-all lives in
 * project-dispatch-primitive.test.ts and agent-run-obo-ceiling-composition.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

// Roots scanned for createAgentRun call sites (product code only).
const SCAN_ROOTS = ["src", "packages"];

/**
 * The COMPLETE classification of every product-code createAgentRun call site,
 * keyed by repo-relative file path.
 *
 *  - "child-dispatch": spawns a child run UNDER an active parent agent run; the
 *    parent's persisted ceiling chain MUST be threaded (`parentOboCeiling`) so
 *    the child anchor is bounded by (composed with) the parent's authority.
 *  - "top-level": a user / session / registry / external-peer ENTRY run with no
 *    parent run to compose from — its OBO anchor is derived fresh at mint, not
 *    composed. These MUST NOT invent a parentOboCeiling.
 *
 * A file must be listed here to have a createAgentRun call at all (completeness
 * check below). `why` documents the classification for the next reader.
 */
const DISPATCH_SITES: Record<string, { role: "child-dispatch" | "top-level"; why: string }> = {
  "packages/agents/src/lifecycle-repair-dispatch-store.ts": {
    role: "child-dispatch",
    why:
      "cinatra#2047 D-1: the lifecycle repair DELIVERY mints a repair run under the " +
      "PRODUCING run — threads that run's server-read persisted oboCeiling.",
  },
  "src/lib/project-dispatch.ts": {
    role: "child-dispatch",
    why: "PM-seat tick dispatches a worker agent under the PM run — threads the parent run's server-read oboCeiling.",
  },
  "packages/a2a/src/agent-executor.ts": {
    role: "child-dispatch",
    why: "A2A inbound execution under an OBO actor frame — threads actorCtx.oboCeiling.",
  },
  "packages/agents/src/mcp/agent-tools-registry.ts": {
    role: "child-dispatch",
    why: "agent-as-tool: an agent run invokes another agent — threads ctx.oboCeiling from the ALS trust anchor.",
  },
  "src/lib/host-content-editor-dispatch.ts": {
    role: "top-level",
    why: "host per-user content-editor widget dispatch — carries the USER's fresh OBO identity (anchor), not a parent run's ceiling.",
  },
  "packages/agents/src/a2a-actions.ts": {
    role: "top-level",
    why: "external A2A entry from a peer — no parent run on this branch (documented at the call site).",
  },
  "packages/agents/src/actions.ts": {
    role: "top-level",
    why: "runFromRegistry server action — user-initiated, not chat/parent-bound.",
  },
  "packages/agents/src/mcp/handlers.ts": {
    role: "top-level",
    why: "the agent_run MCP tool — the top-level chat/API entry; agent-as-tool child dispatch goes through agent-tools-registry, not here.",
  },
};

/** Recursively collect product .ts/.tsx files under a root (no tests/dist/node_modules). */
function collectFiles(dir: string, out: string[] = []): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "__tests__") continue;
      collectFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Extract the balanced-paren argument text of the call opening at `openParen`. */
function balancedArgs(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(openParen, i + 1);
    }
  }
  return src.slice(openParen); // unbalanced (shouldn't happen) — whole tail
}

type Site = { file: string; args: string };

/** Every createAgentRun CALL site (not the definition/import) in the product tree. */
function findCreateAgentRunCallSites(): Site[] {
  const sites: Site[] = [];
  const files = SCAN_ROOTS.flatMap((r) => collectFiles(join(ROOT, r)));
  const CALL = /createAgentRun\s*\(/g;
  for (const abs of files) {
    const src = readFileSync(abs, "utf8");
    const rel = abs.slice(ROOT.length + 1);
    let m: RegExpExecArray | null;
    CALL.lastIndex = 0;
    while ((m = CALL.exec(src)) !== null) {
      const before = src.slice(Math.max(0, m.index - 40), m.index);
      // Skip the definition and any import/type reference — we want invocations.
      if (/\bfunction\s+$/.test(before) || /\bimport\b[^\n]*$/.test(before)) continue;
      // Skip matches inside a `//` line comment or a `*`/`/*` block-comment line.
      const lineBefore = src.slice(src.lastIndexOf("\n", m.index) + 1, m.index);
      const trimmed = lineBefore.trimStart();
      if (lineBefore.includes("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      const openParen = m.index + m[0].length - 1;
      sites.push({ file: rel, args: balancedArgs(src, openParen) });
    }
  }
  return sites;
}

describe("child-dispatch OBO-ceiling structural guard (#1035)", () => {
  const sites = findCreateAgentRunCallSites();

  it("scanned a non-empty set of createAgentRun call sites (scanner sanity)", () => {
    // Guards against the walker false-greening on an empty tree.
    expect(sites.length).toBeGreaterThanOrEqual(3);
    // The canonical child-dispatch primitive is reached.
    expect(sites.some((s) => s.file === "src/lib/project-dispatch.ts")).toBe(true);
  });

  it("every createAgentRun call site is CLASSIFIED (a new dispatch path fails closed)", () => {
    const unclassified = [...new Set(sites.map((s) => s.file))].filter((f) => !(f in DISPATCH_SITES));
    expect(
      unclassified,
      `NEW createAgentRun call site(s) not in DISPATCH_SITES — classify each as "child-dispatch" ` +
        `(and thread parentOboCeiling) or "top-level":\n  ${unclassified.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every CHILD-DISPATCH call site threads the parent OBO ceiling (no un-ceilinged child path survives)", () => {
    const offenders: string[] = [];
    for (const s of sites) {
      const entry = DISPATCH_SITES[s.file];
      if (!entry || entry.role !== "child-dispatch") continue;
      if (!/parentOboCeiling/.test(s.args)) offenders.push(s.file);
    }
    expect(
      offenders,
      `child-dispatch createAgentRun call(s) missing parentOboCeiling (the un-ceilinged path #1035 forbids):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("createAgentRun is the ONLY inserter of agent_runs rows (no bypass of the ceiling primitive)", () => {
    const files = SCAN_ROOTS.flatMap((r) => collectFiles(join(ROOT, r)));
    const INSERT = /\.insert\s*\(\s*agentRuns\b/;
    const inserters = files
      .filter((abs) => INSERT.test(readFileSync(abs, "utf8")))
      .map((abs) => abs.slice(ROOT.length + 1));
    // The store is the sole primitive; every insert (createAgentRun +
    // createAgentRunPendingInput) lives there and derives/threads the ceiling.
    expect(inserters).toEqual(["packages/agents/src/store.ts"]);
  });

  it("the deleted un-ceilinged workflow executor is gone (no workflow-*executor dispatch file survives)", () => {
    const files = SCAN_ROOTS.flatMap((r) => collectFiles(join(ROOT, r)));
    const survivors = files
      .map((abs) => abs.slice(ROOT.length + 1))
      .filter((rel) => /workflow.*executor\.tsx?$/.test(rel));
    expect(survivors).toEqual([]);
  });
});
