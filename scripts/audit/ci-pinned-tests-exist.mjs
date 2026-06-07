#!/usr/bin/env node
// CI guard: every test file explicitly pinned in a workflow `vitest run` /
// `node --test` invocation MUST exist on disk.
//
// Why this exists: `vitest run a.test.ts b.test.ts` treats positionals as
// FILTERS. If one positional matches zero files, vitest SILENTLY ignores it as
// long as the others match — the step still passes. So a pinned test that was
// renamed/lost (e.g. dropped in a rebase) leaves its pin behind and CI stays
// green while advertising coverage it no longer has. This guard is the
// secondary tripwire that turns that silent gap into a hard failure.
//
// Approach (decompose, don't fully parse a shell): extract each workflow `run:`
// block, split it into `&&`/newline segments, and for any segment that invokes a
// test runner collect its positional `*.test.{ts,tsx,mjs,mts,js}` tokens. The
// invocation cwd is resolved from step-level `working-directory:`, in-script
// `cd <dir>`, and `pnpm --filter <pkg>` (mapped to the package dir); a token is
// satisfied when a tracked test path is BOTH under that cwd AND a path-suffix of
// the token (vitest filters by path substring). With no resolvable cwd it falls
// back to a plain path-suffix match. Glob tokens (containing `*`) and
// `--exclude/--reporter/--config/--project` values are skipped.
//
// Residuals it intentionally does NOT model (documented, not silent) — these
// degrade to the still-sound path-suffix fallback, never a false POSITIVE:
// job-level `defaults.run.working-directory`, `--filter` by glob/path (non-name),
// variable-indirection paths, dynamically-built filenames, and indirectly
// launched runners. Rare, and out of scope for an existence check.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, posix } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

const RUNNER_RE = /\bvitest\s+run\b|\bnode\s+--test\b/;
const TEST_TOKEN_RE = /(?:^|[\s'"=])([\w@./-]+\.test\.(?:tsx|ts|mjs|mts|js))(?=$|[\s'"&;])/g;
const SKIP_AFTER_FLAGS = new Set(["--exclude", "--reporter", "--config", "--project"]);

// Extract every `run:` script body from a workflow YAML. Handles inline
// `run: cmd`, list-item `- run: cmd`, and block scalars `run: |` (literal —
// newlines are command separators) / `run: >-` (folded — newlines are spaces,
// so a single `vitest run` spans continuation lines). Returns
// { body, fold: "inline"|"folded"|"literal", startLine }.
export function extractRunBlocks(yamlText) {
  const lines = yamlText.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(- )?run:\s?(.*)$/);
    if (!m) continue;
    // keyIndent = the column of the `run` KEY (2 past the `- ` marker when the
    // run line carries it); step keys all share this column.
    const keyIndent = m[1].length + (m[2] ? 2 : 0);
    const baseCwd = stepWorkingDirectory(lines, i, keyIndent);
    const inline = m[3];
    const scalar = inline.trim().match(/^([|>])[+-]?\d*\s*$/);
    if (inline.trim() && !scalar) {
      blocks.push({ body: inline, fold: "inline", baseCwd, startLine: i + 1 });
      continue;
    }
    const fold = scalar && scalar[1] === ">" ? "folded" : "literal";
    // Block scalar: collect following lines indented deeper than the key.
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const ln = lines[j];
      if (ln.trim() === "") { body.push(""); continue; }
      const indent = ln.length - ln.trimStart().length;
      if (indent <= keyIndent) break;
      body.push(ln);
    }
    blocks.push({ body: body.join("\n"), fold, baseCwd, startLine: i + 1 });
    i = j - 1;
  }
  return blocks;
}

// Find a step-level `working-directory:` for the `run:` at `runIdx`. GitHub
// Actions runs the step's commands from that dir, so a pinned path is relative to
// it. The key can appear BEFORE or AFTER `run` and may be the step's first key
// (`- working-directory: …`), so scan the WHOLE step — bounded by its list
// marker at `keyIndent - 2` — for a `working-directory:` whose KEY column equals
// `keyIndent`. Returns "" (repo root) if none.
function stepWorkingDirectory(lines, runIdx, keyIndent) {
  const markerIndent = keyIndent - 2;
  // Step start: walk back to this step's `- ` marker (at markerIndent). Stop if
  // we dedent past it (left the step / the steps: list).
  let start = 0;
  for (let k = runIdx; k >= 0; k--) {
    const ln = lines[k];
    if (ln.trim() === "") continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind === markerIndent && /^\s*- /.test(ln)) { start = k; break; }
    if (ind < markerIndent) { start = k + 1; break; }
  }
  // Step end: next sibling marker / dedent at or below markerIndent.
  let end = lines.length;
  for (let k = start + 1; k < lines.length; k++) {
    const ln = lines[k];
    if (ln.trim() === "") continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind <= markerIndent) { end = k; break; }
  }
  for (let k = start; k < end; k++) {
    const ln = lines[k];
    const wd = ln.match(/^\s*(?:- )?working-directory:\s*["']?([^"'\s]+)["']?\s*$/);
    if (!wd) continue;
    const ind = ln.length - ln.trimStart().length;
    const keyCol = /^\s*- /.test(ln) ? ind + 2 : ind; // `- working-directory:` → key sits 2 past the dash
    if (keyCol === keyIndent) return wd[1].replace(/^\.\//, "").replace(/\/$/, "");
  }
  return "";
}

