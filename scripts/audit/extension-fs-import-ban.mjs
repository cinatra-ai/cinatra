#!/usr/bin/env node
// CI gate: DENY-by-default `node:fs` / `node:fs/promises` (+ bare `fs` /
// `fs/promises`) imports in extension SOURCE (cinatra#979, the extension-side
// conformance-gate home; landed as part of #981's host-owned log-capture port).
//
// RATIONALE: cinatra#981 replaced gemini-connector/openai-connector/
// apollo-connector's hand-rolled `node:fs` request/response log writers with
// the host-owned `ctx.logger.capture` port. A connector reaching for `node:fs`
// directly to write its own logs (or anything else) bypasses the host's
// managed data root, rotation/retention policy, and telemetry-page listing/
// clearing — the exact hazard #981 fixed. This gate keeps it fixed: an
// extension that regresses back to direct filesystem access fails CI.
//
// NO-NEW-ROT RATCHET (temporary, shrink-only — mirrors extension-import-ban.mjs's
// pre-cinatra#172 staged rollout): this gate lands BEFORE the three migrated
// connectors' `cinatra-required-extensions.lock.json` /
// `cinatra-dev-extensions.lock.json` pins can be bumped (that requires their
// companion PRs to MERGE first — gemini-connector#42, openai-connector#56,
// apollo-connector#45 — the lock-bump tooling (`scripts/extensions/update-
// {required,dev}-extension-lock.mjs`) always resolves the CURRENT `main` tip,
// so it cannot pin to an unmerged branch). Until those pins move, the
// materialized `extensions/` tree still contains the PRE-migration connector
// source, which this gate would otherwise flag on day one. The committed
// BASELINE (`extension-fs-import-ban.baseline.json`) tolerates that KNOWN,
// already-fixed-upstream debt; any hit OUTSIDE the baseline (a genuinely NEW
// regression) still fails immediately. Once the lock pins bump, regenerate the
// baseline with `--write-baseline` — it should shrink to empty (the three
// connectors are clean in their own repos as of this gate's introduction) and
// this comment block's staged-rollout framing can be deleted.
//
// SCOPE: every extension's SOURCE tree (kind-agnostic — `src/`, `cinatra/`,
// `skills/`, `widgets/`, … — the whole extension package directory), MINUS:
//   - the AUTHOR-FACING GATE SCRIPTS (`AUTHOR_FACING_GATE_SCRIPTS` below) —
//     self-contained, zero-dependency per-repo CI validators that run
//     standalone against the local checkout, NOT shipped extension code the
//     host loads at runtime. `extension-kind-gate.mjs` is the one the
//     extraction script pushes into EVERY extension repo
//     (scripts/extensions/extract-extension-repos.mjs);
//     `renderer-binding-gate.mjs` is the per-pack renderer-binding lock the
//     #1959 self-owned-renderer template introduced. Both are excluded from
//     the packages' `files` allowlist, so neither is ever published or
//     imported — reading their own repo's package.json/oas.json with node:fs
//     is their whole job.
//   - a top-level `scripts/` directory — dev/bootstrap tooling (e.g. a
//     connector's local database-seed script), never on the host's
//     `register(ctx)`/serverEntry import graph.
//   - `__tests__` dirs and `*.test.*`/`*.spec.*` files — test fixtures
//     legitimately use `node:fs`/tmpdir for their OWN scratch state; that is
//     unrelated to "does this extension log/persist through node:fs at
//     runtime" and every other coupling gate in this family (see
//     extension-import-ban.mjs) excludes nothing there for the opposite
//     reason (their dimension IS meaningful in tests) — fs access in tests is
//     a different, non-hazardous class.
//
// ALLOWLIST (owner-ruled, self-policing, mirrors extension-import-ban.mjs's
// STRICT_SDK_ONLY_ALLOWLIST shape): a PERMANENT edge-level carve-out for a
// SPECIFIC (extension, file) pair with an inline rationale — unlike the
// BASELINE above (temporary migration debt), this is for a read-only/
// non-logging fs use that has no host-port equivalent yet. Stale entries (the
// edge no longer exists) are a hard CI failure, forcing the allowlist to
// shrink the moment its rationale is resolved.
//
// Usage:
//   node scripts/audit/extension-fs-import-ban.mjs                  # check (exit 1 on any hit outside baseline+allowlist)
//   node scripts/audit/extension-fs-import-ban.mjs --write-baseline # regenerate the baseline from CURRENT hits (minus allowlisted keys)

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripComments } from "../extensions/inventory.mjs";
import { assertExtensionsPresent } from "./lib/assert-extensions-cloned.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const EXT_ROOT = join(REPO_ROOT, "extensions");
const BASELINE_PATH = join(__dirname, "extension-fs-import-ban.baseline.json");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"]);

