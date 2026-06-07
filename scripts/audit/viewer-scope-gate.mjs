#!/usr/bin/env node
/**
 * Viewer-scope spoofing-guard regression gate.
 *
 * The cinatra-side helper `getEffectiveViewerScope(identity)` (in
 * `src/lib/marketplace-credentials.ts`) is the canonical source for the
 * npm-scope a caller is privileged to see across visibility filters. The
 * historical pattern that derived `viewerScope = "@" + identity.instanceNamespace`
 * is spoofable because `instanceNamespace` is editable pre-vendor-approval —
 * a consumer could rename their instance to `@some-vendor-name` to
 * impersonate that vendor's view of `cinatra.origin: { visibility: "private" }`
 * packages.
 *
 * This gate blocks any new occurrence of the spoofable pattern across the
 * production source surface. The full AST-perfect coverage of the second
 * variant (`resolvedConfig.packageScope` being read for a visibility/private-
 * access decision) is deferred to a follow-up: a literal grep for
 * `packageScope` would false-positive on legitimate config sites. For the
 * milestone close-out the per-call-site migration plus the explicit
 * `listAgentPackages` fallback removal already cover the second variant.
 *
 * Patterns the gate blocks (regex on production files, line-based):
 *   - `viewerScope = "@" + identity.instanceNamespace` (raw derivation)
 *   - `viewerScope: "@" + identity.instanceNamespace` (object property)
 *   - `vendorScope = "@" + identity.instanceNamespace` (legacy local var name)
 *   - `\`@${identity.instanceNamespace}\`` template-literal form
 *
 * Scope:
 *   - SCAN: src/**, packages/**\/src/** (production TS/TSX/JS files)
 *   - SKIP: tests, fixtures, types-only files, planning docs
 *   - SKIP: src/lib/marketplace-credentials.ts (the helper itself documents
 *     the spoofable pattern in a JSDoc comment)
 *   - SKIP: src/app/setup/** (setup wizard validates the candidate string,
 *     not the viewer identity)
 *
 * Exit codes:
 *   0  no production occurrences of the spoofable derivation pattern
 *   1  one or more occurrences (BLOCKER)
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";

const REPO_ROOT = process.cwd();

const SCAN_GLOBS = [
  "src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
  "packages/*/src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
];

const SKIP_PATH_REGEXES = [
  /__tests__\//,
  /__fixtures__\//,
  /__mocks__\//,
  /\.test\.(ts|tsx|js|jsx)$/,
  /\.spec\.(ts|tsx|js|jsx)$/,
  // helper itself documents the spoofable derivation in a comment.
  /^src\/lib\/marketplace-credentials\.ts$/,
  // setup-wizard owns the candidate-namespace validity check, which
  // operates on the proposed string, not the viewer identity.
  /^src\/app\/setup\//,
  // destination-resolver is publish-side: it builds the registry packageScope
  // for a write call, not a viewer visibility filter. Publish guards live in
  // `loadVerdaccioWriteConfigForServer()`.
  /^packages\/extensions\/src\/destination-resolver\.ts$/,
];

// Spoofable producer: a variable / property named `viewerScope` or
// `vendorScope` (legacy local-var name) derived from `identity.instanceNamespace`.
// The combination of the variable role AND the spoofable source is the
// fingerprint — viewerScope is what visibility filters consume, and
// instanceNamespace is the editable surface a consumer could rename.
//
// JSX text `@{x}` (no `$`) is not matched. Publish-side derivations like
// `const namespace = `@${identity.instanceNamespace}`` (a vendor registering
// or rotating their own scope) are not matched because the LHS variable is
// `namespace`, not `viewerScope`/`vendorScope`. Verdaccio `packageScope`
// fields built for write paths are similarly not matched.
const VIEWER_SCOPE_PRODUCER =
  /\b(?:viewerScope|vendorScope)\b[^=]*[=:][^=].*\bidentity\.instanceNamespace\b/;

const COMMENT_PREFIX = /^\s*(?:\*|\/\/|<!--)/;

const BANNED_PATTERNS = [
  {
    name: "viewerScope/vendorScope derived from identity.instanceNamespace",
    regex: VIEWER_SCOPE_PRODUCER,
  },
];

function listTrackedFiles() {
  const stdout = execFileSync(
    "git",
    ["ls-files", "--", "src", "packages"],
    { encoding: "utf8", cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.split("\n").filter(Boolean);
}

function shouldScan(relPath) {
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(relPath)) return false;
  if (!relPath.startsWith("src/") && !relPath.startsWith("packages/")) return false;
  // packages/<name>/src/** only — skip packages/<name>/dist/<...> mirrors and
  // packages/<name>/vendor/<...> third-party copies.
  if (relPath.startsWith("packages/") && !/^packages\/[^/]+\/src\//.test(relPath)) return false;
  for (const r of SKIP_PATH_REGEXES) {
    if (r.test(relPath)) return false;
  }
  return true;
}

const findings = [];
for (const relPath of listTrackedFiles()) {
  if (!shouldScan(relPath)) continue;
  const abs = resolve(REPO_ROOT, relPath);
  let body;
  try {
    body = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip JSDoc/line/comment-only lines — they're documenting the
    // forbidden pattern, not introducing it.
    if (COMMENT_PREFIX.test(line)) continue;
    for (const pattern of BANNED_PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push({ file: relPath, line: i + 1, match: line.trim(), pattern: pattern.name });
      }
    }
  }
}

if (findings.length === 0) {
  console.log("viewer-scope-gate: OK — no spoofable identity.instanceNamespace viewer-scope derivations in production code.");
  process.exit(0);
}

console.error("");
console.error("ERROR: viewer-scope spoofing-guard violation.");
console.error("");
console.error("The pattern `viewerScope = \"@\" + identity.instanceNamespace` is forbidden");
console.error("in production code. It lets an unapproved consumer rename their instance to");
console.error("impersonate a vendor's privileged view of `cinatra.origin: { visibility:");
console.error('"private" }` packages.');
console.error("");
console.error("Use the canonical helper instead:");
console.error("  import { getEffectiveViewerScope } from \"@/lib/marketplace-credentials\";");
console.error("  const viewerScope = getEffectiveViewerScope(identity);");
console.error("");
console.error(`--- ${findings.length} finding(s) (BLOCKER) ---`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.pattern}]`);
  console.error(`    ${f.match}`);
}
console.error("");
process.exit(1);
