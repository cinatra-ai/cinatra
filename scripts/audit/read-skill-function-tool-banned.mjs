#!/usr/bin/env node
/**
 * `read_skill` function-tool recurrence guard.
 *
 * Fails CI if `createReadSkillTool` or the `name: "read_skill"` function-tool
 * shape reappears in first-party source. The legacy function-tool was retired
 * (see CLAUDE.md "skills CATALOG-registry-only + shell-tool delivery
 * rule"). Reintroducing it reopens the catalog-bypass surface.
 *
 * Scoped to first-party TypeScript under `packages/`, `src/`, `extensions/`.
 * Audit-script self-references + historical doc comments are allowlisted.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCAN_GLOBS = ["src/", "packages/", "extensions/"];

const ALLOWLIST_PATHS = new Set([
  "scripts/audit/read-skill-function-tool-banned.mjs",
  // Historical doc comments / retirement explanations.
  "packages/llm/src/tools/skills.ts",
  // Anthropic standing-invariant regression test: constructs a `read_skill`
  // function-tool fixture to PROVE the provider boundary guard rejects it.
  // Removing this test would dismantle the Anthropic skill-delivery guarantee.
  "packages/llm/src/__tests__/anthropic-no-function-tool-skills.test.ts",
]);

const BANNED_PATTERNS = [
  {
    re: /\bcreateReadSkillTool\b/g,
    label: "createReadSkillTool reference (function-tool was retired)",
  },
  {
    re: /\bname\s*:\s*["']read_skill["']/g,
    label: 'function-tool shape `name: "read_skill"` (retired)',
  },
];

function listFiles() {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCAN_GLOBS],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return out.split("\0").filter((f) => f && /\.(?:ts|tsx|mts)$/.test(f));
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
      // Allow the token inside a single-line comment that explicitly notes the
      // retirement (transitional friendliness; the in-file doc comments are
      // allowlisted whole-file above for the tools/skills.ts case).
      if (/^\s*(\/\/|\/\*|\*)/.test(lines[line - 1] ?? "")) continue;
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
    console.log("✓ no read_skill function-tool references found.");
    process.exit(0);
  }
  console.error(`✗ found ${all.length} read_skill function-tool violation(s):`);
  console.error("");
  for (const { file, line, label, snippet } of all) {
    console.error(`  ${file}:${line}  ${label}`);
    console.error(`    ${snippet}`);
  }
  console.error("");
  console.error("The `read_skill` function-tool was retired. Use the");
  console.error("shell tool with a catalog-resolved `sourcePath` instead. Register");
  console.error("extension SKILL.md files via `registerExtensionSkill` first.");
  process.exit(1);
}

main();
