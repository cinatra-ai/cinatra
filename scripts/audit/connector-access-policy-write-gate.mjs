#!/usr/bin/env node
/**
 * connector_access_policy WRITE guard.
 *
 * Connector access moved to the uniform polymorphic model
 * (installed_extension + extension_access_policy). The legacy
 * `connector_access_policy` table is RETAINED READ-ONLY as the absence-only
 * fallback shim until a removal migration; NEW writes to it are forbidden.
 *
 * This gate is STRICT (not touch-ratchet): after the migration there are
 * ZERO legitimate write sites, so any match outside the allowlist is a
 * regression — either raw write SQL against the table, or a call to one of the
 * (now-throwing) legacy write helpers.
 *
 * Banned:
 *   - INSERT INTO ... connector_access_policy
 *   - UPDATE ... connector_access_policy ... SET
 *   - DELETE FROM ... connector_access_policy
 *   - upsertConnectorAccessPolicy( / batchUpsertConnectorPoliciesForFixture( /
 *     deleteConnectorAccessPolicy(
 *
 * Allowlist:
 *   - this script
 *   - src/lib/connector-policy-store.ts (defines the now-throwing writers + the
 *     retained READ helpers — no write SQL remains)
 *   - test files that assert the writers throw
 *
 * Exit codes: 0 clean · 1 violation found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const SCAN_DIRS = ["src", "packages", "scripts", "extensions"];
const EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".mts", ".js"]);

// Full exemption (both SQL-write + call-pattern scans skipped):
//   - this gate (self-reference)
const FULLY_ALLOWLISTED = new Set([
  "scripts/audit/connector-access-policy-write-gate.mjs",
]);

function isFullyAllowlisted(rel) {
  if (FULLY_ALLOWLISTED.has(rel)) return true;
  // Test files asserting the write-block throw reference the helper names.
  if (/__tests__\/.*connector-access-policy.*\.test\.(ts|tsx|mjs)$/.test(rel)) return true;
  return false;
}

// The legacy store DEFINES the (now-throwing) write helpers + the retained read
// helpers. We still scan it for raw write SQL (none should remain), but the
// function DEFINITIONS would match the call-pattern — the lookbehind below
// excludes `function NAME(` so the store isn't blanket-exempted.
const CALL_PATTERN =
  /(?<!function\s)\b(upsertConnectorAccessPolicy|batchUpsertConnectorPoliciesForFixture|deleteConnectorAccessPolicy)\s*\(/;
const INSERT_PATTERN = /INSERT\s+INTO[\s\S]{0,80}?connector_access_policy/i;
const UPDATE_PATTERN = /UPDATE[\s\S]{0,80}?connector_access_policy[\s\S]{0,200}?\bSET\b/i;
const DELETE_PATTERN = /DELETE\s+FROM[\s\S]{0,80}?connector_access_policy/i;

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(name.slice(name.lastIndexOf(".")))) out.push(full);
  }
}

const files = [];
for (const d of SCAN_DIRS) walk(join(REPO_ROOT, d), files);

const findings = [];
for (const file of files) {
  const rel = relative(REPO_ROOT, file);
  if (isFullyAllowlisted(rel)) continue;
  const text = readFileSync(file, "utf8");
  // Per-line call-pattern scan (precise line numbers).
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (CALL_PATTERN.test(line)) {
      findings.push({ rel, line: i + 1, kind: "blocked-writer-call", text: line.trim().slice(0, 120) });
    }
  });
  // Whole-file SQL-write scan (multi-line tolerant).
  if (INSERT_PATTERN.test(text)) findings.push({ rel, line: 0, kind: "INSERT connector_access_policy", text: "" });
  if (UPDATE_PATTERN.test(text)) findings.push({ rel, line: 0, kind: "UPDATE connector_access_policy", text: "" });
  if (DELETE_PATTERN.test(text)) findings.push({ rel, line: 0, kind: "DELETE connector_access_policy", text: "" });
}

if (findings.length === 0) {
  console.log("connector-access-policy-write-gate: clean — no new connector_access_policy writes.");
  process.exit(0);
}

console.error("ERROR: new connector_access_policy WRITE(s) detected.\n");
console.error(
  "Connector access writes must go through setExtensionInstallAccess /\n" +
    "saveExtensionAccessPolicy (polymorphic model). The legacy table is read-only.\n",
);
for (const f of findings) {
  console.error(`  ${f.rel}${f.line ? ":" + f.line : ""} [${f.kind}] ${f.text}`);
}
process.exit(1);
