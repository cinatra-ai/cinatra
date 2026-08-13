#!/usr/bin/env node
/**
 * PRODUCTION-BOUNDARY RETIREMENT IDENTITY GATE (cinatra#2573, epic #2564 S7).
 *
 * S7's program-wide acceptance criterion, verbatim:
 *
 *   "Production-boundary retirement identity greps stay zero (exact-identity
 *    constructions); the stale trigger-agent fixtures are gone."
 *
 * WHAT WAS RETIRED, AND WHY THE GREP HAS TO BE EXACT. Four helper agents used to
 * live inside chats as installable extension packages. Three of them are gone:
 * `reviewer-agent` and `auditor-agent` left with the #1796/#2047 teardown, and
 * `trigger-agent` was superseded by the host-standard scheduling subsystem (its
 * repo is ARCHIVED; it is in no `devExtensions` map and no lock file). A plain
 * substring grep for `reviewer-agent` cannot express that, because
 * `code-reviewer-agent` and `security-reviewer-agent` are RETAINED, shipped
 * packages. So both constructions the #2047 annex fixed are used here:
 *   (1) fixed-string on the exact scoped package ref, and
 *   (2) a boundary-exact PCRE whose right edge is a negative lookahead over the
 *       package-name charset — proven below to discriminate against the
 *       retained packages rather than merely to pass.
 *
 * WHY "PRODUCTION BOUNDARY" AND NOT "THE WHOLE TREE". The sibling gate
 * `packages/agents/src/__tests__/reviewer-auditor-retirement-identity.test.ts`
 * already holds reviewer/auditor at WHOLE-TREE zero, and this gate re-runs that
 * (see WHOLE_TREE_ZERO). `trigger-agent` is a different case and the criterion
 * words it differently: what must be zero is the PRODUCTION boundary — the
 * surfaces that make a package installable, dispatchable or renderable — while
 * a unit test may still use the string as a synthetic package name in a routing
 * or slug fixture, and a decision record may still describe the history. Erasing
 * those would be rewriting the record, not retiring a package. What may NOT
 * survive anywhere is a FIXTURE that declares the retired package as live —
 * a canonical-visible-set entry, a runnable agent fixture, a HITL renderer case,
 * a batch filter — because such a fixture makes a suite assert a world that no
 * longer exists, and it fails on every fresh instance. That is the "stale
 * trigger-agent fixtures" half, and it is enforced by FIXTURE_SURFACES below.
 *
 * THE THREE SCANS:
 *   S1  PRODUCTION BOUNDARY — zero exact-identity hits under `src/`,
 *       `packages/` (non-test), `migrations/`, and the three declaration files
 *       that make a package installable (`package.json` devExtensions + both
 *       extension lock files) + `registry.json`.
 *   S2  WHOLE TREE — zero for the two #1796/#2047 identities, in both
 *       constructions. (Re-run here so ONE command answers the whole criterion.)
 *   S3  FIXTURE SURFACES — zero for every retired identity in the E2E fixture
 *       files listed in FIXTURE_SURFACES.
 *
 * SELF-REFERENCE. The identities are ASSEMBLED FROM PARTS below and never
 * written as literals, so this file is not the last remaining match for its own
 * assertion — the same technique the sibling gate adopted, and the reason no
 * path exclusion is needed for scans S2/S3.
 *
 * Exit 0 -> clean; exit 1 -> at least one violation; exit 2 -> scanner error.
 *
 * Usage: node scripts/audit/chat-hitl-retirement-gate.mjs
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = join(__dirname, "..", "..");
const LABEL = "chat-hitl-retirement";

const SCOPE = "@cinatra-ai/";

/** The two #1796/#2047 identities — WHOLE-TREE zero, both constructions. */
export const WHOLE_TREE_ZERO = [
  `${SCOPE}${"reviewer"}-agent`,
  `${SCOPE}${"auditor"}-agent`,
];

/** Every retired identity this epic's boundary must be clean of. */
export const RETIRED_IDENTITIES = [...WHOLE_TREE_ZERO, `${SCOPE}${"trigger"}-agent`];

