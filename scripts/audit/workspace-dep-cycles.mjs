#!/usr/bin/env node
/**
 * Workspace dependency-cycle gate (no-new-rot ratchet).
 *
 * A "dependency cycle" is a set of first-party WORKSPACE packages that
 * (transitively) depend on each other through their `package.json` dependency
 * declarations — e.g. `@cinatra-ai/a` lists `@cinatra-ai/b` as a `workspace:*`
 * dep AND `@cinatra-ai/b` lists `@cinatra-ai/a`. Cycles force lazy imports,
 * make build/test ownership impossible to reason about one-directionally, and
 * block clean extraction of a package to its own repo. No existing gate catches
 * this class (the phantom-dep gate checks dependency COMPLETENESS, the
 * import-ban gates target core<->extension COUPLING — neither checks dependency
 * DIRECTION / acyclicity).
 *
 * The gate builds the directed graph over pnpm workspace members from their
 * declared deps (dependencies + devDependencies + peerDependencies +
 * optionalDependencies, restricted to OTHER workspace members), finds every
 * strongly-connected component (Tarjan) of size >= 2 (plus any self-loop), and
 * canonicalizes each to a rotation-invariant key (the sorted member set) so a
 * cycle's identity does not depend on traversal order. It is a monotonic
 * ratchet: a JSON baseline records the CURRENTLY-tolerated cycle keys; the gate
 * fails on any NEW cycle and on baseline GROWTH vs the base branch. Regenerate
 * (it should only ever SHRINK) with `--write-baseline`.
 *
 * Identity model (intentional): the cycle key is the SCC member SET, so a new
 * edge ADDED INSIDE an already-baselined SCC does not re-fail the gate. That is
 * the correct granularity for a package-cycle ratchet — the unit of debt is the
 * mutually-entangled package set, not each internal edge. A genuinely new cycle
 * (a new package set that becomes mutually dependent) always produces a new key.
 *
 * Node-builtins-only + offline (reads package.json + pnpm-workspace.yaml; the
 * base-ref ratchet shells out to `git`). No third-party graph dependency.
 *
 * Exit codes: 0 = clean (no new cycles), 1 = findings, 2 = scanner error.
 *
 * Usage:
 *   node scripts/audit/workspace-dep-cycles.mjs                  # gate (CI)
 *   node scripts/audit/workspace-dep-cycles.mjs --report         # list current cycles
 *   node scripts/audit/workspace-dep-cycles.mjs --write-baseline # (re)write baseline (only ever shrinks)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.cwd();
const WORKSPACE_FILE = join(REPO_ROOT, "pnpm-workspace.yaml");
const BASELINE_FILE = join(REPO_ROOT, "scripts/audit/workspace-dep-cycles.baseline.json");

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo", ".git"]);

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in __tests__/workspace-dep-cycles.test.mjs)
// ---------------------------------------------------------------------------

/** Parse the `packages:` glob list out of pnpm-workspace.yaml (no YAML dep). */
export function parseWorkspaceGlobs(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const globs = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages && /^\S/.test(line)) break; // next top-level key
    if (!inPackages) continue;
    const m = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
    if (m) globs.push(m[1].trim());
  }
  return globs;
}

/** Stable, rotation-invariant key for an SCC: the sorted member names joined.
 * Two traversals of the same mutually-dependent set produce the same key. */
export function cycleKey(members) {
  return [...members].sort().join(" <-> ");
}

/** Build the directed first-party dependency graph.
 * `packages` = [{ name, deps: Set<name> }] where deps are restricted to
 * workspace member names. Returns Map<name, name[]> (edges A -> B meaning
 * "A depends on B"), with edge lists sorted for determinism. A SELF-edge (a
 * package declaring itself as a dependency) is RETAINED — it is a degenerate
 * cycle the gate should flag, and detectCycles() reports it as a single-member
 * cycle. Only NON-member (external) specifiers are dropped. */
export function buildGraph(packages) {
  const names = new Set(packages.map((p) => p.name));
  const graph = new Map();
  for (const p of packages) {
    const edges = [...p.deps].filter((d) => names.has(d)).sort();
    graph.set(p.name, edges);
  }
  return graph;
}

/** Tarjan strongly-connected components over a Map<node, node[]> adjacency.
 * Returns SCCs as arrays of node names. Iterative (no recursion → no stack
 * overflow on a large graph). Order within/among SCCs is not significant; the
 * caller canonicalizes via cycleKey. */