/** True when `spec` is a `node:fs` / bare `fs` module specifier, with or
 *  without the `/promises` subpath. Deliberately narrow to the ONE Node
 *  builtin the #981 port replaces — a third-party fs-like package (e.g.
 *  `fs-extra`, `graceful-fs`) is a separate, not-yet-scoped concern. */
export function isBannedFsSpecifier(spec) {
  return /^(?:node:)?fs(?:\/promises)?$/.test(spec);
}

/** Distinct banned fs specifiers referenced in `rawText` (`from`/bare
 *  `import`/`require`/dynamic `import(`, incl. backtick specifiers). */
export function scanFsImportsInText(rawText) {
  const text = stripComments(rawText);
  const hits = new Set();
  const re = /(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(text))) {
    if (isBannedFsSpecifier(m[1])) hits.add(m[1]);
  }
  return hits;
}

// OWNER-RULED PERMANENT edge-level carve-out (add ONLY with an inline
// rationale + a follow-up reference). Keys are `${extensionName}::${posix
// relative path from the extension root}`. Self-policing: a stale entry (the
// file/specifier is no longer there) is a hard CI failure — see
// staleAllowlistEntries. NEVER use this for a temporary migration-debt hit —
// that belongs in the committed BASELINE (shrink-only ratchet) instead.
export const FS_IMPORT_ALLOWLIST = new Set([
  // (empty) The one documented residual — @cinatra-ai/openai-connector
  // `src/openai-skills.ts` (an `existsSync` containment check for the sandboxed
  // shell tool's local skill-directory mount, cinatra#979) — was RETIRED when
  // openai-connector 0.1.9 dropped the sandboxed-shell architecture: the file
  // no longer exists, so a lingering carve-out would be a stale, forgotten
  // exemption (cinatra#1715). Add a new entry ONLY with an inline rationale +
  // a follow-up reference (keys are `${extensionName}::${posix path}`).
]);

// Author-facing per-repo CI gate scripts: standalone validators that read the
// pack's OWN package.json / cinatra/oas.json from disk and are excluded from the
// package `files` allowlist, so they are never published and never reach the
// host's import graph. Scanning them for node:fs would flag the one thing they
// exist to do. See the SCOPE note in the module header.
const AUTHOR_FACING_GATE_SCRIPTS = new Set([
  "extension-kind-gate.mjs",
  "renderer-binding-gate.mjs",
]);

function walkSourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, acc);
      continue;
    }
    if (AUTHOR_FACING_GATE_SCRIPTS.has(entry.name)) continue;
    if (/\.(test|spec)\./.test(entry.name)) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0 || !SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue;
    acc.push(full);
  }
  return acc;
}

function listExtensionDirs() {
  const out = [];
  if (!existsSync(EXT_ROOT)) return out;
  for (const scope of readdirSync(EXT_ROOT, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    const scopeDir = join(EXT_ROOT, scope.name);
    for (const ext of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!ext.isDirectory()) continue;
      const dir = join(scopeDir, ext.name);
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      let name = null;
      try {
        name = JSON.parse(readFileSync(pkgPath, "utf8")).name ?? null;
      } catch {
        /* unreadable manifest — keep name null, still scanned under its dir path */
      }
      out.push({ name, dir });
    }
  }
  return out;
}

/** Pure scan over an already-listed extension set — exported for unit tests
 *  (fixture dirs) without touching the real `extensions/` tree. Skips the
 *  `scripts/` top-level dev-tooling directory per-extension. Returns
 *  `{ [extensionNameOrDir]: string[] (sorted relative POSIX paths) }`. */
export function scanExtensionsForFsImports(extensions) {
  const hits = {};
  for (const { name, dir } of extensions) {
    const key = name ?? relative(EXT_ROOT, dir);
    const scriptsDir = join(dir, "scripts");
    const files = walkSourceFiles(dir).filter((f) => !f.startsWith(scriptsDir + sep));
    const found = [];
    for (const f of files) {
      const specs = scanFsImportsInText(readFileSync(f, "utf8"));
      if (specs.size) found.push(relative(dir, f).split(sep).join("/"));
    }
    if (found.length) hits[key] = found.sort();
  }
  return hits;
}

function flatten(hits) {
  const out = new Set();
  for (const ext of Object.keys(hits)) for (const file of hits[ext]) out.add(`${ext}::${file}`);
  return out;
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return new Set();
  try {
    const doc = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    return flatten(doc.hits ?? {});
  } catch {
    return new Set();
  }
}

