#!/usr/bin/env node
/**
 * Design-conformance coverage-ratchet monotonicity check (cinatra#985;
 * aspect granularity since cinatra#986).
 *
 * The allowlist (tests/e2e/design/conformance/allowlist.json) exempts
 * not-yet-covered manifest surfaces — or, since cinatra#986, individual
 * ASPECTS ("field:<name>" / "action:<name>" / "state:<state>") of otherwise
 * covered surfaces — from the functional-acceptance gate. It may ONLY SHRINK:
 * this script compares the allowlist at HEAD against the PR base and fails
 * when an exemption was ADDED or WIDENED. Allowed transitions:
 *
 *   - removing a whole-surface entry            (coverage landed)
 *   - removing an aspect from an aspects entry  (coverage landed)
 *   - NARROWING a whole-surface entry to aspects (strictly less exempt)
 *
 * Forbidden: new surfaces, new aspects not covered by a base whole-surface
 * entry, and widening an aspects entry back to whole-surface.
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

const ASPECT_RE = /^(field|action|state):.+$/;

/**
 * Normalize an allowlist into exemption keys:
 *   whole-surface entry → "<surface>/*"
 *   aspects entry       → "<surface>/<aspect>" per aspect
 * Throws on malformed/duplicate entries (both sides validated).
 */
function exemptionKeys(allow, label) {
  const keys = new Set();
  const seenSurfaces = new Set();
  for (const entry of allow) {
    if (typeof entry.surface !== "string" || entry.surface.length === 0) {
      throw new Error(`${label} allowlist entry without a surface`);
    }
    if (seenSurfaces.has(entry.surface)) {
      throw new Error(`${label} allowlist has duplicate entries for surface "${entry.surface}"`);
    }
    seenSurfaces.add(entry.surface);
    if (entry.aspects === undefined) {
      keys.add(`${entry.surface}/*`);
      continue;
    }
    if (!Array.isArray(entry.aspects) || entry.aspects.length === 0) {
      throw new Error(`${label} allowlist entry "${entry.surface}" has an empty/invalid aspects[]`);
    }
    for (const aspect of entry.aspects) {
      if (typeof aspect !== "string" || !ASPECT_RE.test(aspect)) {
        throw new Error(
          `${label} allowlist entry "${entry.surface}" has malformed aspect "${aspect}" (expected field:<name> / action:<name> / state:<state>)`,
        );
      }
      const key = `${entry.surface}/${aspect}`;
      if (keys.has(key)) {
        throw new Error(`${label} allowlist has duplicate aspect "${aspect}" on "${entry.surface}"`);
      }
      keys.add(key);
    }
  }
  return keys;
}

const headAllow = JSON.parse(readFileSync(path.join(REPO_ROOT, ALLOWLIST_REL), "utf8")).allow;

const git = (args) =>
  execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

// FAIL CLOSED on an unresolvable base ref (codex-caught in #985): if the base
// were treated like a missing file, a shallow/misfetched CI checkout would let
// an allowlist ADDITION pass as "first introduction".
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

let headKeys;
try {
  headKeys = exemptionKeys(headAllow, "HEAD");
} catch (err) {
  console.error(`conformance ratchet FAILED: ${err.message}`);
  process.exit(1);
}

if (!fileExistsAtBase) {
  console.log(
    `conformance ratchet: no allowlist at ${baseRef} (first introduction) — HEAD allowlist accepted as the initial ratchet (${headKeys.size} exemptions)`,
  );
  process.exit(0);
}

let baseKeys;
try {
  baseKeys = exemptionKeys(JSON.parse(git(["show", `${baseRef}:${ALLOWLIST_REL}`])).allow, "base");
} catch (err) {
  console.error(`conformance ratchet FAILED: ${err.message}`);
  process.exit(1);
}

// Monotonicity: every HEAD exemption must be covered by the base —
//   "<surface>/*"        needs "<surface>/*" at base (no widening back),
//   "<surface>/<aspect>" needs itself OR "<surface>/*" at base (narrowing ok).
const added = [...headKeys].filter((key) => {
  if (baseKeys.has(key)) return false;
  if (key.endsWith("/*")) return true;
  const surface = key.slice(0, key.indexOf("/"));
  return !baseKeys.has(`${surface}/*`);
});

if (added.length > 0) {
  console.error(
    `conformance ratchet FAILED: the allowlist is SHRINK-ONLY, but these exemptions were added (or widened) vs ${baseRef}:\n` +
      added.map((s) => `  - ${s}`).join("\n") +
      "\nCover the surface/aspect (contract.ts + harness + testid contract) instead of exempting it.",
  );
  process.exit(1);
}

const removed = [...baseKeys].filter((key) => {
  if (headKeys.has(key)) return false;
  if (!key.endsWith("/*")) return true;
  // A narrowed whole-surface exemption only counts as removed if HEAD keeps
  // no aspect of it either.
  const surface = key.slice(0, -2);
  return ![...headKeys].some((k) => k.startsWith(`${surface}/`));
});
console.log(
  `conformance ratchet OK vs ${baseRef}: ${headKeys.size} exemptions at HEAD (${removed.length} fully removed, 0 added/widened)`,
);
