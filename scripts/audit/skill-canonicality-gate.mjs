#!/usr/bin/env node
// CI gate: no NEW canonical writes to the legacy `data/skills`
// tree, no NEW direct trust of `skill.sourcePath` as physical-content truth.
//
// The new canonical store is `data/skill-store`, with reads routed
// through the SkillSource resolver / readSkillContent. A one-shot
// migration moved existing data; this gate locks the new boundary so the next
// contributor doesn't accidentally re-canonicalize `data/skills` or bypass the
// resolver.
//
// Shape: the same no-new-rot touch-ratchet the repo uses elsewhere
// (extension-import-ban, administration-route-gate).
// A committed baseline records the CURRENT tolerated findings — the legacy
// install/relocate carve-outs in github.ts + verdaccio.ts
// + relocate-worker.ts + the legacy-fallback delete in skills-store.ts.
// CI fails on any current finding NOT in the baseline.
//
// Rule 1 — legacy `data/skills` canonical writes:
//   In files that import `getSkillsDataRootPath` from the skills package,
//   write-API call sites (mkdir / writeFile / cp / rename / createWriteStream)
//   are findings unless the file is in the carve-out allowlist (which IS
//   the baseline — new files writing into the legacy root must be added
//   explicitly + justified in review).
//
// Rule 2 — sourcePath read-without-resolver:
//   Direct `readFile(skill.sourcePath)` / `readFileSync(skill.sourcePath)`
//   call sites bypass `assertSkillFilePathInsideRoot`. The cutover
//   routes the MCP handler + Anthropic sync through the validated helpers;
//   this gate prevents reintroducing the same containment-bypass class.
//
// Usage:
//   node scripts/audit/skill-canonicality-gate.mjs                 # CI check (exit 1 on NEW finding)
//   node scripts/audit/skill-canonicality-gate.mjs --write-baseline # regenerate the baseline
//   node scripts/audit/skill-canonicality-gate.mjs --strict         # also fail on stale baseline entries

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BASELINE_PATH = join(__dirname, "skill-canonicality-gate.baseline.json");

// Scan these directories only. Avoid node_modules / dist / .next / planning docs.
const SCAN_DIRS = ["packages", "src"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs", ".js"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "__tests__",
  "tests",
  "migrations",
]);

// Files that test / mock / regenerate baselines.
const SKIP_FILE_PATTERNS = [
  /\.test\.[mc]?[tj]sx?$/,
  /\.spec\.[mc]?[tj]sx?$/,
  /\.d\.ts$/,
  /\/scripts\/audit\/.*\.mjs$/,
];