/** Non-tolerated (extension, file) violations — outside BOTH the permanent
 *  allowlist and the temporary migration-debt baseline. Exported for unit
 *  tests. */
export function violationsOf(hits, allowlist = FS_IMPORT_ALLOWLIST, baseline = new Set()) {
  return [...flatten(hits)].filter((k) => !allowlist.has(k) && !baseline.has(k)).sort();
}

/** Allowlist entries whose (extension, file) hit no longer exists — the
 *  self-policing stale-carve-out check. Exported for unit tests. */
export function staleAllowlistEntries(hits, allowlist = FS_IMPORT_ALLOWLIST) {
  const current = flatten(hits);
  return [...allowlist].filter((k) => !current.has(k)).sort();
}

/** Baseline entries whose (extension, file) hit no longer exists — the
 *  migrated-away debt, reported (not failed) so a maintainer knows the
 *  baseline can shrink. Exported for unit tests. */
export function staleBaselineEntries(hits, baseline) {
  const current = flatten(hits);
  return [...baseline].filter((k) => !current.has(k)).sort();
}

async function main() {
  const args = process.argv.slice(2);
  assertExtensionsPresent(REPO_ROOT, "extension-fs-import-ban");
  const hits = scanExtensionsForFsImports(listExtensionDirs());

  if (args.includes("--write-baseline")) {
    // Regenerate the shrink-only ratchet baseline from CURRENT hits, minus
    // anything already covered by the PERMANENT allowlist (kept disjoint from
    // the baseline so the two carve-out mechanisms never overlap/confuse).
    const allowlisted = FS_IMPORT_ALLOWLIST;
    const nextHits = {};
    for (const [ext, files] of Object.entries(hits)) {
      const kept = files.filter((f) => !allowlisted.has(`${ext}::${f}`));
      if (kept.length) nextHits[ext] = kept;
    }
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify(
        {
          note:
            "extension-fs-import-ban — TEMPORARY shrink-only ratchet baseline (see the gate's module " +
            "header for the staged-rollout rationale: the three cinatra#981-migrated connectors' lock " +
            "pins can't bump until their companion PRs merge). A hit here is TOLERATED debt, already " +
            "fixed upstream in the connector repo, pending a lock-pin bump — NOT a permanent exemption " +
            "(that's FS_IMPORT_ALLOWLIST in extension-fs-import-ban.mjs). Regenerate via --write-baseline " +
            "after any lock-pin bump; it should trend toward (and eventually reach) empty.",
          hits: nextHits,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("[extension-fs-import-ban] baseline written.");
    return;
  }

  const baseline = readBaseline();

  const staleCarveOuts = staleAllowlistEntries(hits);
  if (staleCarveOuts.length) {
    console.error(
      "[extension-fs-import-ban] FAIL — STALE allowlist entr" +
        (staleCarveOuts.length === 1 ? "y" : "ies") +
        " (the node:fs hit is gone; remove from FS_IMPORT_ALLOWLIST so a later reintroduction " +
        "can't silently ride the forgotten carve-out):",
    );
    for (const s of staleCarveOuts) console.error("  + " + s);
    process.exit(1);
  }

  const violations = violationsOf(hits, FS_IMPORT_ALLOWLIST, baseline);
  if (violations.length) {
    console.error(
      "[extension-fs-import-ban] FAIL — extension source imports node:fs/node:fs/promises " +
        "outside the owner-ruled FS_IMPORT_ALLOWLIST and the tolerated migration-debt baseline " +
        "(cinatra#979/#981 — route request/response logging through ctx.logger.capture(channel, " +
        "entry); route any other on-disk need through a host port, or get an owner-ruled allowlist " +
        "entry):",
    );
    for (const v of violations) console.error("  + " + v);
    process.exit(1);
  }

  const staleDebt = staleBaselineEntries(hits, baseline);
  if (staleDebt.length) {
    console.log(
      `[extension-fs-import-ban] NOTE — ${staleDebt.length} baseline entr` +
        (staleDebt.length === 1 ? "y is" : "ies are") +
        " migrated away (no longer present); run --write-baseline to shrink the ratchet:",
    );
    for (const s of staleDebt) console.log("  - " + s);
  }

  console.log(
    `[extension-fs-import-ban] OK — 0 node:fs import(s) outside the owner-ruled FS_IMPORT_ALLOWLIST ` +
      `(${FS_IMPORT_ALLOWLIST.size}) and the tolerated migration-debt baseline (${baseline.size}).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
