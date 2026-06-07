#!/usr/bin/env node
/**
 * WordPress / Drupal connector package-name rename guard.
 *
 * Bans any in-tree import of the legacy connector package names
 * `@cinatra-ai/wordpress-connector` and `@cinatra-ai/drupal-connector`.
 * Both packages were renamed to `@cinatra-ai/{wordpress,drupal}-mcp-connector`
 * and fully removed (no re-export shims) — this gate prevents the old names
 * from being reintroduced.
 *
 * Scoped to first-party TypeScript + JS source under `src/`, `packages/`,
 * `extensions/`, and `scripts/`. The audit-script self-reference and the
 * data-migration file (which names the OLD packages as its rewrite source)
 * are allowlisted.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCAN_GLOBS = ["src/", "packages/", "extensions/", "scripts/"];

const ALLOWLIST_PATHS = new Set([
  "scripts/audit/wordpress-drupal-connector-rename-banned.mjs",
]);

const BANNED_PATTERNS = [
  {
    re: /@cinatra-ai\/wordpress-connector\b/g,
    label: "import of @cinatra-ai/wordpress-connector (use @cinatra-ai/wordpress-mcp-connector)",
  },
  {
    re: /@cinatra-ai\/drupal-connector\b/g,
    label: "import of @cinatra-ai/drupal-connector (use @cinatra-ai/drupal-mcp-connector)",
  },
];

function listFiles() {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCAN_GLOBS],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return out
      .split("\0")
      .filter((f) => f && /\.(?:ts|tsx|mts|mjs|json)$/.test(f));
  } catch {
    return [];
  }
}

function scanFile(file) {
  if (ALLOWLIST_PATHS.has(file)) return [];
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const findings = [];
  const lines = content.split(/\r?\n/);
  for (const { re, label } of BANNED_PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content)) !== null) {
      const upTo = content.slice(0, match.index);
      const line = (upTo.match(/\n/g) ?? []).length + 1;
      const snippet = (lines[line - 1] ?? "").trim().slice(0, 160);
      findings.push({ file, line, label, snippet });
    }
  }
  return findings;
}

function main() {
  const files = listFiles();
  const all = [];
  for (const f of files) all.push(...scanFile(f));
  if (all.length === 0) {
    console.log("✓ no @cinatra-ai/wordpress-connector or @cinatra-ai/drupal-connector references found outside shim allowlist.");
    process.exit(0);
  }
  console.error(`✗ found ${all.length} banned connector-rename violation(s):`);
  console.error("");
  for (const { file, line, label, snippet } of all) {
    console.error(`  ${file}:${line}  ${label}`);
    console.error(`    ${snippet}`);
  }
  console.error("");
  console.error("Rename the import: @cinatra-ai/wordpress-connector → @cinatra-ai/wordpress-mcp-connector");
  console.error("                 @cinatra-ai/drupal-connector    → @cinatra-ai/drupal-mcp-connector");
  console.error("The old package names were fully removed — there is no re-export shim.");
  process.exit(1);
}

main();
