#!/usr/bin/env node
/**
 * File-size ratchet gate (no-new-rot ratchet).
 *
 * Several files have become architecture bottlenecks by size AND responsibility
 * (`packages/agents/src/mcp/handlers.ts`, `src/lib/drizzle-store.ts`,
 * `packages/agents/src/store.ts`, the chat page, the skills store, the MCP
 * server entry, the background-jobs runtime, `database.ts`, the
 * extension-install pipeline, the boot instrumentation). Each is a hub that
 * accretes responsibilities; left unguarded they keep growing while the P1
 * refactors are in flight. This gate is the GUARDRAIL: it pins the CURRENT line
 * count of each tracked bottleneck file as a baseline and fails CI when a
 * tracked file grows BEYOND its baseline. It forces NO refactor (baselines are
 * set at current state); it only prevents the listed hubs from growing further,
 * and the baseline ratchets DOWN as extractions land (thin facades + vertical
 * slices). This is the file-level sibling of the package-level
 * workspace-dep-cycles ratchet — same fail-closed, base-ref, regenerate-to-pass-
 * blocked shape.
 *
 * Metric: physical line count (`\n`-delimited records; a trailing newline is the
 * record terminator, not an extra empty record). Line count is the cheapest,
 * most legible proxy for module bloat, has zero parse dependency (a .mjs gate
 * cannot import the project's .ts toolchain), and is exactly what the epic asks
 * for ("tracked file size"). Complexity is intentionally left to a future
 * extension of this same baseline shape — the ratchet contract (a per-file
 * numeric ceiling that can only shrink) generalizes unchanged.
 *
 * Ratchet semantics:
 *  - A tracked file ABOVE its baseline → FAIL (the named hub grew).
 *  - A tracked file AT/BELOW its baseline → OK (a shrink is always allowed; the
 *    baseline is the CEILING, not an exact target, so a refactor PR is never
 *    forced to re-run `--write-baseline` to stay green — but SHOULD, to lock the
 *    win in).
 *  - A tracked file that no longer exists → FAIL (a baseline entry must track a
 *    real file; a rename must be reflected in the baseline so the ceiling moves
 *    with the file, not silently lost).
 *  - Base-ref ratchet (WORKSPACE_FILE_SIZE_RATCHET_BASE / CI base ref): the
 *    committed baseline may only ever SHRINK or stay equal vs the base branch.
 *    A baseline RAISED for any file (or a file ADDED with a higher ceiling than
 *    the base had) is the regenerate-to-pass bypass and FAILS. Removing a file
 *    from tracking is allowed (a file can be split out of existence) but never
 *    silently raising a ceiling. Fail-closed if the ref can't be resolved.
 *
 * Node-builtins-only + offline (reads the tracked source files + the baseline;
 * the base-ref ratchet shells out to `git`). No third-party dependency.
 *
 * Exit codes: 0 = clean (no file over baseline), 1 = findings, 2 = scanner error.
 *
 * Usage:
 *   node scripts/audit/file-size-ratchet.mjs                  # gate (CI)
 *   node scripts/audit/file-size-ratchet.mjs --report         # current sizes vs baseline
 *   node scripts/audit/file-size-ratchet.mjs --write-baseline # (re)write baseline to current sizes (should only ever shrink)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.cwd();
const BASELINE_FILE = join(REPO_ROOT, "scripts/audit/file-size-ratchet.baseline.json");

/**
 * The tracked bottleneck files. Repo-root-relative POSIX paths. This
 * is the source-of-truth SET; the baseline records the per-file ceiling. To add
 * a file to the ratchet, add it here AND regenerate the baseline. To stop
 * tracking a file (e.g. it was split out of existence), remove it from here AND
 * the baseline.
 */
export const TRACKED_FILES = [
  "packages/agents/src/mcp/handlers.ts",
  "src/lib/drizzle-store.ts",
  "packages/agents/src/store.ts",
  "packages/chat/src/chat-page.tsx",
  "packages/skills/src/skills-store.ts",
  "packages/mcp-server/src/index.tsx",
  "src/lib/background-jobs.ts",
  "src/lib/database.ts",
  "src/lib/extension-install-pipeline.ts",
  "src/instrumentation.node.ts",
];

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in __tests__/file-size-ratchet.test.mjs)
// ---------------------------------------------------------------------------

