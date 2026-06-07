#!/usr/bin/env node
/**
 * Skill-read default-root-only audit gate.
 *
 * Fails CI if any of the following appear in source:
 *   - `readSkillFileContent` regains an `allowedRoots` parameter or any
 *     second-argument options shape.
 *   - Any caller passes `allowedReadRoots` to `createLocalSkillShellTool`.
 *   - A new path-override pattern (`allowedRoots: string[]`,
 *     `allowedReadRoots: string[]`) shows up around the skill read surface.
 *
 * Scoped to first-party TypeScript source under `packages/`, `src/`,
 * `extensions/`. Audit-script self-references + historical doc comments
 * + the unrelated openai-connector `ensurePathAllowed(_, allowedRoots, _)`
 * helper are explicitly allowlisted.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCAN_GLOBS = ["src/", "packages/", "extensions/"];

const ALLOWLIST_PATHS = new Set([
  "scripts/audit/skill-read-default-root-only.mjs",
  // Historical doc comments / retirement explanations.
  "packages/skills/src/skills-store.ts",
  "packages/skills/src/__tests__/read-skill-file-content.test.ts",
  "packages/llm/src/tools/skills.ts",
  "src/app/api/llm-bridge/route.ts",
  // Unrelated local `allowedRoots` parameter in ensurePathAllowed helper.
  "extensions/cinatra-ai/openai-connector/src/openai-skills.ts",
]);

const BANNED_PATTERNS = [
  {
    re: /readSkillFileContent\s*\([^)]*,\s*\{[^}]*allowedRoots/g,
    label: "readSkillFileContent called with { allowedRoots: ... } 2nd-argument override",
  },
  {
    re: /\ballowedRoots\??\s*:\s*string\[\]/g,
    label: "allowedRoots: string[] declaration (regrowth of removed parameter)",
  },
  {
    re: /\ballowedReadRoots\??\s*:\s*string\[\]/g,
    label: "allowedReadRoots: string[] declaration (regrowth of removed plumbing)",
  },
  {
    re: /createLocalSkillShellTool\s*\(\s*\{[^}]*allowedReadRoots/gs,
    label: "createLocalSkillShellTool called with allowedReadRoots",
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
    console.log("✓ no skill-read default-root override patterns found.");
    process.exit(0);
  }
  console.error(`✗ found ${all.length} skill-read containment-override violation(s):`);
  console.error("");
  for (const { file, line, label, snippet } of all) {
    console.error(`  ${file}:${line}  ${label}`);
    console.error(`    ${snippet}`);
  }
  console.error("");
  console.error("Skill reads are catalog-only. Register the SKILL.md");
  console.error("into the catalog via `registerExtensionSkill` (which mirrors it");
  console.error("into the default `data/skills` root) instead of widening the read");
  console.error("containment with `allowedRoots` / `allowedReadRoots`.");
  process.exit(1);
}

main();
