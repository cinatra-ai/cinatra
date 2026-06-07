#!/usr/bin/env node
/**
 * `/skills/packages` route-retirement guard.
 *
 * The `/skills/packages` list + `/skills/packages/<slug>` detail routes were
 * removed; the package surface folded into the unified `/skills` list. This
 * gate prevents the route from being reintroduced, banning:
 *   (a) any `/skills/packages` string literal (href / Link / redirect / etc.);
 *   (b) the route plumbing symbols `SkillsPackagesPageMount`,
 *       `SkillPackagePageMount`;
 *   (c) the catch-all package branch `normalizedSlug[0] === "packages"`;
 *   (d) the literal route directory `src/app/skills/packages/`.
 *
 * Scoped to tracked first-party TypeScript / JS / Markdown under `src/`,
 * `packages/`, and `scripts/`. The audit script self-reference is allowlisted.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCAN_PREFIXES = ["src/", "packages/", "scripts/"];

const ALLOWLIST_PATHS = new Set([
  "scripts/audit/skills-packages-route-banned.mjs",
]);

const BANNED_PATTERNS = [
  { re: /\/skills\/packages\b/g, label: "reference to the removed /skills/packages route" },
  { re: /\bSkillsPackagesPageMount\b/g, label: "removed route plumbing symbol SkillsPackagesPageMount" },
  { re: /\bSkillPackagePageMount\b/g, label: "removed route plumbing symbol SkillPackagePageMount" },
  {
    re: /normalizedSlug\[0\]\s*===\s*["']packages["']/g,
    label: "reintroduced catch-all package branch (normalizedSlug[0] === \"packages\")",
  },
];

function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files", "--", ...SCAN_PREFIXES], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => /\.(ts|tsx|mjs|cjs|js|jsx|md)$/.test(p))
    .filter((p) => !ALLOWLIST_PATHS.has(p));
}

function main() {
  // (d) ban the literal route directory reappearing.
  const dirFindings = [];
  try {
    const tracked = execFileSync("git", ["ls-files", "--", "src/app/skills/packages/"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const p of tracked) {
      dirFindings.push({ file: p, label: "literal /skills/packages route directory must stay removed" });
    }
  } catch {
    // no matches — fine
  }

  const findings = [...dirFindings];
  for (const file of listTrackedFiles()) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const { re, label } of BANNED_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(content)) findings.push({ file, label });
    }
  }

  if (findings.length === 0) {
    console.log("✓ no /skills/packages route references or plumbing found.");
    return;
  }

  console.error("ERROR: /skills/packages route was retired — references found:\n");
  for (const { file, label } of findings) {
    console.error(`  ${file} — ${label}`);
  }
  console.error(
    "\nThe package surface folded into the unified /skills list. Link to /skills" +
      " (optionally /skills?q=<packageName>) instead, and do not re-add the route" +
      " page, catch-all branch, or page mounts.",
  );
  process.exit(1);
}

main();