/** Count physical lines in a file's text. A `\n`-terminated last line is NOT an
 * extra empty record (so `"a\nb\n"` is 2 lines, matching `wc -l`+1-free intent
 * and most editors' "line N" display). An empty file is 0 lines. Text WITHOUT a
 * trailing newline counts its final partial line. */
export function countLines(text) {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  // The chars after the last "\n" (if any) form a final unterminated line.
  if (text.charCodeAt(text.length - 1) !== 10) n++;
  return n;
}

/** Compare current per-file sizes against the baseline ceilings. Returns
 * structured findings. `sizes` = Map<path, number|null> (null = file missing).
 * `baseline` = { files: { [path]: number } }. A file OVER its ceiling, or a
 * tracked file that is MISSING, is a violation; a file at/below ceiling is OK. */
export function diffAgainstBaseline(sizes, baseline) {
  const ceilings = baseline?.files ?? {};
  const over = [];
  const missing = [];
  for (const [path, size] of sizes) {
    const ceiling = ceilings[path];
    if (ceiling === undefined) {
      // A tracked file with no baseline ceiling = baseline drift (file added to
      // TRACKED_FILES but baseline not regenerated). Treat as a violation so the
      // set and the baseline can never silently diverge.
      missing.push({ path, reason: "no baseline ceiling (regenerate the baseline)" });
      continue;
    }
    if (size === null) {
      missing.push({ path, reason: "tracked file missing (a rename must update the baseline)" });
      continue;
    }
    if (size > ceiling) over.push({ path, size, ceiling, delta: size - ceiling });
  }
  return { over: over.sort((a, b) => a.path.localeCompare(b.path)), missing: missing.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Base-ref ratchet: per-file ceilings in the COMMITTED baseline that are
 * HIGHER than the BASE-branch baseline (or NET-NEW files with a ceiling) — i.e.
 * a regenerate-to-pass bypass that raised a ceiling in the same PR. Mirrors the
 * sibling no-new-rot gates so each ceiling can only ever SHRINK (or a file be
 * dropped from tracking). Returns sorted `{ path, base, committed }`. */
export function baselineGrowth(baseBaseline, committedBaseline) {
  const baseFiles = baseBaseline?.files ?? {};
  const committedFiles = committedBaseline?.files ?? {};
  const grew = [];
  for (const [path, committed] of Object.entries(committedFiles)) {
    const base = baseFiles[path];
    if (base === undefined) {
      // Net-new tracked file. Allowed ONLY if it does not exceed what the base
      // branch already tolerated — but the base had no entry, so any positive
      // ceiling is a new tolerated ceiling. We do NOT block adding genuinely new
      // tracked files (that EXPANDS coverage, which is good), so a net-new entry
      // is NOT growth. Growth is strictly RAISING an EXISTING file's ceiling.
      continue;
    }
    if (committed > base) grew.push({ path, base, committed });
  }
  return grew.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Filesystem scan
// ---------------------------------------------------------------------------

/** Read each tracked file and return Map<path, lineCount|null> (null = missing). */
function scanSizes() {
  const sizes = new Map();
  for (const rel of TRACKED_FILES) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) {
      sizes.set(rel, null);
      continue;
    }
    sizes.set(rel, countLines(readFileSync(abs, "utf8")));
  }
  return sizes;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write-baseline");
  const report = args.includes("--report");

  let sizes;
  try {
    sizes = scanSizes();
  } catch (err) {
    console.error(`[file-size-ratchet] scanner error: ${err?.stack ?? err}`);
    process.exit(2);
  }

  if (write) {
    const files = {};
    for (const rel of TRACKED_FILES) {
      const size = sizes.get(rel);
      if (size === null) {
        console.error(`[file-size-ratchet] cannot write baseline — tracked file missing: ${rel}`);
        process.exit(2);
      }
      files[rel] = size;
    }
    const baseline = {
      note: "File-size ratchet baseline (no-new-rot ratchet). Each entry is the CURRENT line-count ceiling for a tracked architecture-bottleneck file. The gate fails when a tracked file grows BEYOND its ceiling and when the committed baseline raises any ceiling vs the base branch. Regenerate with `node scripts/audit/file-size-ratchet.mjs --write-baseline` — a ceiling should only ever be LOWERED as extractions land (thin facades + vertical slices), never raised. Add/remove a tracked file via TRACKED_FILES in the gate, then regenerate.",
      files,
    };
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`[file-size-ratchet] wrote baseline: ${TRACKED_FILES.length} tracked file(s).`);
    return;
  }

  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : { files: {} };

  if (report) {
    console.log(`[file-size-ratchet] ${TRACKED_FILES.length} tracked file(s); current size vs ceiling:`);
    const ceilings = baseline.files ?? {};
    for (const rel of TRACKED_FILES) {
      const size = sizes.get(rel);
      const ceiling = ceilings[rel];
      const sizeStr = size === null ? "MISSING" : String(size);
      const headroom = size !== null && ceiling !== undefined ? ceiling - size : null;
      console.log(`  ${sizeStr.padStart(7)} / ${String(ceiling ?? "-").padStart(7)}  ${headroom !== null ? `(headroom ${headroom})` : ""}  ${rel}`);
    }
    return;
  }

  // Base-ref ratchet: block the regenerate-to-pass bypass (raise a ceiling +
  // `--write-baseline` in the same PR). When WORKSPACE_FILE_SIZE_RATCHET_BASE is
  // set (wired from the CI base ref), fail if the committed baseline raised any
  // existing file's ceiling vs the base-branch baseline. Mirrors the sibling
  // no-new-rot gates; fail-closed if the ref can't be resolved.
  const baseRef = process.env.WORKSPACE_FILE_SIZE_RATCHET_BASE;
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[file-size-ratchet] FAIL — WORKSPACE_FILE_SIZE_RATCHET_BASE="${baseRef}" is flag-like.`);
      process.exit(1);
    }
    let refResolves = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "ignore"] });
      refResolves = true;
    } catch { refResolves = false; }
    if (!refResolves) {
      console.error(`[file-size-ratchet] FAIL — WORKSPACE_FILE_SIZE_RATCHET_BASE="${baseRef}" did not resolve (shallow checkout / misconfig?). Failing closed — ensure the base ref is fetched (fetch-depth: 0).`);
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:scripts/audit/file-size-ratchet.baseline.json`], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    if (baseText) {
      const grew = baselineGrowth(JSON.parse(baseText), baseline);
      if (grew.length) {
        console.error(`[file-size-ratchet] FAIL — committed baseline RAISED a ceiling vs ${baseRef} (regenerate-to-pass bypass):`);
        grew.forEach((g) => console.error(`  + ${g.path}: ${g.base} -> ${g.committed}`));
        process.exit(1);
      }
    }
  }

  const { over, missing } = diffAgainstBaseline(sizes, baseline);

  if (over.length === 0 && missing.length === 0) {
    console.log(`[file-size-ratchet] OK — no tracked bottleneck file exceeds its baseline (${TRACKED_FILES.length} files tracked).`);
    process.exit(0);
  }

  if (over.length) {
    console.error(`[file-size-ratchet] FAIL — ${over.length} tracked file${over.length === 1 ? "" : "s"} grew beyond baseline:`);
    for (const o of over) console.error(`  ${o.path}: ${o.size} lines (ceiling ${o.ceiling}, +${o.delta})`);
  }
  if (missing.length) {
    console.error(`[file-size-ratchet] FAIL — ${missing.length} tracked file${missing.length === 1 ? "" : "s"} cannot be checked:`);
    for (const m of missing) console.error(`  ${m.path}: ${m.reason}`);
  }
  console.error(`\nThese are baselined architecture bottlenecks; the ratchet only prevents them from growing. Extract via a thin facade + vertical slices, then LOWER the baseline with --write-baseline (a ceiling may only ever shrink). A rename must update the baseline so the ceiling moves with the file.`);
  process.exit(1);
}

// Only run the gate when executed directly — importing for unit tests must not
// trigger the scan or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
