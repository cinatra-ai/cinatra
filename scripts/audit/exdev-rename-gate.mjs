#!/usr/bin/env node
// CI gate: no NEW bare fs.rename / renameSync on the extension
// install / materialize / publish / store / boot surfaces (cinatra#874).
//
// WHY. `rename(2)` throws EXDEV when the source and destination are on
// DIFFERENT mounted filesystems. A staged tree under `os.tmpdir()` promoted to a
// persistent `data`/`/data` mount with a bare `rename` crash-loops install/boot
// whenever those land on different mounts (cinatra#158, #846, #873). The fix is
// always the same: route the promote through a shared EXDEV-safe move that falls
// back to copy → fsync → verify → atomic intra-fs swap → drop-source on EXDEV:
//   - app layer:  src/lib/fs-safety.ts            `atomicReplaceDir`
//   - agents pkg: packages/agents/src/exdev-safe-move.ts  `moveDirExdevSafe`
//   - skills pkg: packages/skills/src/exdev-safe-move.ts  `moveDirExdevSafe`
// Those primitives take the rename via an injectable seam (`doRename`) so they
// never present a bare `rename(` on the surface — a call that routes through
// them is invisible to this gate, and a bare `rename(` on the surface is not.
//
// SHAPE. The same no-new-rot baseline ratchet the repo uses elsewhere
// (skill-canonicality-gate, extension-import-ban): a committed baseline records
// the CURRENT tolerated bare-rename sites (same-parent intra-fs backups/swaps and
// legacy install/relocate carve-outs that predate the primitives); CI fails on
// any current finding NOT in the baseline. Static analysis cannot prove a given
// rename is same-filesystem, so the ratchet tolerates the enumerated knowns and
// forces every NEW surface rename to either route through a primitive (finding
// vanishes) or be justified in review and added to the baseline. Monotonic
// EXDEV_RENAME_BASE guard: the committed baseline may only SHRINK vs the base
// branch — drive a site to zero by routing it through a primitive.
//
// Usage:
//   node scripts/audit/exdev-rename-gate.mjs                  # CI check (exit 1 on NEW finding)
//   node scripts/audit/exdev-rename-gate.mjs --write-baseline # regenerate the baseline
//   node scripts/audit/exdev-rename-gate.mjs --strict         # also fail on stale baseline entries

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BASELINE_PATH = join(__dirname, "exdev-rename-gate.baseline.json");

const SCAN_DIRS = ["src", "packages"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".cts", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "__tests__",
  "__mocks__",
  "tests",
]);
const SKIP_FILE_PATTERNS = [/\.test\.[mc]?[tj]sx?$/, /\.spec\.[mc]?[tj]sx?$/, /\.d\.ts$/];

// The extension install / materialize / publish / store / boot surface. A bare
// rename outside these prefixes (e.g. an unrelated artifact blob store or a
// workflow-title mutation) is out of scope for THIS gate.
const SURFACE_RULES = [
  /^packages\/skills\/src\//,
  /^packages\/agents\/src\//,
  /^packages\/registries\/src\//,
  /^packages\/cli\/src\//,
  /^src\/lib\/boot\//,
  /^src\/lib\/extension-/,
  /^src\/lib\/extensions\//,
  /^src\/lib\/required-extension-/,
];

// The sanctioned EXDEV-safe primitive modules: a raw `rename` here IS the
// primitive (behind the injectable seam), so these files are never scanned. New
// call sites must route through them, not add their own bare rename.
const SANCTIONED_HELPERS = new Set([
  "src/lib/fs-safety.ts",
  "packages/agents/src/exdev-safe-move.ts",
  "packages/skills/src/exdev-safe-move.ts",
]);

// `\brename(` matches a bare `rename(` / `renameSync(` / `fs.rename(` call. The
// `\b` boundary does NOT match the primitives' `doRename(` seam (the char before
// `rename` is `o`, a word char), so a routed call never trips the gate.
const RENAME_RE = /\brename(?:Sync)?\s*\(/;

const RULE = "bare-rename";

function isSurfaceFile(rel) {
  if (SANCTIONED_HELPERS.has(rel)) return false;
  return SURFACE_RULES.some((re) => re.test(rel));
}

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
      if (!SCAN_EXTENSIONS.has(entry.slice(idx))) continue;
      const rel = relative(REPO_ROOT, full).split("\\").join("/");
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
      if (!isSurfaceFile(rel)) continue;
      let text;
      try {
        text = readFileSync(join(REPO_ROOT, rel), "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        // Drop a trailing line comment so a `// … rename( …` note is not a
        // finding; a full-line comment leaves an empty code part.
        const codePart = lines[i].split("//")[0];
        const trimmed = codePart.trim();
        if (!trimmed || trimmed.startsWith("*")) continue;
        if (RENAME_RE.test(codePart)) {
          findings.push({ file: rel, rule: RULE, line: i + 1, src: lines[i].trim() });
        }
      }
    }
  }
  return findings;
}

// Findings are keyed by `${file}::${rule}::${normalized-src}` so a re-flow across
// line numbers doesn't break the baseline (structural identity, not line number).
function fingerprintFinding(f) {
  const normalized = f.src.replace(/\s+/g, " ").trim();
  return `${f.file}::${f.rule}::${normalized}`;
}

