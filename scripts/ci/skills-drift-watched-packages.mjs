#!/usr/bin/env node
// Derive the SKILL-LINKED pin set for the rolling dev-lock bump (cinatra#2986
// gap 2) from `skills-drift-gate`'s OWN data — never from a parallel list.
//
// WHAT "SKILL-LINKED" MEANS HERE
// ------------------------------
// `skills-drift-gate` (the reusable cinatra-ai/ci gate; caller:
// `.github/workflows/skills-drift-gate.yml`) flags a PR when its diff touches a
// surface a pinned SKILL.md DECLARES it depends on, in a `cinatra-watches`
// frontmatter block. One of those declared classes is `packages:` — exact
// `@cinatra-ai/<slug>` package names. A dev-lock bump re-pins companion
// packages, so the bump's diff carries those package names; a bumped package
// that some pinned SKILL.md declares under `packages:` is what this script
// calls SKILL-LINKED.
//
// TWO SOURCES OF TRUTH, BOTH THE GATE'S OWN
// -----------------------------------------
//  1. WHICH skill repos, at WHICH commit — read out of the gate caller's own
//     `skills_repos:` input in `.github/workflows/skills-drift-gate.yml`. That
//     input IS the pinned skills universe the gate scans; reading it here means
//     this script cannot drift from the gate, and a re-pin there moves both at
//     once. Never hardcode a repo list.
//  2. WHICH packages a skill watches — the `cinatra-watches` block in each
//     pinned SKILL.md, in the gate's own frontmatter grammar (dual-read:
//     `metadata.cinatra-watches` preferred, legacy top-level as fallback; a
//     `packages:` key as a flow array or a block sequence).
//
// The grammar below MIRRORS the pinned engine's `parseWatches`
// (cinatra-ai/ci `scripts/skills-drift-gate.mjs`). It is re-implemented rather
// than imported ON PURPOSE: the auto-bump job carries the push/PR token, and
// its TOKEN BOUNDARY forbids executing any code that is not a host-repo script
// (see the workflow header). This script only READS remote SKILL.md text — the
// same posture as the lock updater reading companion manifests. When the gate
// caller's `ref`/`uses:` pin moves, re-check this grammar against that commit.
//
// FAILURE DIRECTION, ON PURPOSE
// -----------------------------
// This script only decides whether the bump PR's body ASKS a person for a
// judgment (and what fingerprint that judgment is paired with). It can never
// make `skills-drift-gate` pass — the gate reads the body itself and stays the
// only authority. So:
//   - under-reporting costs a red gate a person then resolves by hand (today's
//     behaviour, no regression);
//   - over-reporting costs a needless ask;
//   - and anything this script cannot parse is FATAL (exit 1), because a
//     silently-empty watch set would read as "nothing to judge".
//
// Usage:
//   node scripts/ci/skills-drift-watched-packages.mjs \
//     --changed-pins /tmp/pin-changes.json --out /tmp/skill-linked.json
//
//   --changed-pins  JSON array of { packageName, resolvedSha } this bump re-pins
//                   (omit to report the full watched-package union instead)
//   --out           where to write the report (default: stdout)
//   --skills-dir    read already-materialized skill repos from disk instead of
//                   fetching (used by the tests; layout <dir>/<owner>__<name>/)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

/** The gate caller whose pins are read. Exported so callers/tests need no literal. */
export const GATE_CALLER = ".github/workflows/skills-drift-gate.yml";
const WATCH_KEYS = ["primitives", "packages", "routes", "paths"];

export class SkillsWatchError extends Error {}

// --------------------------------------------------------------------------
// 1. the gate caller's own pins
// --------------------------------------------------------------------------

/**
 * Read the `skills_repos:` block-scalar out of the gate caller's YAML and parse
 * it into pinned entries. FAIL-LOUD on an absent input or a non-40-hex pin: the
 * gate itself refuses a moving default branch, and so must this.
 *
 * @param {string} yamlText contents of .github/workflows/skills-drift-gate.yml
 * @returns {Array<{owner: string, name: string, sha: string}>}
 */