export function tarjanSCC(graph) {
  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  const nodes = [...graph.keys()];

  for (const start of nodes) {
    if (indices.has(start)) continue;
    // Iterative DFS. Each work item tracks which neighbor we are at.
    const work = [{ node: start, i: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const { node } = frame;
      if (frame.i === 0) {
        indices.set(node, index);
        lowlink.set(node, index);
        index++;
        stack.push(node);
        onStack.add(node);
      }
      const neighbors = graph.get(node) ?? [];
      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i];
        frame.i++;
        if (!indices.has(w)) {
          work.push({ node: w, i: 0 });
        } else if (onStack.has(w)) {
          lowlink.set(node, Math.min(lowlink.get(node), indices.get(w)));
        }
      } else {
        // Done with node's neighbors → close it.
        if (lowlink.get(node) === indices.get(node)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.push(w);
          } while (w !== node);
          sccs.push(comp);
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].node;
          lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(node)));
        }
      }
    }
  }
  return sccs;
}

/** Detect cycles in the graph. A cycle is (a) an SCC of size >= 2 (mutually
 * dependent set, possibly via a longer chain A->B->C->A), or (b) a self-loop
 * (a package that declares itself — degenerate but worth flagging). Returns a
 * sorted array of { key, members } with members sorted. */
export function detectCycles(graph) {
  const cycles = [];
  for (const comp of tarjanSCC(graph)) {
    if (comp.length >= 2) {
      const members = [...comp].sort();
      cycles.push({ key: cycleKey(members), members });
    } else if (comp.length === 1) {
      const only = comp[0];
      if ((graph.get(only) ?? []).includes(only)) {
        cycles.push({ key: cycleKey([only]), members: [only] });
      }
    }
  }
  return cycles.sort((a, b) => a.key.localeCompare(b.key));
}

/** Compare detected cycles against a baseline. Returns the cycles whose key is
 * NOT in the baseline (the NEW cycles). */
export function diffAgainstBaseline(cycles, baseline) {
  const known = new Set(baseline?.cycles?.map((c) => c.key) ?? []);
  return cycles.filter((c) => !known.has(c.key));
}

/** Base-ref ratchet: keys in the COMMITTED baseline that are ABSENT from the
 * BASE-branch baseline — i.e. a regenerate-to-pass bypass that added new
 * tolerated cycles in the same PR. Mirrors the sibling no-new-rot gates so the
 * baseline can only ever SHRINK. */
export function baselineGrowth(baseBaseline, committedBaseline) {
  const baseKeys = new Set(baseBaseline?.cycles?.map((c) => c.key) ?? []);
  const grew = [];
  for (const c of committedBaseline?.cycles ?? []) if (!baseKeys.has(c.key)) grew.push(c.key);
  return grew.sort();
}

// ---------------------------------------------------------------------------
// Filesystem scan
// ---------------------------------------------------------------------------

function expandGlob(pattern) {
  // One-level-per-segment glob: supports `*` (and prefix*/*-suffix) within a
  // single path segment; no `**`. Returns existing directories.
  const segs = pattern.split("/");
  let dirs = [REPO_ROOT];
  for (const seg of segs) {
    const next = [];
    const hasWild = seg.includes("*");
    const re = hasWild ? new RegExp("^" + seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$") : null;
    for (const d of dirs) {
      if (!hasWild) { const p = join(d, seg); if (existsSync(p) && statSync(p).isDirectory()) next.push(p); continue; }
      let entries;
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && re.test(e.name)) next.push(join(d, e.name));
    }
    dirs = next;
  }
  return dirs;
}

function readPackage(dir) {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    if (!pkg.name) return null;
    const deps = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
    return { name: pkg.name, dir, deps };
  } catch { return null; }
}

/** Discover workspace members matched by the pnpm-workspace globs (the same set
 * the sibling phantom-dep gate scans). The ROOT app (`.`) is intentionally
 * excluded — it consumes workspace packages via Next.js transpilePackages +
 * tsconfig paths, not package.json `dependencies`, is never depended ON by a
 * published package, and is deployed as a standalone build, so it cannot be part
 * of a package dependency cycle. */
export function discoverMembers() {
  const globs = parseWorkspaceGlobs(readFileSync(WORKSPACE_FILE, "utf8"));
  const byDir = new Map();
  for (const g of globs) for (const dir of expandGlob(g)) {
    const pkg = readPackage(dir);
    if (pkg) byDir.set(dir, pkg);
  }
  return [...byDir.values()];
}

