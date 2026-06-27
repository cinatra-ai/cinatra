#!/usr/bin/env node
/**
 * Legacy admin UI-route reference guard.
 *
 * The admin namespace was renamed twice:
 *   1. `/administration/...` (UI) → `/admin/...` (intermediate; permanent 308)
 *   2. `/admin/...` (UI)          → `/configuration/...` (current)
 *
 * Both legacy prefixes resolve via permanent 308 redirects in `next.config.ts`
 * indefinitely. This guard prevents NEW source references to either old
 * prefix outside the allowlist — adding new callers that go through a
 * redirect is wasteful and indicates code that hasn't tracked the rename.
 *
 * Touch-ratchet rule (no-new-rot):
 *   - findings on lines a PR DID NOT add → tolerated (pre-existing legacy
 *     left over from previous renames that the gate post-dated)
 *   - findings on lines a PR ADDED → blocked
 *
 * The base ref for the diff comes from `ADMIN_ROUTE_DIFF_BASE` (set by the
 * CI workflow to the PR base). Locally, the helper falls back to
 * `origin/main` / `origin/master` / `main` / `master`. When no base
 * resolves, the gate runs in strict mode (every finding is blocked) so
 * an unauthenticated local run + a misconfigured CI workflow both
 * fail-closed — see `_lib/touch-ratchet.mjs`.
 *
 * Strictly scoped to the Next.js UI route. `/api/admin/*` and
 * `/api/administration/*` are SEPARATE namespaces (API routes) and are NOT
 * touched by either rename. External admin URLs (vendor dashboards,
 * WordPress `/wp-admin`, Drupal `/admin/...` REST endpoints) are also
 * unrelated. The match patterns exclude these via the lookbehind on `/api`.
 *
 * Match shape: `/administration` OR `/admin` followed by any non-identifier
 * character (or end of string), NOT preceded by `/api`. Catches:
 *   - `/administration/foo`, `/administration?tab=x`
 *   - `/admin/foo`, `/admin?tab=x`
 *   - bare `/administration` / `/admin` at line / string end
 *
 * Does NOT match `/administrations`, `/admin_foo`, `/admins`, `/api/admin/*`.
 *
 * Allowlist:
 *   - this script (self-reference)
 *   - `next.config.ts` between `administration-route-allowlist-start` /
 *     `administration-route-allowlist-end` AND
 *     `admin-route-allowlist-start` / `admin-route-allowlist-end` sentinels
 *     (the redirect rules — and any other sentinel-bounded block)
 *   - `src/lib/wordpress-api.ts` — references the EXTERNAL WordPress REST
 *     endpoint `/wp-json/.../administration`, not a Cinatra route
 *
 * Usage:
 *   node scripts/audit/administration-route-banned.mjs
 *
 * Exit codes:
 *   0  no NEW banned references introduced by this PR (legacy tolerated)
 *   1  one or more banned references introduced by this PR
 *   2  `ADMIN_ROUTE_DIFF_BASE` was set but does NOT resolve to a git ref
 *      (CI fetch-depth misconfig surfacing — fail-loud rather than
 *      silently falling back to strict mode)
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

import {
  resolveBaseRef,
  buildRenameMap,
  getAddedLineNumbers,
} from "./_lib/touch-ratchet.mjs";

const REPO_ROOT = process.cwd();
// Two-prefix matcher with API-route exclusion via lookbehind on `/api`,
// AND with a word-char lookbehind to filter enumeration text like
// `owner/admin` (where `admin` is a member-role label, not a URL path).
// The follower must be a non-identifier char so we don't false-positive on
// `/administrations` or `/admin_foo`. `/admins` and similar identifiers
// also fall through. `/admin` without a trailing `/` or boundary char is
// also allowed (e.g. JSDoc text "the admin namespace" — no leading slash).
//
// The leading-slash lookbehind:
//   - `(?<![\w.])` — the leading slash is NOT preceded by a word character
//     or a dot, so `owner/admin` (word + slash + admin) AND relative file
//     paths like `../admin/README.md` / `./admin/foo` (dot + slash + admin —
//     markdown links to the docs/admin/ guide directory, not UI routes) are
//     rejected.
//   - `(?<!\/api)` — the leading slash is NOT preceded by `/api`, so
//     `/api/admin/*` API routes are rejected.
// External URL paths like `http://host.com/admin` are filtered because
// the slash before `admin` is preceded by `m` (a word char from the host).
const SCAN_REGEX = /(?<![\w.])(?<!\/api)\/(administration|admin)(?![a-zA-Z0-9_-])/;
const FOUND = [];

const SCAN_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".md", ".mdx", ".json", ".yml", ".yaml",
]);

const SKIP_DIRS = new Set([
  ".git", ".next", ".turbo", "node_modules", "dist", "build",
  "coverage", ".cache", ".vercel", ".pnpm-store",
  ".playwright-mcp", "playwright-report", "test-results",
  // `/data/` is gitignored — local-only runtime state (skill extractions,
  // backups). Never live in CI; scanning it locally produces false
  // positives where the touch-ratchet treats the disk-only content as
  // "introduced by this PR" because it has no base counterpart.
  "data",
]);

const SKIP_DIR_PREFIXES = [
  "packages/mcp-server/vendor/",
];

const ALLOWLISTED_FILES = new Set([
  "scripts/audit/administration-route-banned.mjs",
  // The MCP machine-flow gate legitimately names the old /administration/mcp/*
  // paths as its banned-pattern definitions.
  "scripts/audit/administration-mcp-machine-flow-banned.mjs",
  "src/lib/wordpress-api.ts",
  // The redirect-table test asserts behavior of the legacy → /configuration
  // chain by NAMING both legacy prefixes in describe blocks and assertions.
  // Branch-state-aware: skips the integrated-only assertions until the rename
  // lands. Not a UI ref that needs banning.
  "src/lib/__tests__/next-config-redirects.test.ts",
  // The Drupal module's settings page lives at the STANDARD Drupal admin path
  // `/admin/config/services/cinatra` (a Drupal CMS route, not a Cinatra Next.js
  // UI route — the gate's docblock already notes Drupal `/admin/...` is
  // unrelated). These files reference that Drupal route in the widget bundle
  // href, the CMS-integration docs, and the WP/Drupal UAT harness.
  "src/app/api/drupal/bundle.js/route.ts",
  "docs/developer/integrating-with-a-cms.md",
  "docs/user/cinatra-in-your-cms.md",
  "tests/e2e/wp-drupal-uat/drupal/drupal-uat.spec.ts",
  "tests/e2e/wp-drupal-uat/global-setup.ts",
  // cinatra#221 Connect provisioning: the per-client callback contract pins the
  // Drupal CMS callback path `/admin/config/services/cinatra/connect/callback`
  // (a Drupal CMS route the redirect_uri must exactly match — NOT a Cinatra
  // Next.js UI route). Same external-Drupal-admin rationale as the entries
  // above; the gate's docblock notes Drupal `/admin/...` is unrelated.
  "src/lib/connect-provisioning.ts",
  // cinatra#480 closed-registration gate: references better-auth's admin-plugin
  // hook context path `ctx.path === "/admin/create-user"` (mounted under
  // `/api/auth`, so the exposed sub-path is the bare `/admin/create-user`) to
  // permit admin-created users when self-registration is closed. This is an
  // auth-handler API context path, NOT a Cinatra Next.js UI route — same
  // not-a-UI-route rationale as the Drupal/WordPress entries above. The test
  // asserts the exact literal, so it is allowlisted too.
  "src/lib/closed-registration-gate.ts",
  "src/lib/__tests__/closed-registration-gate.test.ts",
]);

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name);
}

function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(REPO_ROOT, p);
    if (SKIP_DIR_PREFIXES.some((pfx) => rel.startsWith(pfx) || rel.includes("/" + pfx))) continue;
    if (e.isDirectory()) {
      if (shouldSkipDir(e.name)) continue;
      walk(p);
      continue;
    }
    if (!SCAN_EXTS.has("." + e.name.split(".").pop())) continue;
    if (ALLOWLISTED_FILES.has(rel)) continue;
    scanFile(p, rel);
  }
}

function scanFile(absPath, relPath) {
  let content;
  try { content = readFileSync(absPath, "utf8"); } catch { return; }
  if (!SCAN_REGEX.test(content)) return;

  // next.config.ts: skip lines between sentinels.
  let lines = content.split("\n");
  // Skip any sentinel-wrapped allowlist block: the `administration-route`
  // redirect rule AND the `mcp-machine-flow` redirect rule (which legitimately
  // references the old /administration/mcp/* paths in its redirect sources).
  let inAllow = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/-allowlist-start\b/.test(line)) { inAllow = true; continue; }
    if (/-allowlist-end\b/.test(line)) { inAllow = false; continue; }
    if (inAllow) continue;
    if (SCAN_REGEX.test(line)) {
      FOUND.push({ file: relPath, line: i + 1, text: line.trim().slice(0, 160) });
    }
  }
}

walk(REPO_ROOT);

// Touch-ratchet: a finding on a line the PR did NOT add is pre-existing
// legacy and tolerated. A finding on a line the PR ADDED blocks. When no
// diff base resolves (strict mode), every finding blocks — appropriate
// for a true scan-from-scratch (local fail-closed default + CI mis-
// configuration self-disclosure).
let baseRef = null;
try {
  baseRef = resolveBaseRef("ADMIN_ROUTE_DIFF_BASE");
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(2);
}
const renameMap = buildRenameMap(baseRef);

// Group findings by file so we only compute the added-line set once per
// file. Tolerated findings get logged at the end for transparency.
const byFile = new Map();
for (const f of FOUND) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push(f);
}
const introduced = [];
let toleratedFileCount = 0;
for (const [file, items] of byFile.entries()) {
  const addedLines = baseRef ? getAddedLineNumbers(file, baseRef, renameMap) : null;
  if (addedLines === null) {
    // file didn't exist at base (or strict mode) → every finding is introduced
    introduced.push(...items);
    continue;
  }
  let fileHadIntroduced = false;
  for (const item of items) {
    if (addedLines.has(item.line)) {
      introduced.push(item);
      fileHadIntroduced = true;
    }
  }
  if (!fileHadIntroduced) toleratedFileCount += 1;
}

if (introduced.length === 0) {
  if (toleratedFileCount > 0) {
    console.log(
      `✓ no NEW /administration route references introduced by this PR ` +
      `(${toleratedFileCount} legacy file(s) still carrying findings — tolerated).`,
    );
  } else {
    console.log("✓ no /administration route references found outside allowlist");
  }
  process.exit(0);
}

console.error(`✗ found ${introduced.length} NEW /administration reference(s) introduced by this PR:\n`);
for (const f of introduced) {
  console.error(`  ${f.file}:${f.line}  ${f.text}`);
}
if (toleratedFileCount > 0) {
  console.error(
    `\n(informational: ${toleratedFileCount} legacy file(s) still carrying findings, ` +
    `untouched by this PR — tolerated.)`,
  );
}
console.error(`\nRename /administration/X or /admin/X → /configuration/X (UI route only).`);
console.error(`API routes (/api/admin/*, /api/administration/*) are unrelated and untouched by this gate.`);
console.error(`If this is an external admin URL (vendor dashboard, WordPress /wp-admin, Drupal REST), allowlist the file in scripts/audit/administration-route-banned.mjs.`);
process.exit(1);