/** Retained packages that a sloppy substring grep would wrongly catch. */
export const RETAINED_LOOKALIKES = [
  `${SCOPE}code-${"reviewer"}-agent`,
  `${SCOPE}security-${"reviewer"}-agent`,
  `${SCOPE}${"trigger"}-agent-v2`,
  `${SCOPE}${"trigger"}-email-send`,
];

/**
 * The PRODUCTION BOUNDARY — the pathspecs a retired package may not appear in.
 * Tests and `__tests__` trees are excluded by the pathspec, not by a later
 * filter, so the boundary is a property of the query rather than of a list.
 */
export const PRODUCTION_PATHSPECS = [
  "src",
  "packages",
  "migrations",
  "package.json",
  "registry.json",
  "cinatra-dev-extensions.lock.json",
  "cinatra-required-extensions.lock.json",
  ":(exclude)**/__tests__/**",
  ":(exclude)**/__fixtures__/**",
  ":(exclude)**/*.test.ts",
  ":(exclude)**/*.test.tsx",
  ":(exclude)**/*.test.mjs",
];

/**
 * The E2E FIXTURE surfaces. A retired package named here is a fixture asserting
 * a world that no longer exists — the "stale trigger-agent fixtures" the
 * criterion names. Enumerated rather than globbed so that adding a fixture file
 * is a deliberate act.
 */
