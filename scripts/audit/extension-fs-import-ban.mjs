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
// SCOPE: every extension's SOURCE tree (kind-agnostic — `src/`, `cinatra/`,
// `skills/`, `widgets/`, … — the whole extension package directory), MINUS:
//   - `extension-kind-gate.mjs` — the self-contained, zero-dependency
//     per-repo CI validator the extraction script pushes into EVERY extension
//     repo (scripts/extensions/extract-extension-repos.mjs); it is repo-CI
//     tooling that runs standalone against the local checkout, not shipped
//     extension code the host loads at runtime.
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
// STRICT_SDK_ONLY_ALLOWLIST shape): an edge-level carve-out for a SPECIFIC
// (extension, file) pair with an inline rationale. Unlike the logging writers
// #981 eliminated, a carve-out here is for a read-only/non-logging fs use that
// has no host-port equivalent yet — NOT a re-hosted logging bypass. Stale
// entries (the edge no longer exists) are a hard CI failure, forcing the
// allowlist to shrink the moment its rationale is resolved.
//
// Usage:
//   node scripts/audit/extension-fs-import-ban.mjs                  # check (exit 1 on any non-allowlisted hit)
//   node scripts/audit/extension-fs-import-ban.mjs --write-baseline # regenerate the recorded-hits doc (informational; the allowlist is what gates)

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

// OWNER-RULED edge-level carve-out (EMPTY by default; add ONLY with an inline
// rationale + a follow-up reference). Keys are `${extensionName}::${posix
// relative path from the extension root}`. Self-policing: a stale entry (the
// file/specifier is no longer there) is a hard CI failure — see
// staleAllowlistEntries.
export const FS_IMPORT_ALLOWLIST = new Set([
  // @cinatra-ai/openai-connector — `openai-skills.ts` uses `existsSync` to
  // validate a LOCAL skill-directory mount path for the sandboxed shell tool
  // (read-only existence/containment check against the configured sandbox
  // readRoots) BEFORE handing it to the model — unrelated to request/response
  // logging (the #981 migration this gate follows from). No host port exists
  // for "does this on-disk path exist" today; carved out until one does.
  "@cinatra-ai/openai-connector::src/openai-skills.ts",
]);

function walkSourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, acc);
      continue;
    }
    if (entry.name === "extension-kind-gate.mjs") continue;
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

/** Non-allowlisted (extension, file) violations. Exported for unit tests. */
export function violationsOf(hits, allowlist = FS_IMPORT_ALLOWLIST) {
  return [...flatten(hits)].filter((k) => !allowlist.has(k)).sort();
}

/** Allowlist entries whose (extension, file) hit no longer exists — the
 *  self-policing stale-carve-out check. Exported for unit tests. */
export function staleAllowlistEntries(hits, allowlist = FS_IMPORT_ALLOWLIST) {
  const current = flatten(hits);
  return [...allowlist].filter((k) => !current.has(k)).sort();
}

async function main() {
  const args = process.argv.slice(2);
  assertExtensionsPresent(REPO_ROOT, "extension-fs-import-ban");
  const hits = scanExtensionsForFsImports(listExtensionDirs());

  if (args.includes("--write-baseline")) {
    // Informational record of the CURRENT (already-allowlisted) hits, for
    // human review — NOT consulted by the check below (the allowlist is the
    // only thing that gates; a re-generated baseline can never widen it).
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify(
        {
          note:
            "extension-fs-import-ban — INFORMATIONAL record of current node:fs hits in extension " +
            "source, for human review only. The gate's actual pass/fail is FS_IMPORT_ALLOWLIST in " +
            "extension-fs-import-ban.mjs (owner-ruled, self-policing) — this file is never read by " +
            "the check.",
          hits,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("[extension-fs-import-ban] baseline (informational) written.");
    return;
  }

  const stale = staleAllowlistEntries(hits);
  if (stale.length) {
    console.error(
      "[extension-fs-import-ban] FAIL — STALE allowlist entr" +
        (stale.length === 1 ? "y" : "ies") +
        " (the node:fs hit is gone; remove from FS_IMPORT_ALLOWLIST so a later reintroduction " +
        "can't silently ride the forgotten carve-out):",
    );
    for (const s of stale) console.error("  + " + s);
    process.exit(1);
  }

  const violations = violationsOf(hits);
  if (violations.length) {
    console.error(
      "[extension-fs-import-ban] FAIL — extension source imports node:fs/node:fs/promises " +
        "outside the owner-ruled FS_IMPORT_ALLOWLIST (cinatra#979/#981 — route request/response " +
        "logging through ctx.logger.capture(channel, entry); route any other on-disk need through " +
        "a host port, or get an owner-ruled allowlist entry):",
    );
    for (const v of violations) console.error("  + " + v);
    process.exit(1);
  }

  console.log(
    `[extension-fs-import-ban] OK — 0 non-allowlisted node:fs import(s) across the extension fleet ` +
      `(${FS_IMPORT_ALLOWLIST.size} owner-ruled allowlist entr${FS_IMPORT_ALLOWLIST.size === 1 ? "y" : "ies"}, ` +
      `self-policed).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