function scan() {
  const members = discoverMembers();
  const graph = buildGraph(members);
  const cycles = detectCycles(graph);
  return { cycles, graph, memberCount: members.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write-baseline");
  const report = args.includes("--report");
  let result;
  try { result = scan(); } catch (err) {
    console.error(`[workspace-dep-cycles] scanner error: ${err?.stack ?? err}`);
    process.exit(2);
  }
  const { cycles, graph, memberCount } = result;

  if (write) {
    const baseline = {
      note: "Workspace dependency-cycle baseline (no-new-rot ratchet). Each entry is a known package dependency cycle (a strongly-connected set of first-party workspace packages). These are CURRENT tolerated cycles; the gate fails on any NEW cycle and on baseline growth. The cycle key is the sorted SCC member set, so identity is traversal-order-independent. Regenerate with `node scripts/audit/workspace-dep-cycles.mjs --write-baseline` — every entry should only ever be REMOVED (break the cycle via a one-directional `*-contracts` package), never added.",
      cycles,
    };
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`[workspace-dep-cycles] wrote baseline: ${cycles.length} cycle(s) (scanned ${memberCount} members).`);
    return;
  }

  if (report) {
    console.log(`[workspace-dep-cycles] ${memberCount} members scanned; ${cycles.length} cycle(s):`);
    for (const c of cycles) {
      console.log(`  ${c.key}`);
      for (const m of c.members) {
        const intra = (graph.get(m) ?? []).filter((d) => c.members.includes(d));
        if (intra.length) console.log(`      ${m} -> ${intra.join(", ")}`);
      }
    }
    return;
  }

  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : { cycles: [] };

  // Base-ref ratchet: block the regenerate-to-pass bypass (introduce a cycle +
  // `--write-baseline` in the same PR). When WORKSPACE_DEP_CYCLES_BASE is set
  // (wired from the CI base ref), fail if the committed baseline contains any
  // cycle key absent from the base-branch baseline. Mirrors the sibling
  // no-new-rot gates; fail-closed if the ref can't be resolved.
  const baseRef = process.env.WORKSPACE_DEP_CYCLES_BASE;
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[workspace-dep-cycles] FAIL — WORKSPACE_DEP_CYCLES_BASE="${baseRef}" is flag-like.`);
      process.exit(1);
    }
    let refResolves = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "ignore"] });
      refResolves = true;
    } catch { refResolves = false; }
    if (!refResolves) {
      console.error(`[workspace-dep-cycles] FAIL — WORKSPACE_DEP_CYCLES_BASE="${baseRef}" did not resolve (shallow checkout / misconfig?). Failing closed — ensure the base ref is fetched (fetch-depth: 0).`);
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:scripts/audit/workspace-dep-cycles.baseline.json`], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    if (baseText) {
      const grew = baselineGrowth(JSON.parse(baseText), baseline);
      if (grew.length) {
        console.error(`[workspace-dep-cycles] FAIL — committed baseline GREW vs ${baseRef} (regenerate-to-pass bypass):`);
        grew.forEach((e) => console.error("  + " + e));
        process.exit(1);
      }
    }
  }

  const newCycles = diffAgainstBaseline(cycles, baseline);

  if (newCycles.length === 0) {
    console.log(`[workspace-dep-cycles] OK — no new dependency cycles (scanned ${memberCount} members; ${baseline.cycles?.length ?? 0} baselined).`);
    process.exit(0);
  }
  console.error(`[workspace-dep-cycles] FAIL — ${newCycles.length} NEW dependency cycle${newCycles.length === 1 ? "" : "s"}:`);
  for (const c of newCycles) {
    console.error(`  ${c.key}`);
    for (const m of c.members) {
      const intra = (graph.get(m) ?? []).filter((d) => c.members.includes(d));
      if (intra.length) console.error(`      ${m} -> ${intra.join(", ")}`);
    }
  }
  console.error(`\nBreak the cycle by extracting the shared types/runtime into a one-directional \`*-contracts\` package so the dependency points one way. If this cycle is unavoidable debt, regenerate the baseline with --write-baseline (it should only ever shrink).`);
  process.exit(1);
}

// Only run the gate when executed directly — importing for unit tests must not
// trigger the scan or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
