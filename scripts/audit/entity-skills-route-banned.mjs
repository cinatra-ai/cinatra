#!/usr/bin/env node
/**
 * `/entity/skills` + `/profile/skills` route-retirement guard.
 *
 * Personal skill CRUD moved from `/entity/skills` (and the even-older
 * `/profile/skills`) into the unified `/skills` tree:
 *   - list: `/skills?scope=personal`
 *   - new:  `/skills/new`
 *   - edit: `/skills/<id>/edit`
 *
 * This gate prevents the legacy paths from being reintroduced, banning:
 *   (a) any `/entity/skills` or `/profile/skills` string literal (href / Link
 *       / redirect / revalidatePath / etc.);
 *   (b) the route plumbing symbols `EntitySkillsPageMount`,
 *       `NewEntitySkillPageMount`, `EditEntitySkillPageMount`,
 *       `EntitySkillsCatchAllRoute`, `EntitySkillsPage`,
 *       `NewEntitySkillPage`, `EditEntitySkillPage`;
 *   (c) the legacy `<EntityNavigation>` component;
 *   (d) the literal route directories `src/app/entity/` (any depth).
 *
 * Scoped to tracked first-party TypeScript / JS / Markdown under `src/`,
 * `packages/`, and `scripts/`. The audit script self-reference and
 * `next.config.ts` allowlisted redirect block are excluded.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCAN_PREFIXES = ["src/", "packages/", "scripts/", "next.config.ts"];

const ALLOWLIST_PATHS = new Set([
  "scripts/audit/entity-skills-route-banned.mjs",
  // The redirect-table test asserts that the legacy /entity/skills* and
  // /profile/skills* paths resolve via the next.config.ts redirect chain;
  // it legitimately names both prefixes in describe blocks and assertions.
  // Not a UI ref that needs banning.
  "src/lib/__tests__/next-config-redirects.test.ts",
]);

// next.config.ts is allowed to reference the legacy paths *only* inside the
// retire-allowlist block bounded by the markers below — those rules redirect
// stale bookmarks to the new home and are the whole reason the gate exists.
const NEXT_CONFIG_PATH = "next.config.ts";
const NEXT_CONFIG_ALLOWLIST_START = "// entity-skills-retire-allowlist-start";
const NEXT_CONFIG_ALLOWLIST_END = "// entity-skills-retire-allowlist-end";

const BANNED_PATTERNS = [
  { re: /["'`]\/entity\/skills(?:[/?#"'`]|$)/g, label: "reference to the removed /entity/skills route" },
  { re: /["'`]\/profile\/skills(?:[/?#"'`]|$)/g, label: "reference to the removed /profile/skills route" },
  { re: /\bEntitySkillsPageMount\b/g, label: "removed route plumbing symbol EntitySkillsPageMount" },
  { re: /\bNewEntitySkillPageMount\b/g, label: "removed route plumbing symbol NewEntitySkillPageMount" },
  { re: /\bEditEntitySkillPageMount\b/g, label: "removed route plumbing symbol EditEntitySkillPageMount" },
  { re: /\bEntitySkillsCatchAllRoute\b/g, label: "removed route plumbing symbol EntitySkillsCatchAllRoute" },
  { re: /\bEntitySkillsPage\b/g, label: "removed page component EntitySkillsPage" },
  { re: /\bNewEntitySkillPage\b/g, label: "removed page component NewEntitySkillPage" },
  { re: /\bEditEntitySkillPage\b/g, label: "removed page component EditEntitySkillPage" },
  { re: /\bEntityNavigation\b/g, label: "removed legacy component EntityNavigation" },
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

function stripAllowlistedNextConfigRegion(content) {
  const startIdx = content.indexOf(NEXT_CONFIG_ALLOWLIST_START);
  const endIdx = content.indexOf(NEXT_CONFIG_ALLOWLIST_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content;
  return content.slice(0, startIdx) + content.slice(endIdx + NEXT_CONFIG_ALLOWLIST_END.length);
}

function main() {
  // (d) ban the literal route directory reappearing.
  const dirFindings = [];
  try {
    const tracked = execFileSync("git", ["ls-files", "--", "src/app/entity/"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const p of tracked) {
      dirFindings.push({ file: p, label: "literal src/app/entity/ route directory must stay removed" });
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
    if (file === NEXT_CONFIG_PATH) {
      content = stripAllowlistedNextConfigRegion(content);
    }
    for (const { re, label } of BANNED_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(content)) findings.push({ file, label });
    }
  }

  if (findings.length === 0) {
    console.log("✓ no /entity/skills or /profile/skills references or plumbing found.");
    return;
  }

  console.error(
    "ERROR: /entity/skills + /profile/skills routes were retired — references found:\n",
  );
  for (const { file, label } of findings) {
    console.error(`  ${file} — ${label}`);
  }
  console.error(
    "\nPersonal skill CRUD lives at /skills (list via ?scope=personal, new via" +
      " /skills/new, edit via /skills/<id>/edit). Add new redirects to the" +
      " bounded block in next.config.ts if you need them — do not reintroduce" +
      " the legacy routes, mounts, or EntityNavigation component.",
  );
  process.exit(1);
}

main();