// MULTISET counts, not a Set: the baseline tolerates N occurrences of a given
// fingerprint, so an (N+1)th identical bare rename in the same file is a NEW
// finding. A plain Set would collapse duplicates and let it slip through.
function countByFingerprint(findings) {
  const counts = new Map();
  for (const f of findings) {
    const fp = fingerprintFinding(f);
    counts.set(fp, (counts.get(fp) ?? 0) + 1);
  }
  return counts;
}

function loadBaselineFindings() {
  if (!existsSync(BASELINE_PATH)) return [];
  const data = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  return Array.isArray(data.findings) ? data.findings : [];
}

/**
 * Multiset diff: the current findings whose per-fingerprint occurrence count
 * EXCEEDS the baseline's. The first `baselineCount` occurrences of each
 * fingerprint are tolerated; every occurrence beyond that is returned as NEW.
 */
function computeNewFindings(current, baselineFindings) {
  const allowed = countByFingerprint(baselineFindings);
  const seen = new Map();
  const novel = [];
  for (const f of current) {
    const fp = fingerprintFinding(f);
    const used = seen.get(fp) ?? 0;
    if (used >= (allowed.get(fp) ?? 0)) novel.push(f);
    seen.set(fp, used + 1);
  }
  return novel;
}

function writeBaseline(findings) {
  const sorted = [...findings].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });
  const data = {
    note:
      "No-new-rot baseline for the exdev-rename-gate (cinatra#874). Each entry is " +
      "a CURRENT tolerated bare rename/renameSync on the extension install/" +
      "materialize/publish/store/boot surface. Regenerate with `node scripts/" +
      "audit/exdev-rename-gate.mjs --write-baseline`; it should only ever SHRINK " +
      "as sites route through the shared EXDEV-safe move primitives " +
      "(fs-safety.ts atomicReplaceDir / exdev-safe-move.ts moveDirExdevSafe).",
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
    console.log(`[exdev-rename-gate] baseline written (${findings.length} findings).`);
    return;
  }

  const baselineFindings = loadBaselineFindings();
  // Multiset diffs (occurrence-count aware, so a duplicate of an already-
  // baselined line still counts as new): current-beyond-baseline = NEW;
  // baseline-beyond-current = STALE.
  const newFindings = computeNewFindings(findings, baselineFindings);
  const stale = computeNewFindings(baselineFindings, findings);

  // Monotonic ratchet: the committed baseline must be a SUBSET (multiset) of the
  // base-branch baseline — it may only shrink. Prevents a diff that adds a
  // finding AND regenerates the baseline in one PR from bypassing the ratchet.
  const baseRef = process.env.EXDEV_RENAME_BASE;
  if (baseRef) {
    let baseBaselineFindings = null;
    try {
      const baseData = JSON.parse(
        execFileSync("git", ["show", `${baseRef}:scripts/audit/exdev-rename-gate.baseline.json`], {
          encoding: "utf8",
        }),
      );
      baseBaselineFindings = Array.isArray(baseData.findings) ? baseData.findings : [];
    } catch {
      baseBaselineFindings = null; // base ref lacks the file → introducing PR; no constraint.
    }
    if (baseBaselineFindings) {
      const grew = computeNewFindings(baselineFindings, baseBaselineFindings);
      if (grew.length > 0) {
        console.error(
          `[exdev-rename-gate] BASELINE GREW vs ${baseRef}. The committed baseline ` +
            `must be a SUBSET of the base-branch baseline (it may only shrink as ` +
            `sites route through the EXDEV-safe move primitives).`,
        );
        for (const f of grew) console.error(`  + ${f.file}: ${f.src}`);
        process.exit(1);
      }
    }
  }

  if (newFindings.length > 0) {
    console.error(
      `[exdev-rename-gate] ${newFindings.length} NEW bare rename/renameSync on the ` +
        `extension install/materialize/store/boot surface:`,
    );
    for (const f of newFindings) console.error(`  ${f.file}:${f.line}  ${f.src}`);
    console.error(
      `\nRoute the promote through a shared EXDEV-safe move instead of a bare rename:\n` +
        `  - app (src/): import { atomicReplaceDir } from "@/lib/fs-safety"\n` +
        `  - packages/agents: import { moveDirExdevSafe } from "./exdev-safe-move"\n` +
        `  - packages/skills: import { moveDirExdevSafe } from "./exdev-safe-move"\n` +
        `If the rename is provably same-filesystem (same parent dir) and cannot ` +
        `throw EXDEV, justify it in review then regenerate the baseline:\n` +
        `  node scripts/audit/exdev-rename-gate.mjs --write-baseline`,
    );
    process.exit(1);
  }

  if (strict && stale.length > 0) {
    console.error(
      `[exdev-rename-gate] --strict: ${stale.length} stale baseline entry/entries ` +
        `(no longer present). Regenerate to shrink it:\n` +
        `  node scripts/audit/exdev-rename-gate.mjs --write-baseline`,
    );
    for (const f of stale) console.error(`  - ${f.file}: ${f.src}`);
    process.exit(1);
  }

  console.log(
    `[exdev-rename-gate] OK (${findings.length} tolerated finding(s); 0 new).` +
      (stale.length > 0 ? `  ${stale.length} stale entry/entries (run --strict to enforce).` : ""),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

export {
  scan,
  fingerprintFinding,
  countByFingerprint,
  loadBaselineFindings,
  computeNewFindings,
  writeBaseline,
  isSurfaceFile,
};