export function parseGateSkillsRepos(yamlText) {
  const lines = String(yamlText ?? "").split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^\s*skills_repos:\s*[|>][-+]?\s*$/.test(l));
  if (startIdx === -1) {
    throw new SkillsWatchError(
      `${GATE_CALLER}: no \`skills_repos:\` block scalar found — the skills-drift gate caller must pin the skills universe there (single-repo \`skills_ref\` mode is not supported by this derivation).`,
    );
  }
  const keyIndent = lines[startIdx].length - lines[startIdx].replace(/^\s+/, "").length;
  const entries = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.length - line.replace(/^\s+/, "").length;
    if (indent <= keyIndent) break;
    const token = line.trim();
    if (token.startsWith("#")) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)@([0-9a-f]{40})$/.exec(token);
    if (!m) {
      throw new SkillsWatchError(
        `${GATE_CALLER}: unparseable \`skills_repos\` entry ${JSON.stringify(token)} — expected \`owner/name@<40-hex sha>\` (a branch pin is refused: the gate reads a pinned snapshot, never a moving ref).`,
      );
    }
    entries.push({ owner: m[1], name: m[2], sha: m[3] });
  }
  if (entries.length === 0) {
    throw new SkillsWatchError(`${GATE_CALLER}: \`skills_repos\` is present but empty — refusing a vacuous watch set.`);
  }
  return entries;
}

// --------------------------------------------------------------------------
// 2. the gate's `cinatra-watches` grammar (mirrors the pinned engine)
// --------------------------------------------------------------------------

function extractFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  return m ? m[1] : null;
}

function isBlankOrComment(line) {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

function unquoteScalar(raw, key, label) {
  const s = raw.trim();
  const bad = () =>
    new SkillsWatchError(`${label}: cinatra-watches \`${key}\` has a malformed list item: ${JSON.stringify(raw)}`);
  if (s === "") throw bad();
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    const m = new RegExp(`^${q}((?:[^${q}\\\\]|\\\\.)*)${q}\\s*(?:#.*)?$`).exec(s);
    if (!m) throw bad();
    return m[1].replace(/\\(["'\\])/g, "$1");
  }
  let v = s;
  const hash = v.indexOf(" #");
  if (hash !== -1) v = v.slice(0, hash).trim();
  if (v === "") throw bad();
  if (/[[\]{}]/.test(v) || /^[A-Za-z0-9_.@/*?-]+:\s/.test(v) || /:\s*$/.test(v)) throw bad();
  return v;
}

/** Locate `cinatra-watches:` — `metadata.` preferred, legacy top-level fallback. */
function locateWatchesBlock(lines, label) {
  const inlineError = () =>
    new SkillsWatchError(`${label}: \`cinatra-watches:\` must be a mapping (a block of indented keys), not an inline value`);
  let metadataHit = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^metadata:\s*(#.*)?$/.test(lines[i])) continue;
    let childIndent = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (isBlankOrComment(line)) continue;
      const indent = line.length - line.replace(/^\s+/, "").length;
      if (indent === 0) break;
      if (childIndent === null) childIndent = indent;
      if (indent !== childIndent) continue;
      const m = /^(\s+)cinatra-watches:\s*(.*)$/.exec(line);
      if (m) {
        const trimmed = m[2].trim();
        const value = trimmed.startsWith("#") ? "" : trimmed.split(" #")[0].trim();
        if (value !== "") throw inlineError();
        metadataHit = { keyIdx: j, keyIndent: m[1].length };
        break;
      }
    }
    break;
  }
  let legacyHit = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^cinatra-watches:\s*(#.*)?$/.test(lines[i])) {
      legacyHit = { keyIdx: i, keyIndent: 0 };
      break;
    }
    if (/^cinatra-watches:\s*\S/.test(lines[i])) throw inlineError();
  }
  if (metadataHit && legacyHit) {
    throw new SkillsWatchError(`${label}: \`cinatra-watches:\` is declared in BOTH \`metadata.cinatra-watches\` and a legacy top-level key — keep exactly one`);
  }
  return metadataHit ?? legacyHit;
}

/**
 * Parse a SKILL.md's `cinatra-watches` block.
 * @returns {null | {primitives: string[], packages: string[], routes: string[], paths: string[]}}
 */
export function parseWatches(text, { skillLabel = "SKILL.md" } = {}) {
  const fm = extractFrontmatter(text);
  if (fm == null) return null;
  const lines = fm.split(/\r?\n/);
  const located = locateWatchesBlock(lines, skillLabel);
  if (located == null) return null;
  const baseIndent = located.keyIndent;
  const watches = { primitives: [], packages: [], routes: [], paths: [] };
  const seen = new Set();
  let seenAny = false;
  let i = located.keyIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const indent = line.length - line.replace(/^\s+/, "").length;
    if (indent <= baseIndent) break;
    if (isBlankOrComment(line)) {
      i += 1;
      continue;
    }
    const keyMatch = /^(\s+)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!keyMatch) throw new SkillsWatchError(`${skillLabel}: cannot parse \`cinatra-watches\` line: ${JSON.stringify(line)}`);
    const key = keyMatch[2];
    const inline = keyMatch[3];
    if (!WATCH_KEYS.includes(key)) {
      throw new SkillsWatchError(`${skillLabel}: unknown cinatra-watches key \`${key}\` (allowed: ${WATCH_KEYS.join(", ")})`);
    }
    if (seen.has(key)) throw new SkillsWatchError(`${skillLabel}: cinatra-watches \`${key}\` declared more than once`);
    seen.add(key);
    seenAny = true;
    let values;
    if (inline !== "") {
      const fa = /^\[(.*)\]$/.exec(inline.trim());
      if (!fa) throw new SkillsWatchError(`${skillLabel}: cinatra-watches \`${key}\` must be a list, got: ${JSON.stringify(inline)}`);
      values = fa[1].trim() === "" ? [] : fa[1].split(",").map((s) => unquoteScalar(s, key, skillLabel));
      i += 1;
    } else {
      values = [];
      i += 1;
      const itemIndent = keyMatch[1].length;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") {
          i += 1;
          continue;
        }
        const im = /^(\s+)-\s+(.*)$/.exec(l);
        if (!im || im[1].length <= itemIndent) break;
        values.push(unquoteScalar(im[2], key, skillLabel));
        i += 1;
      }
    }
    if (values.length === 0) {
      throw new SkillsWatchError(`${skillLabel}: cinatra-watches \`${key}\` is present but empty — an empty watch class is a silent false-negative`);
    }
    for (const v of values) {
      if (v === "") throw new SkillsWatchError(`${skillLabel}: cinatra-watches \`${key}\` has an empty list item`);
      watches[key].push(v);
    }
  }
  if (!seenAny) throw new SkillsWatchError(`${skillLabel}: \`cinatra-watches:\` has no recognized keys (allowed: ${WATCH_KEYS.join(", ")})`);
  return watches;
}