// Rule 1: write-API patterns. Each is a regex matched on the source line.
const WRITE_API_PATTERNS = [
  /\bmkdir(?:Sync)?\s*\(/,
  /\bwriteFile(?:Sync)?\s*\(/,
  /\bappendFile(?:Sync)?\s*\(/,
  /\bcreateWriteStream\s*\(/,
  /\bcp(?:Sync)?\s*\(/,
  /\brename(?:Sync)?\s*\(/,
];

// Rule 2: sourcePath read-without-resolver patterns.
const SOURCEPATH_DIRECT_READ_PATTERNS = [
  /\breadFile(?:Sync)?\s*\(\s*(?:skill|row|entry|s)\.sourcePath\b/,
  /\breadFile(?:Sync)?\s*\(\s*sourcePath\b/,
];

// A Rule-2 line is GUARDED (not a finding) when an
// `assertSkillFilePathInsideRoot(...)` call appears in the same file within
// GUARD_WINDOW_LINES preceding the read — that's the in-function pattern the
// Anthropic sync uploader uses and that future callers must follow.
// 60 lines covers the real-world case (Anthropic guard + several other
// fail-closed lstat/regular-file checks between the guard and the readFile).
const GUARD_WINDOW_LINES = 60;
const GUARD_PATTERN = /\bassertSkillFilePathInsideRoot\s*\(/;

function* walkSource(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkSource(full);
    } else {
      const idx = entry.lastIndexOf(".");
      if (idx < 0) continue;
      const ext = entry.slice(idx);
      if (!SCAN_EXTENSIONS.has(ext)) continue;
      const rel = relative(REPO_ROOT, full);
      if (SKIP_FILE_PATTERNS.some((p) => p.test(rel))) continue;
      yield rel;
    }
  }
}

function scan() {
  const findings = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const rel of walkSource(abs)) {
      let text;
      try {
        text = readFileSync(join(REPO_ROOT, rel), "utf8");
      } catch {
        continue;
      }
      const usesSkillsDataRoot =
        /getSkillsDataRootPath\b/.test(text) ||
        /['"]data\/skills(?:\/|['"])/.test(text);

      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        // Skip comments + empty lines (cheap heuristic).
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

        // Rule 1: write-API in a file that consults the skills data root.
        if (usesSkillsDataRoot) {
          for (const pat of WRITE_API_PATTERNS) {
            if (pat.test(line)) {
              findings.push({ file: rel, rule: "data-skills-write", line: i + 1, src: line.trim() });
              break;
            }
          }
        }

        // Rule 2: direct sourcePath read — but ONLY when not preceded by an
        // assertSkillFilePathInsideRoot guard within GUARD_WINDOW_LINES (the
        // Anthropic sync uploader's in-function guard pattern).
        for (const pat of SOURCEPATH_DIRECT_READ_PATTERNS) {
          if (pat.test(line)) {
            const guardStart = Math.max(0, i - GUARD_WINDOW_LINES);
            const guarded = lines
              .slice(guardStart, i)
              .some((prior) => GUARD_PATTERN.test(prior));
            if (!guarded) {
              findings.push({ file: rel, rule: "sourcepath-direct-read", line: i + 1, src: line.trim() });
            }
            break;
          }
        }
      }
    }
  }
  return findings;
}

// Findings are keyed by `${file}::${rule}::${normalized-src}` so a re-flow
// across line numbers doesn't break the baseline (matches the audit
// convention: structural identity, not line numbers).
function fingerprintFinding(f) {
  const normalized = f.src.replace(/\s+/g, " ").trim();
  return `${f.file}::${f.rule}::${normalized}`;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const raw = readFileSync(BASELINE_PATH, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.findings)) return new Set();
  return new Set(data.findings.map(fingerprintFinding));
}

function writeBaseline(findings) {
  const sorted = [...findings].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.rule !== b.rule) return a.rule.localeCompare(b.rule);
    return a.line - b.line;
  });
  const data = {
    note:
      "No-new-rot baseline. Each entry is a CURRENT tolerated " +
      "finding. Regenerate with `node scripts/audit/skill-canonicality-gate.mjs " +
      "--write-baseline` (it should only ever SHRINK as legacy install / " +
      "relocate / fallback paths migrate to the new content store).",
    findings: sorted.map((f) => ({ file: f.file, rule: f.rule, line: f.line, src: f.src })),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write-baseline");
  const strict = args.includes("--strict");

  const findings = scan();

  if (write) {
    writeBaseline(findings);
    console.log(
      `[skill-canonicality-gate] baseline written (${findings.length} findings).`,
    );
    return;
  }

  const baseline = loadBaseline();
  const currentFingerprints = new Set(findings.map(fingerprintFinding));

  // NEW findings: present now, not in baseline.
  const newFindings = findings.filter((f) => !baseline.has(fingerprintFinding(f)));

  // STALE entries: in baseline, not present now.
  const stale = [...baseline].filter((fp) => !currentFingerprints.has(fp));

  // Monotonic ratchet: the committed baseline must be a
  // SUBSET of the base-branch baseline — it may only shrink. Without this, a
  // change could add a finding AND regenerate the baseline in the same diff
  // (bypassing the ratchet). Matches extension-import-ban's IMPORT_BAN_BASE.
  // Absent base ref (introducing change) → no constraint.
  const baseRef = process.env.SKILL_CANONICALITY_BASE;
  if (baseRef) {
    let baseBaselineSet;
    try {
      const baseRaw = execFileSync(
        "git",
        ["show", `${baseRef}:scripts/audit/skill-canonicality-gate.baseline.json`],
        { encoding: "utf8" },
      );
      const baseData = JSON.parse(baseRaw);
      baseBaselineSet = new Set(
        Array.isArray(baseData.findings)
          ? baseData.findings.map(fingerprintFinding)
          : [],
      );
    } catch {
      // Base ref doesn't have the file → introducing PR; no constraint.
      baseBaselineSet = null;
    }
    if (baseBaselineSet) {
      const grew = [...baseline].filter((fp) => !baseBaselineSet.has(fp));
      if (grew.length > 0) {
        console.error(
          `[skill-canonicality-gate] BASELINE GREW vs ${baseRef}. The ` +
            `committed baseline must be a SUBSET of the base-branch baseline ` +
            `(it may only shrink as legacy carve-outs migrate to the new store).`,
        );
        for (const fp of grew) console.error(`  + ${fp}`);
        process.exit(1);
      }
    }
  }

  if (newFindings.length > 0) {
    console.error(
      `[skill-canonicality-gate] ${newFindings.length} NEW finding(s) — a new ` +
        `canonical write to the legacy data/skills tree OR a new direct ` +
        `skill.sourcePath read without the resolver was introduced.`,
    );
    for (const f of newFindings) {
      console.error(`  ${f.file}:${f.line} [${f.rule}]  ${f.src}`);
    }
    console.error(
      `\nIf this is genuinely a new legacy carve-out (e.g. a deferred-extraction ` +
        `install path), justify it in PR review then regenerate the baseline:\n` +
        `  node scripts/audit/skill-canonicality-gate.mjs --write-baseline\n` +
        `Otherwise, route the write through the new content store (getSkillStoreRootPath) ` +
        `OR the read through readSkillContent / readSkillFileContent / assertSkillFilePathInsideRoot.`,
    );
    process.exit(1);
  }

  if (strict && stale.length > 0) {
    console.error(
      `[skill-canonicality-gate] --strict: ${stale.length} stale baseline ` +
        `entry/entries (no longer present in source). Regenerate the baseline ` +
        `to shrink it:\n  node scripts/audit/skill-canonicality-gate.mjs --write-baseline`,
    );
    for (const fp of stale) console.error(`  - ${fp}`);
    process.exit(1);
  }

  console.log(
    `[skill-canonicality-gate] OK (${findings.length} tolerated finding(s); ` +
      `0 new).` + (stale.length > 0 ? `  ${stale.length} stale entry/entries (run --strict to enforce).` : ""),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

export { scan, fingerprintFinding, loadBaseline, writeBaseline };
