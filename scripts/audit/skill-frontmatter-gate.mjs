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
// Usage:
//   node scripts/audit/skill-frontmatter-gate.mjs   # exit 1 on any finding

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

// Upstream allowed top-level frontmatter keys (mirrors quick_validate.py).
const ALLOWED_PROPERTIES = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "compatibility",
]);

// SKILL.md under these prefixes are host-canonical and MUST validate.
const VALIDATE_PREFIXES = ["packages/", "src/"];

// SKILL.md committed under these prefixes are a forbidden drift-prone mirror.
const MIRROR_BAN_PREFIXES = ["data/skill-store/", "extensions/"];

// A loadable-skill validation is skipped for fixture trees (not loadable skills).
const FIXTURE_PATH_RE = /\/__tests__\/fixtures\//;

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

// Dependency-free SKILL.md frontmatter validator.
//
// This gate runs in the lean pure-node audit lane (NO `pnpm install`; the `yaml`
// package is a packages/skills dep and is NOT hoisted under pnpm's strict
// node_modules), so it cannot import a YAML library. Instead it parses the small,
// constrained frontmatter grammar SKILL.md uses (top-level `key: value` lines,
// nested mappings/lists under `metadata:`) directly and reproduces the exact
// failure modes of the upstream quick_validate.py:
//   - missing/malformed frontmatter fences,
//   - the "mapping values are not allowed here" YAML error (an unquoted scalar
//     value containing `: ` — the real failure on bundled extension skills),
//   - disallowed top-level keys, required name/description, kebab name,
//     angle-bracket + length limits.
//
// Returns null when valid, else a human-readable reason string.

// Strip one layer of matching surrounding quotes from a scalar (single/double).
function unquoteScalar(raw) {
  const v = raw.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

// A bare (unquoted) scalar value that contains `: ` or ends with `:` is the YAML
// "mapping values are not allowed here" error the upstream validator reports on
// the bundled extension skills. Quoted scalars are exempt.
function unquotedScalarHasMappingColon(raw) {
  const v = raw.trim();
  if (!v) return false;
  if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) return false;
  return /:\s/.test(v) || /:$/.test(v);
}

export function validateSkillFrontmatter(content) {
  if (!content.startsWith("---")) return "No YAML frontmatter found";
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return "Invalid frontmatter format";

  const body = match[1];
  const lines = body.split(/\r?\n/);

  // Collect TOP-LEVEL keys (indentation 0). A line whose first non-blank char is
  // deeper-indented belongs to the previous top-level key's nested structure and
  // is not policed here (e.g. metadata.match_when entries).
  const topLevel = new Map(); // key -> { rawValue (string|null for nested/empty), line }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.trimStart().startsWith("#")) continue; // comment
    if (/^\s/.test(line)) continue; // indented → nested under a top-level key
    const m = line.match(/^([^:\s][^:]*?):(.*)$/);
    if (!m) {
      // A non-indented, non-empty line that is not `key:` shape (e.g. a bare list
      // item `- x` at column 0, or stray text) is malformed frontmatter.
      return `Invalid YAML in frontmatter: unexpected line "${line.trim()}"`;
    }
    const key = m[1].trim();
    const rest = m[2];
    // Empty value (`key:` or `key:` + trailing spaces) → nested mapping/list.
    const rawValue = rest.trim() === "" ? null : rest;
    if (rawValue !== null && unquotedScalarHasMappingColon(rawValue)) {
      return "Invalid YAML in frontmatter: mapping values are not allowed here";
    }
    topLevel.set(key, { rawValue, line: i });
  }

  const keys = [...topLevel.keys()];
  if (keys.length === 0) return "Frontmatter must be a YAML dictionary";

  const unexpected = keys.filter((k) => !ALLOWED_PROPERTIES.has(k));
  if (unexpected.length > 0) {
    return (
      `Unexpected key(s) in SKILL.md frontmatter: ${unexpected.sort().join(", ")}. ` +
      `Allowed properties are: ${[...ALLOWED_PROPERTIES].sort().join(", ")} ` +
      `(move Cinatra-specific keys such as match_when under metadata.*).`
    );
  }

  if (!topLevel.has("name")) return "Missing 'name' in frontmatter";
  if (!topLevel.has("description")) return "Missing 'description' in frontmatter";

  const nameRaw = topLevel.get("name").rawValue;
  if (nameRaw === null) return "Name must be a string, got object";
  const name = unquoteScalar(nameRaw);
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      return `Name '${name}' should be kebab-case (lowercase letters, digits, and hyphens only)`;
    }
    if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
      return `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`;
    }
    if (name.length > 64) {
      return `Name is too long (${name.length} characters). Maximum is 64 characters.`;
    }
  }

  const descRaw = topLevel.get("description").rawValue;
  if (descRaw === null) return "Description must be a string, got object";
  const description = unquoteScalar(descRaw);
  if (description) {
    if (description.includes("<") || description.includes(">")) {
      return "Description cannot contain angle brackets (< or >)";
    }
    if (description.length > 1024) {
      return `Description is too long (${description.length} characters). Maximum is 1024 characters.`;
    }
  }

  if (topLevel.has("compatibility")) {
    const compatRaw = topLevel.get("compatibility").rawValue;
    if (compatRaw !== null) {
      const compatibility = unquoteScalar(compatRaw);
      if (compatibility.length > 500) {
        return `Compatibility is too long (${compatibility.length} characters). Maximum is 500 characters.`;
      }
    }
  }

  return null;
}

export function scan() {
  const findings = [];
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
    if (FIXTURE_PATH_RE.test(rel)) continue;
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