/**
 * Union the declared watch surfaces over a set of SKILL.md documents.
 *
 * `watchedPackages` is the `packages:` class — the class that decides which of
 * the bump's pins are skill-linked. `surfaces` is EVERY declared surface across
 * all four classes, as `<cls>:<surface>@<skill>` strings: it goes into the
 * acknowledgement fingerprint, so a re-pin of the skills universe that changes
 * what any skill watches drops a block written against the old declarations.
 *
 * @param {Array<{label: string, text: string}>} docs
 */
export function collectWatchedPackages(docs) {
  const byPackage = new Map();
  const surfaces = new Set();
  let declared = 0;
  for (const doc of docs) {
    const watches = parseWatches(doc.text, { skillLabel: doc.label });
    if (!watches) continue;
    if (WATCH_KEYS.some((k) => watches[k].length > 0)) declared += 1;
    for (const cls of WATCH_KEYS) {
      for (const surface of watches[cls]) surfaces.add(`${cls}:${surface}@${doc.label}`);
    }
    for (const pkg of watches.packages) {
      if (!byPackage.has(pkg)) byPackage.set(pkg, []);
      byPackage.get(pkg).push(doc.label);
    }
  }
  const watchedPackages = [...byPackage.keys()].sort();
  return {
    watchedPackages,
    byPackage: Object.fromEntries(watchedPackages.map((p) => [p, byPackage.get(p).sort()])),
    surfaces: [...surfaces].sort(),
    scanned: docs.length,
    declared,
  };
}

/**
 * Restrict the bump's changed pins to the watched-package set.
 *
 * A DE-LISTED package is part of the change too: the gate sees its name in the
 * diff and can flag it, so the caller passes it with the sentinel sha
 * `(removed)` and it lands in the set like any other entry. Dropping a watched
 * package therefore moves the fingerprint instead of leaving a stale block in
 * place.
 *
 * @param {Array<{packageName: string, resolvedSha: string}>} changedPins
 * @param {string[]} watchedPackages
 */