// Map of workspace package name → repo-relative dir (from each tracked
// package.json `name`). Lets `pnpm --filter <name> exec vitest …` resolve to the
// package root the test path is relative to.
export function workspacePackageDirs(repoRoot = REPO_ROOT) {
  const res = spawnSync("git", ["ls-files", "package.json", "*/package.json", "**/package.json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const map = new Map();
  if (res.status === 0 && res.stdout) {
    for (const rel of res.stdout.split("\n")) {
      const r = rel.trim();
      if (!r) continue;
      try {
        const pkg = JSON.parse(readFileSync(join(repoRoot, r), "utf8"));
        if (pkg && typeof pkg.name === "string") {
          const dir = posix.dirname(r);
          map.set(pkg.name, dir === "." ? "" : dir);
        }
      } catch {
        /* unparseable package.json — skip */
      }
    }
  }
  return map;
}

// Given one run-block body, return the pinned test tokens with the cwd each was
// invoked under (relative to repo root; "" === repo root).
export function pinnedTestsInBlock(body, fold = "literal", baseCwd = "", pkgDirs = new Map()) {
  const out = [];
  // Shell line continuations (`\` at end of line) join with the next line in
  // BOTH fold types — e.g. `node --test \` then test files on following lines.
  // A folded (`>-`) block ADDITIONALLY turns every newline into a space, so the
  // whole `vitest run a b c` is one command. A literal (`|`) block otherwise
  // keeps newlines as real command separators.
  let normalized = body.replace(/\\[ \t]*\n/g, " ");
  if (fold === "folded") normalized = normalized.replace(/\n+/g, " ");
  // Split into ordered segments on newline and `&&` so a `cd` in one segment
  // scopes the runner in the next. `;` and `||` also break command boundaries.
  const segments = normalized.split(/\n|&&|;|\|\|/);
  let cwd = baseCwd; // step-level working-directory: is the starting cwd
  for (const rawSeg of segments) {
    const seg = rawSeg.trim();
    if (!seg) continue;
    const cdMatch = seg.match(/^cd\s+(\S+)/);
    if (cdMatch) {
      const dir = cdMatch[1];
      if (dir === "../.." || dir === "../../" || dir.startsWith("/")) cwd = "";
      else if (dir === "..") cwd = posix.dirname(cwd || ".") === "." ? "" : posix.dirname(cwd);
      else cwd = cwd ? posix.join(cwd, dir) : dir;
      // a `cd` segment may ALSO contain `&& vitest …` — but we split on `&&`,
      // so the runner is its own later segment. Continue to token scan anyway
      // in case a runner shares this segment without `&&`.
    }
    // `pnpm --filter <pkg> exec …` / `pnpm -F <pkg> …` runs in that package's
    // dir, and the test path is relative to it. This is a per-COMMAND flag (not a
    // persistent `cd`), so scope it to THIS segment only — a later unfiltered
    // runner in the same block must not inherit it. Unknown name (glob/path)
    // leaves the cwd → suffix fallback.
    let segCwd = cwd;
    const filterMatch = seg.match(/(?:--filter|-F)(?:=|\s+)(@?[A-Za-z0-9._/-]+)/);
    if (filterMatch && pkgDirs.has(filterMatch[1])) segCwd = pkgDirs.get(filterMatch[1]);
    if (!RUNNER_RE.test(seg)) continue;
    const flagTokens = seg.split(/\s+/);
    // Values passed to skip-flags in the `=` form (`--exclude=x.test.ts`) are not
    // pins; the space form (`--exclude x.test.ts`) is handled by the lookback.
    const excludedValues = new Set();
    for (const ft of flagTokens) {
      const eq = ft.match(/^(?:--exclude|--reporter|--config|--project)=(.+)$/);
      if (eq) excludedValues.add(eq[1]);
    }
    let m;
    TEST_TOKEN_RE.lastIndex = 0;
    while ((m = TEST_TOKEN_RE.exec(seg)) !== null) {
      const token = m[1];
      if (token.includes("*")) continue; // glob filter, not a file
      if (excludedValues.has(token)) continue; // value of an `=`-form skip flag
      const idx = flagTokens.indexOf(token);
      if (idx > 0 && SKIP_AFTER_FLAGS.has(flagTokens[idx - 1])) continue;
      out.push({ token, cwd: segCwd });
    }
  }
  return out;
}

// The full POSIX paths of every test file tracked in the repo. Used for
// path-SUFFIX resolution: vitest filters by path substring, and a pin invoked
// under GitHub Actions `working-directory:` or `pnpm --filter <pkg>` carries a
// path relative to that dir — i.e. a SUFFIX of the real repo-root-relative path.
// Suffix matching (not basename matching) keeps that sound: a pin
// `src/app/missing/route.test.ts` is NOT satisfied by an unrelated
// `src/other/route.test.ts`, so a genuine zero-match is still caught.
export function trackedTestPaths(repoRoot = REPO_ROOT) {
  const res = spawnSync("git", ["ls-files", "*.test.ts", "*.test.tsx", "*.test.mjs", "*.test.mts", "*.test.js"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const paths = [];
  if (res.status === 0 && res.stdout) {
    for (const line of res.stdout.split("\n")) {
      if (line.trim()) paths.push(line.trim());
    }
  }
  return paths;
}

// Scan all (or given) workflow files; return the list of missing pins. A pin is
// "missing" only when neither its exact (cwd-resolved) path is present on disk
// NOR any tracked test file path ends with the pinned token (the path-suffix
// rule that resolves working-directory:/--filter invocations without
// false-suppressing a genuine miss).
export function findMissingPinnedTests(repoRoot = REPO_ROOT, workflowDir = WORKFLOW_DIR, knownPaths, knownPkgDirs) {
  const tracked = knownPaths ?? trackedTestPaths(repoRoot);
  const pkgDirs = knownPkgDirs ?? workspacePackageDirs(repoRoot);
  const files = readdirSync(workflowDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const missing = [];
  for (const file of files) {
    const yamlText = readFileSync(join(workflowDir, file), "utf8");
    for (const { body, fold, baseCwd } of extractRunBlocks(yamlText)) {
      for (const { token, cwd } of pinnedTestsInBlock(body, fold, baseCwd, pkgDirs)) {
        const norm = token.replace(/^\.\//, "");
        if (cwd) {
          // cwd is statically known (a `cd <dir>`, `working-directory:`, or
          // resolved `--filter` scope). vitest still filters by path SUBSTRING,
          // but only over tests discovered UNDER that dir — so accept a tracked
          // path that is BOTH inside `cwd/` AND a suffix of the token. The
          // `startsWith(cwd + "/")` guard excludes a same-suffix file in a
          // sibling package (the false-green that would otherwise slip through).
          const resolved = posix.join(cwd, norm);
          if (existsSync(join(repoRoot, resolved))) continue;
          if (tracked.some((p) => p === resolved || (p.startsWith(cwd + "/") && p.endsWith("/" + norm)))) continue;
          missing.push({ file, token, cwd, resolved });
        } else {
          // No statically-known cwd (root-relative, or a working-directory:/
          // pnpm --filter invocation we can't resolve): accept an exact path OR
          // a path-suffix match — vitest filters by path substring, so the pin
          // token being a suffix of a real test path means it will run.
          if (existsSync(join(repoRoot, norm))) continue;
          if (tracked.some((p) => p === norm || p.endsWith("/" + norm))) continue;
          missing.push({ file, token, cwd, resolved: norm });
        }
      }
    }
  }
  return missing;
}

// Run as a CLI gate.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const missing = findMissingPinnedTests();
  if (missing.length > 0) {
    console.error("✗ CI pins test files that do not exist on disk:");
    for (const m of missing) {
      console.error(`  - ${m.file}: pinned "${m.token}"${m.cwd ? ` (cwd ${m.cwd})` : ""} → ${m.resolved} MISSING`);
    }
    console.error(
      "\nA pinned-but-missing test passes silently (vitest ignores zero-match positionals).\n" +
        "Restore the file, or remove the stale pin from the workflow.",
    );
    process.exit(1);
  }
  console.log("✓ all workflow-pinned test files exist on disk");
}