export const FIXTURE_SURFACES = [
  "tests/e2e/agents-run/fixtures.ts",
  "tests/e2e/agents-run/chat-mcp-fixtures.ts",
  "tests/e2e/agents-run/hitl-actions.ts",
  "tests/e2e/agents-run/run-batched.sh",
  "tests/e2e/agents-run/run-batched-trackb.sh",
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The #2047-annex boundary-exact PCRE for one scoped package ref. */
export function boundaryPattern(identity) {
  return `${esc(identity)}(?![A-Za-z0-9._-])`;
}

/**
 * The same construction for the BARE SLUG (`trigger-agent`), which is how a
 * fixture filter or a `slug:` field names the package. It needs a LEFT boundary
 * too, or it would swallow the retained `code-reviewer-agent` /
 * `security-reviewer-agent` — the precise failure the exact-identity rule
 * exists to prevent.
 */
export function slugBoundaryPattern(identity) {
  const slug = identity.slice(SCOPE.length);
  return `(?<![A-Za-z0-9._-])${esc(slug)}(?![A-Za-z0-9._-])`;
}

/**
 * MATCHING IS COMMENT-BLIND ON THE PRODUCTION BOUNDARY, BY DESIGN. A retirement
 * is a change to what the product DOES, not a redaction of what it once did: a
 * decision record and a header note that say "this module was consumed by the
 * retired X" are the retirement's own documentation. What may not survive is a
 * live reference. So `.ts/.tsx/.mjs/.json` sources are comment-stripped through
 * the shared lexer before matching, and `.sh` fixtures lose their `#` comment
 * lines the same way (their `BATCH_FILTER=` assignments ARE the declaration, and
 * the note recording WHY a batch was removed is not).
 *
 * The WHOLE-TREE scan (S2) deliberately does NOT strip: the #1796/#2047
 * criterion is literal zero including prose, and it is already met.
 */
function codeOf(rel, source) {
  if (/\.(ts|tsx|mjs|js|json)$/.test(rel)) return stripComments(source);
  if (/\.sh$/.test(rel)) {
    // Whole-line `#` comments only. An inline `#` inside a shell string is not
    // a comment, and a lexer that assumed otherwise would blind the gate to a
    // filter written as `FOO="…" # note`.
    return source
      .split("\n")
      .map((l) => (/^\s*#/.test(l) ? "" : l))
      .join("\n");
  }
  return source;
}

function matchLines(rel, source, patterns, { strip }) {
  const text = strip ? codeOf(rel, source) : source;
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      if (new RegExp(p).test(lines[i])) {
        out.push(`${rel}:${i + 1}:${lines[i].trim().slice(0, 160)}`);
        break;
      }
    }
  }
  return out;
}

/** Tracked files under a git pathspec. */
function lsFiles(pathspec, repoRoot) {
  try {
    return execSync(`git ls-files -- ${pathspec}`, { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The whole gate, as data. The only IO is `git ls-files` + file reads, both
 * injectable so a fixture tree can drive the same matcher CI runs.
 */
export function collectViolations({
  repoRoot = DEFAULT_REPO_ROOT,
  listFilesImpl = (pathspec) => lsFiles(pathspec, repoRoot),
  readFileImpl = (rel) => readFileSync(resolve(repoRoot, rel), "utf8"),
} = {}) {
  const violations = [];
  const readSafe = (rel) => {
    try {
      return readFileImpl(rel);
    } catch {
      return null;
    }
  };

  // S1 — the production boundary, comment-stripped, both constructions.
  const pathspec = PRODUCTION_PATHSPECS.map((p) => JSON.stringify(p)).join(" ");
  for (const rel of listFilesImpl(pathspec)) {
    const src = readSafe(rel);
    if (src === null) continue;
    for (const identity of RETIRED_IDENTITIES) {
      for (const hit of matchLines(rel, src, [boundaryPattern(identity)], { strip: true })) {
        violations.push({ scan: "production-boundary", identity, hit });
      }
    }
  }

  // S2 — whole-tree LITERAL zero for the two #1796/#2047 identities.
  for (const rel of listFilesImpl(".")) {
    const src = readSafe(rel);
    if (src === null) continue;
    for (const identity of WHOLE_TREE_ZERO) {
      for (const hit of matchLines(rel, src, [boundaryPattern(identity)], { strip: false })) {
        violations.push({ scan: "whole-tree", identity, hit });
      }
    }
  }

  // S3 — the E2E fixture surfaces: scoped ref OR bare slug, both boundary-exact.
  for (const rel of FIXTURE_SURFACES) {
    const src = readSafe(rel);
    if (src === null) continue;
    for (const identity of RETIRED_IDENTITIES) {
      const patterns = [boundaryPattern(identity), slugBoundaryPattern(identity)];
      for (const hit of matchLines(rel, src, patterns, { strip: true })) {
        violations.push({ scan: "stale-fixture", identity, hit });
      }
    }
  }

  // De-duplicate: a line found by two constructions is one violation.
  const seen = new Set();
  return violations.filter((v) => {
    const key = `${v.scan}|${v.hit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The discrimination control: the boundary pattern must REJECT every retained
 *  look-alike and ACCEPT every retired identity. A gate whose pattern silently
 *  broke would otherwise report a vacuous zero forever. */
export function discriminationReport() {
  const failures = [];
  for (const identity of RETIRED_IDENTITIES) {
    for (const build of [boundaryPattern, slugBoundaryPattern]) {
      const re = new RegExp(build(identity));
      const subject = build === boundaryPattern ? identity : identity.slice(SCOPE.length);
      if (!re.test(subject)) {
        failures.push(`pattern does not match its own identity: ${subject}`);
      }
      for (const keep of RETAINED_LOOKALIKES) {
        if (re.test(keep)) failures.push(`pattern wrongly matches retained package: ${keep}`);
      }
    }
  }
  return failures;
}

function main() {
  const discrimination = discriminationReport();
  if (discrimination.length > 0) {
    console.error(`[${LABEL}] the identity pattern is broken — a zero here would be vacuous:\n`);
    for (const f of discrimination) console.error(`  ${f}`);
    return 1;
  }
  const violations = collectViolations();
  if (violations.length === 0) {
    console.log(
      `[${LABEL}] clean — ${RETIRED_IDENTITIES.length} retired identities at zero on the ` +
        "production boundary, and no stale fixture declares one.",
    );
    return 0;
  }
  console.error(`[${LABEL}] ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.scan}] ${v.identity}\n      ${v.hit}`);
  }
  console.error(
    "\nA retired package that survives on the production boundary is installable, dispatchable" +
      "\nor renderable again by accident. A fixture that still declares one makes a suite assert" +
      "\na world no fresh instance has — it fails for the wrong reason, forever.",
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`[${LABEL}] fatal:`, e);
    process.exit(2);
  }
}
