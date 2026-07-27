#!/usr/bin/env node
// CI gate: every host-committed SKILL.md must pass upstream-standard frontmatter
// validation (cinatra#494), AND no committed runtime mirror may exist that could
// silently drift from its companion-repo source (cinatra#495).
//
// ── #494 (validation) ──────────────────────────────────────────────────────
// The upstream Anthropic SKILL.md validator (skill-creator/quick_validate.py)
// permits ONLY these top-level frontmatter keys:
//   name, description, license, allowed-tools, metadata, compatibility
// plus: required `name` (kebab-case, <=64 chars) + `description` (a string,
// <=1024 chars, NO angle brackets). Cinatra-specific keys (e.g. `match_when`)
// live UNDER `metadata:` — the Wave-0 dual-read in
// packages/skills/src/frontmatter.ts reads `metadata.match_when` PREFERRED with
// a legacy top-level fallback. This gate ports that validator's rules to JS so
// CI needs no Python, and FAILS on any host-committed SKILL.md that would trip
// the upstream validator.
//
// ── #495 (no committed drift-prone mirror) ─────────────────────────────────
// The runtime skill-store (`data/skill-store/`) and the cloned-back extension
// source tree (`extensions/`) are BOTH gitignored — they are hydrated at build /
// dev time from the canonical sources (companion `cinatra-ai/<slug>` repos pinned
// in cinatra-required-extensions.lock.json + a content-store migration), never
// committed. That is exactly what makes "fixing a source skill cannot leave a
// stale runtime mirror" structurally true: there is no committed mirror to go
// stale. This gate LOCKS that invariant: it fails if ANY SKILL.md is git-tracked
// under `data/skill-store/` or `extensions/`, so a contributor cannot reintroduce
// a committed mirror that could silently diverge from its source.
//
// ── Scope ──────────────────────────────────────────────────────────────────
// Validates git-TRACKED SKILL.md under `packages/` and `src/` only. It does NOT
// validate the cloned-back `extensions/` tree: those skills are owned by their
// companion repos (fixed + pinned there), and enforcing them here would red the
// host PR on pre-existing, out-of-repo failures. Test fixtures under
// `**/__tests__/fixtures/**` are excluded (a fixture is not a loadable skill);
// they still get valid frontmatter so they cannot be mistaken for one, but the
// gate does not police fixture content.
//
// ── #2089 (S2): ONE validator ──────────────────────────────────────────────
// The frontmatter rules this gate used to carry inline now live in the SHARED
// verdict module (`scripts/audit/_lib/skill-packaging-verdict.mjs`) that store
// install and the extension repos' publish gate consume too, so a SKILL.md can
// never be accepted at one enforcement point and refused at another. This gate
// keeps its own scope (git-tracked host SKILL.md + the committed-mirror ban);
// the schema itself is imported. The fixture exclusion now reads the SHARED
// policy artifact (config/skill-fixture-allowlist.json) instead of a private
// regex.
//
// Usage:
//   node scripts/audit/skill-frontmatter-gate.mjs   # exit 1 on any finding

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ALLOWED_FRONTMATTER_KEYS,
  matchesAllowlist,
  resolveFixtureAllowlist,
  validateSkillFrontmatter,
} from "./_lib/skill-packaging-verdict.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

// Upstream allowed top-level frontmatter keys (mirrors quick_validate.py) —
// owned by the shared verdict module, re-exported here for the gate's messages
// and for the tests that pin the two gates together.
const ALLOWED_PROPERTIES = new Set(ALLOWED_FRONTMATTER_KEYS);
export { validateSkillFrontmatter };

// SKILL.md under these prefixes are host-canonical and MUST validate.
const VALIDATE_PREFIXES = ["packages/", "src/"];

// SKILL.md committed under these prefixes are a forbidden drift-prone mirror.
const MIRROR_BAN_PREFIXES = ["data/skill-store/", "extensions/"];

// A loadable-skill validation is skipped for fixture trees (not loadable
// skills). The pattern set is the SHARED policy artifact — the same list the
// packaging gate and the store-install seam apply.
function hostFixtureAllowlist() {
  try {
    const policy = JSON.parse(readFileSync(join(REPO_ROOT, "config", "skill-fixture-allowlist.json"), "utf8"));
    return resolveFixtureAllowlist(policy, "cinatra");
  } catch {
    // Fail CLOSED: an unreadable policy means NOTHING is exempt, so a missing
    // artifact surfaces as loud findings rather than a silently-wider gate.
    return [];
  }
}

function gitTrackedSkillMds() {
  let out;
  try {
    out = execFileSync("git", ["ls-files", "--", "*SKILL.md", "**/SKILL.md"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.endsWith("SKILL.md"));
}

// The SKILL.md frontmatter schema itself is the SHARED verdict's
// `validateSkillFrontmatter` (imported + re-exported above): one
// dependency-free implementation for CI, store install and publish.

export function scan() {
  const findings = [];
  const fixtureAllowlist = hostFixtureAllowlist();
  for (const rel of gitTrackedSkillMds()) {
    // #495: forbidden committed mirror.
    if (MIRROR_BAN_PREFIXES.some((p) => rel.startsWith(p))) {
      findings.push({
        file: rel,
        rule: "committed-mirror",
        reason:
          "SKILL.md committed under a hydrated mirror tree (data/skill-store/ or " +
          "extensions/). These trees are gitignored and rebuilt from the canonical " +
          "source; a committed copy here can silently drift. Remove it.",
      });
      continue;
    }
    // #494: host-canonical skills must validate.
    if (!VALIDATE_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (matchesAllowlist(rel, fixtureAllowlist)) continue;
    let content;
    try {
      content = readFileSync(join(REPO_ROOT, rel), "utf8");
    } catch {
      continue;
    }
    const reason = validateSkillFrontmatter(content);
    if (reason) {
      findings.push({ file: rel, rule: "invalid-frontmatter", reason });
    }
  }
  return findings;
}

function main() {
  const findings = scan();
  if (findings.length === 0) {
    console.log("[skill-frontmatter-gate] OK (all host-committed SKILL.md valid; 0 committed mirrors).");
    return;
  }
  const invalid = findings.filter((f) => f.rule === "invalid-frontmatter");
  const mirrors = findings.filter((f) => f.rule === "committed-mirror");
  if (invalid.length > 0) {
    console.error(
      `[skill-frontmatter-gate] ${invalid.length} SKILL.md fail upstream frontmatter validation ` +
        `(allowed top-level keys: ${[...ALLOWED_PROPERTIES].sort().join(", ")}):`,
    );
    for (const f of invalid) console.error(`  ${f.file}  -> ${f.reason}`);
  }
  if (mirrors.length > 0) {
    console.error(`[skill-frontmatter-gate] ${mirrors.length} committed runtime mirror(s) found:`);
    for (const f of mirrors) console.error(`  ${f.file}  -> ${f.reason}`);
  }
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