export function skillLinkedPins(changedPins, watchedPackages) {
  const watched = new Set(watchedPackages);
  return (changedPins ?? [])
    .filter((p) => watched.has(p.packageName))
    .map((p) => ({ packageName: p.packageName, resolvedSha: p.resolvedSha }))
    .sort((a, b) => a.packageName.localeCompare(b.packageName));
}

// --------------------------------------------------------------------------
// 3. IO: materialize the pinned skill repos and read their SKILL.md files
// --------------------------------------------------------------------------

function* walkSkillFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) yield* walkSkillFiles(full);
    else if (entry === "SKILL.md") yield full;
  }
}

/**
 * Fetch ONE pinned skill repo at exactly its sha. Blob-filtered, depth 1 — the
 * repos are small doc repos and only their SKILL.md frontmatter is read. No
 * repo code is executed, and no credential is required (the skill repos are
 * public, like the companion extension repos the same job already clones).
 */
function materializeRepo(entry, into) {
  const dir = join(into, `${entry.owner}__${entry.name}`);
  const url = `https://github.com/${entry.owner}/${entry.name}.git`;
  const git = (...args) => execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  git("init", "-q", dir);
  git("-C", dir, "remote", "add", "origin", url);
  git("-C", dir, "fetch", "-q", "--depth", "1", "--no-tags", "--filter=blob:none", "origin", entry.sha);
  git("-C", dir, "checkout", "-q", "--detach", "FETCH_HEAD");
  return dir;
}

/** Read every SKILL.md under a materialized repo dir, labelled `owner/name@sha:relpath`. */
function readSkillDocs(dir, label) {
  const docs = [];
  for (const file of walkSkillFiles(dir)) {
    docs.push({ label: `${label}:${file.slice(dir.length + 1)}`, text: readFileSync(file, "utf8") });
  }
  return docs;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const entries = parseGateSkillsRepos(readFileSync(resolve(repoRoot, GATE_CALLER), "utf8"));

  let docs = [];
  let tmp = null;
  try {
    if (args["skills-dir"]) {
      for (const entry of entries) {
        const dir = join(resolve(args["skills-dir"]), `${entry.owner}__${entry.name}`);
        docs = docs.concat(readSkillDocs(dir, `${entry.owner}/${entry.name}@${entry.sha.slice(0, 12)}`));
      }
    } else {
      tmp = mkdtempSync(join(tmpdir(), "cinatra-skills-"));
      for (const entry of entries) {
        const dir = materializeRepo(entry, tmp);
        docs = docs.concat(readSkillDocs(dir, `${entry.owner}/${entry.name}@${entry.sha.slice(0, 12)}`));
      }
    }
    if (docs.length === 0) {
      throw new SkillsWatchError(
        `no SKILL.md found across the ${entries.length} pinned skills repo(s) — refusing a vacuous watch set (a materialization failure must never read as "nothing to judge").`,
      );
    }
    const collected = collectWatchedPackages(docs);
    let changedPins = null;
    if (args["changed-pins"]) changedPins = JSON.parse(readFileSync(args["changed-pins"], "utf8"));
    const pins = entries.map((e) => `${e.owner}/${e.name}@${e.sha}`);
    const report = {
      pins,
      skillFilesScanned: collected.scanned,
      skillsWithDeclaredWatches: collected.declared,
      watchedPackages: collected.watchedPackages,
      watchedBy: collected.byPackage,
      skillLinked: changedPins ? skillLinkedPins(changedPins, collected.watchedPackages) : null,
      // The fingerprint half that pins WHICH universe the judgment was made
      // against, so a skills re-pin that changes any declaration drops the block.
      universe: { pins, surfaces: collected.surfaces },
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.out) writeFileSync(args.out, json);
    else process.stdout.write(json);
    console.error(
      `[skills-drift-watched-packages] ${collected.scanned} SKILL.md across ${entries.length} pinned repo(s); ` +
        `${collected.watchedPackages.length} watched package(s); ` +
        `${report.skillLinked ? report.skillLinked.length : "n/a"} skill-linked in this bump.`,
    );
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith("skills-drift-watched-packages.mjs")) {
  try {
    main();
  } catch (err) {
    console.error(`[skills-drift-watched-packages] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
