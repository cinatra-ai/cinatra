#!/usr/bin/env node
/**
 * Stale-table regression guard.
 *
 * Scans the repo for references to the obsolete Better Auth oauth-provider
 * table name `oauth_application`. The installed
 * @better-auth/oauth-provider plugin's schema uses `oauthClient`
 * (camelCase, no underscore). A seeder that inserts into the nonexistent
 * `public.oauth_application` table drops the assistant's OAuth client at
 * boot every time and surfaces as the
 * `[cinatra-assistant] Could not insert oauth_application row` warning in
 * the dashboard-live-verify CI logs.
 *
 * Usage:
 *   node scripts/audit/oauth-application-banned.mjs
 *
 * Exit codes:
 *   0  no `oauth_application` tokens found in scanned source
 *   1  one or more references to `oauth_application` introduced by this PR
 *
 * Scope: source code + tests + docs under src/, packages/, tests/. Build
 * output and dependency directories (e.g. node_modules) are not scanned.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(
  /\/+$/,
  "",
);

const SCAN_ROOTS = ["src", "packages", "tests", "scripts", "extensions"];
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "playwright-report",
  "test-results",
  "coverage",
  ".cache",
  ".claude",
]);
const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".sql",
  ".md",
]);

// Self-exclusion — this script names the banned token in prose for clarity.
const SELF_PATH = relative(
  REPO_ROOT,
  fileURLToPath(import.meta.url),
).replace(/\\/g, "/");

const BANNED = "oauth_application";

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      yield* walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0) continue;
    if (!EXTENSIONS.has(entry.name.slice(dot))) continue;
    yield full;
  }
}

const findings = [];
for (const root of SCAN_ROOTS) {
  const abs = join(REPO_ROOT, root);
  for (const file of walk(abs)) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
    if (rel === SELF_PATH) continue;
    let body;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!body.includes(BANNED)) continue;
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(BANNED)) continue;
      // Regression-guard tests legitimately mention the banned string
      // inside negation assertions to prove the production code does NOT
      // contain it. Recognize the pattern and skip.
      if (
        line.includes(".not.toContain") ||
        line.includes(".not.toMatch") ||
        line.includes("expect(SOURCE).not.toContain") ||
        line.includes("WRONG table name")
      ) {
        continue;
      }
      findings.push({ file: rel, line: i + 1, text: line.trim() });
    }
  }
}

if (findings.length === 0) {
  console.log("oauth-application-banned: clean.");
  process.exit(0);
}

console.error("ERROR: 'oauth_application' references in tracked source.");
console.error("");
console.error(
  "The installed @better-auth/oauth-provider plugin's schema uses",
);
console.error(
  '`oauthClient` (camelCase). References to `oauth_application` are',
);
console.error("stale and will fail at runtime against the live schema.");
console.error("");
console.error("Fix: change references to `oauthClient` (and `redirectUris`,");
console.error("not `redirectURLs`); use the shared helper at");
console.error("`src/lib/better-auth-oauth-client.ts` for INSERT/DELETE.");
console.error("");
console.error(`--- ${findings.length} finding(s) ---`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}   ${f.text}`);
}
process.exit(1);
