#!/usr/bin/env node
/**
 * Design-conformance coverage-ratchet monotonicity check (cinatra#985).
 *
 * The allowlist (tests/e2e/design/conformance/allowlist.json) exempts
 * not-yet-covered manifest surfaces from the functional-acceptance gate. It
 * may ONLY SHRINK: this script compares the allowlist at HEAD against the PR
 * base and fails when a surface was ADDED (or re-added). Removals (coverage
 * landing) always pass.
 *
 * Usage: node scripts/design/check-conformance-ratchet.mjs [<base-git-ref>]
 *   base-git-ref defaults to origin/main; CI passes origin/$GITHUB_BASE_REF.
 *   A missing allowlist at base (first introduction) passes trivially.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALLOWLIST_REL = "tests/e2e/design/conformance/allowlist.json";

const baseRef = process.argv[2] || "origin/main";

const headEntries = JSON.parse(
  readFileSync(path.join(REPO_ROOT, ALLOWLIST_REL), "utf8"),
).allow.map((e) => e.surface);

const git = (args) =>
  execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

// FAIL CLOSED on an unresolvable base ref (codex-caught): if the base were
// treated like a missing file, a shallow/misfetched CI checkout would let an
// allowlist ADDITION pass as "first introduction".
try {
  git(["rev-parse", "--verify", `${baseRef}^{commit}`]);
} catch {
  console.error(
    `conformance ratchet FAILED: base ref "${baseRef}" is not resolvable in this checkout — fetch it first (the ratchet must not fail open)`,
  );
  process.exit(1);
}

// ONLY a genuinely absent file at a RESOLVABLE base ref is first introduction.
let fileExistsAtBase = true;
try {
  git(["cat-file", "-e", `${baseRef}:${ALLOWLIST_REL}`]);
} catch {
  fileExistsAtBase = false;
}
if (!fileExistsAtBase) {
  console.log(
    `conformance ratchet: no allowlist at ${baseRef} (first introduction) — HEAD allowlist accepted as the initial ratchet (${headEntries.length} entries)`,
  );
  process.exit(0);
}

const baseRaw = git(["show", `${baseRef}:${ALLOWLIST_REL}`]);
const baseSurfaces = new Set(JSON.parse(baseRaw).allow.map((e) => e.surface));
const added = headEntries.filter((s) => !baseSurfaces.has(s));

const dupes = headEntries.filter((s, i) => headEntries.indexOf(s) !== i);
if (dupes.length > 0) {
  console.error(`conformance ratchet FAILED: duplicate allowlist entries: ${dupes.join(", ")}`);
  process.exit(1);
}

if (added.length > 0) {
  console.error(
    `conformance ratchet FAILED: the allowlist is SHRINK-ONLY, but these surfaces were added vs ${baseRef}:\n` +
      added.map((s) => `  - ${s}`).join("\n") +
      "\nCover the surface (contract.ts + harness + testid contract) instead of exempting it.",
  );
  process.exit(1);
}

const removed = [...baseSurfaces].filter((s) => !headEntries.includes(s));
console.log(
  `conformance ratchet OK vs ${baseRef}: ${headEntries.length} allowlisted (${removed.length} removed, 0 added)`,
);
