#!/usr/bin/env node
"use strict";

// Setup-integrity checker.
//
// A bare `docker build … <in-tree-path>` (or `COPY <path>` / `source <path>`)
// against a path that no longer exists in the tree, under `set -euo pipefail`,
// hard-fails `make setup` for every fresh clone — a regression that has only
// ever been caught by hand. This checker generalizes that class into a permanent
// gate: for each setup-family shell script it
//   1. runs `shellcheck` when the binary is available — standard lints (its
//      default-severity findings / a nonzero exit) FAIL the gate. When the
//      binary is ABSENT the step is skipped gracefully (it never fails the gate
//      just because shellcheck isn't installed), and
//   2. statically scans for in-tree path references in `docker build … <path>`,
//      `COPY <path>`, and `source <path>` / `. <path>` forms, asserting each
//      referenced in-tree path EXISTS or is wrapped in an enclosing existence
//      guard (`if [ -f … ]` / `if [ -d … ]` / `[ -e … ]` / a for-loop glob
//      existence check).
//
// A referenced path is considered statically safe when it is:
//   - a variable / command-substitution expansion (`"$ctx"`, `$(…)`) — dynamic,
//     resolved at run time (this form populates the context only from a
//     `for dockerfile in …/Dockerfile; do if [ -f "$dockerfile" ]` loop), or
//   - not in-tree-looking (a URL, a registry image ref, an absolute path), or
//   - an existing in-tree path, or
//   - governed by an enclosing existence guard.
//
// A BARE literal in-tree path that does not exist and is not guarded is a
// violation.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Setup-family script discovery
// ---------------------------------------------------------------------------

/**
 * A setup-family script is one whose name or contents mark it as a setup entry:
 *  - scripts/setup.sh (the canonical installer)
 *  - any scripts/*.sh whose filename contains "setup", OR whose body is invoked
 *    by a Makefile `setup` target.
 */
export function listSetupScripts(repoRoot = DEFAULT_REPO_ROOT) {
  const scriptsDir = join(repoRoot, "scripts");
  const found = new Set();

  if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
    for (const name of readdirSync(scriptsDir)) {
      if (!name.endsWith(".sh")) continue;
      const abs = join(scriptsDir, name);
      if (/setup/i.test(name)) {
        found.add(abs);
        continue;
      }
      // Otherwise include only if the body reads like a setup script.
      let body = "";
      try {
        body = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (/\b(setup:dev|setup:prod|cinatra setup|Local Setup|first-time setup)\b/i.test(body)) {
        found.add(abs);
      }
    }
  }

  // Makefile `setup`-family targets that shell out to a `*.sh` script.
  const makefile = join(repoRoot, "Makefile");
  if (existsSync(makefile)) {
    let mk = "";
    try {
      mk = readFileSync(makefile, "utf8");
    } catch {
      mk = "";
    }
    const re = /\b(bash|sh)\s+(scripts\/[\w./-]+\.sh)/g;
    let m;
    while ((m = re.exec(mk)) !== null) {
      const abs = join(repoRoot, m[2]);
      if (existsSync(abs)) found.add(abs);
    }
  }

  return [...found].sort();
}

// ---------------------------------------------------------------------------
// shellcheck (gate-backing when present, graceful skip when absent)
// ---------------------------------------------------------------------------

/**
 * Run shellcheck against a script. Returns `{ ran, lints, status }`. NEVER
 * throws and NEVER hard-fails when the binary is absent — the caller records
 * `ran:false` with a note instead. When the binary IS present, shellcheck's
 * standard lints (its default-severity findings, surfaced as a nonzero exit)
 * become gate failures in the caller.
 */
export function runShellcheck(scriptPath, { shellcheckBin = "shellcheck" } = {}) {
  let probe;
  try {
    probe = spawnSync(shellcheckBin, ["--version"], { encoding: "utf8" });
  } catch {
    probe = { error: new Error("spawn failed") };
  }
  if (!probe || probe.error || typeof probe.status !== "number") {
    return { ran: false, lints: [], note: "shellcheck binary not available — skipped" };
  }
  const res = spawnSync(shellcheckBin, ["--format=gcc", scriptPath], { encoding: "utf8" });
  const lints = (res.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // A nonzero exit signals shellcheck reported standard lints (default
  // severity). Treat that — or any parsed lint line — as a finding.
  const failed = res.status !== 0 || lints.length > 0;
  return { ran: true, lints, status: res.status, failed };
}

// ---------------------------------------------------------------------------
// Static path-reference scan
// ---------------------------------------------------------------------------

/** True when a token is a variable / command-substitution expansion. */
function isDynamicToken(tok) {
  return /\$\{?\w/.test(tok) || /\$\(/.test(tok) || /`/.test(tok);
}

/** True when a token looks like a URL or a registry / docker image ref, not an in-tree path. */
function isExternalToken(tok) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) return true; // scheme://…
  if (/^[\w.-]+(:\d+)?\/[\w./-]+:[\w.-]+$/.test(tok)) return true; // registry/host:port/img:tag
  return false;
}

/**
 * True when the token looks like an in-tree, repo-relative filesystem path.
 * We are deliberately conservative: only treat tokens that clearly name a
 * repo-relative path (contain a `/` and a path-ish head, or a `.`-rooted path).
 */
function looksInTree(tok) {
  if (!tok) return false;
  if (isDynamicToken(tok)) return false;
  if (isExternalToken(tok)) return false;
  if (isAbsolute(tok)) return false;
  if (tok.startsWith("-")) return false; // a flag, not a path
  if (/^[\w-]+=[^/]*$/.test(tok)) return false; // KEY=value, not a path
  // A relative path: `./x`, `../x`, or `a/b/c` (has a slash), or a `.`-rooted file.
  if (tok.startsWith("./") || tok.startsWith("../")) return true;
  if (tok.includes("/")) return true;
  return false;
}

/** Strip a leading/trailing matched quote pair from a token. */
function unquote(tok) {
  if (tok.length >= 2) {
    const a = tok[0];
    const b = tok[tok.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return tok.slice(1, -1);
  }
  return tok;
}

/** Tokenize a single command line, honoring simple single/double quoting. */
function tokenize(line) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(m[2]);
    else tokens.push(unquote(m[3]));
  }
  return tokens;
}

/**
 * Extract the build-context positional from a `docker build` command's tokens.
 * The context is the LAST non-flag positional, skipping flags and their values.
 * Returns the raw token (still possibly quoted-stripped) or null.
 */
function dockerBuildContext(tokens) {
  // tokens[0..]=docker, build, … — find index of "build".
  let i = tokens.findIndex((t) => t === "build");
  if (i < 0) return null;
  const positionals = [];
  for (let k = i + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.startsWith("-")) {
      // Flags that take a separate value argument.
      const takesValue = /^(-t|--tag|-f|--file|--build-arg|--target|--platform|--cache-from|--cache-to|--output|-o|--secret|--ssh|--add-host|--label|--network)$/.test(
        t,
      );
      if (takesValue && !t.includes("=")) k++; // skip the value token
      continue;
    }
    positionals.push(t);
  }
  if (positionals.length === 0) return null;
  return positionals[positionals.length - 1];
}

// Tokens that mark an existence-test guard head (`[ -f … ]`, `[[ -d … ]]`,
// `test -e …`) and a `for VAR in …` loop head.
const EXISTENCE_GUARD_RE = /\b(?:if\s+)?(?:test\s+|\[\[?\s*)-[fde]\b|\bfor\s+\w+\s+in\b/;
// Block openers / closers, matched at the start of a (trimmed) statement.
const BLOCK_OPENER_RE = /^(?:if|for|while|until)\b/;
const BLOCK_CLOSER_RE = /^(?:fi|done|esac)\b/;

/**
 * Collect the path-ish tokens a guard line constrains so we can require that an
 * enclosing guard actually references the SAME path (or its `$var` /
 * `$(dirname …)` derivation) — an UNRELATED literal guard must not count.
 *
 * Returns a Set containing:
 *   - any in-tree-looking literal path the guard tests (`[ -d pkg/x ]`),
 *   - any bare variable name the guard binds or tests (`for f in …` → `f`,
 *     `[ -n "$ctx" ]` → `ctx`), so a later `docker build "$ctx"` /
 *     `"$(dirname "$f")"` reference matches.
 */
function guardReferencedTokens(line) {
  const refs = new Set();
  // Literal path operands of an existence test: `[ -f pkg/x ]`, `test -d a/b`.
  const litRe = /(?:\[\[?|\btest)\s+-[fde]\s+("[^"]+"|'[^']+'|\S+)/g;
  let m;
  while ((m = litRe.exec(line)) !== null) {
    const tok = unquote(m[1]);
    if (looksInTree(tok)) refs.add(tok);
    for (const v of varNames(tok)) refs.add(v);
  }
  // `for VAR in …` binds VAR.
  const forRe = /\bfor\s+(\w+)\s+in\b/g;
  while ((m = forRe.exec(line)) !== null) refs.add(m[1]);
  // Any `$VAR` / `${VAR}` the guard references (e.g. `[ -n "$ctx" ]`).
  for (const v of varNames(line)) refs.add(v);
  return refs;
}

/** Extract bare variable names from a token / line (`$ctx`, `${ctx}` → `ctx`). */
function varNames(s) {
  const names = [];
  const re = /\$\{?(\w+)\}?/g;
  let m;
  while ((m = re.exec(s)) !== null) names.push(m[1]);
  return names;
}

/** The variable names a reference token depends on (`"$ctx"`, `"$(dirname "$f")"`). */
function referenceVarNames(rawTok) {
  return new Set(varNames(rawTok || ""));
}

/**
 * Detect whether a path reference on `lineIndex` (its raw token `rawTok`) is
 * genuinely governed by an ENCLOSING existence guard that constrains THAT path.
 *
 * Correctness over the prior heuristic:
 *   - Walk UPWARD tracking block depth so a guard sitting in an already-CLOSED
 *     sibling block (its `fi`/`done`/`esac` appears between it and the
 *     reference) does NOT count — we only honor a guard that still encloses the
 *     reference line.
 *   - Require the guard to reference the SAME path token or one of the variables
 *     the reference derives from (`$ctx`, `$(dirname "$f")`), so an UNRELATED
 *     literal guard above the reference is not mistaken for protection.
 *   - Stop at a function boundary (`}`) — a guard above that does not enclose us.
 */
function hasEnclosingGuard(lines, lineIndex, rawTok) {
  const refVars = referenceVarNames(rawTok);
  const refLiteral = unquote(rawTok || "");

  const matchesReference = (guardLine) => {
    const refs = guardReferencedTokens(guardLine);
    if (refLiteral && refs.has(refLiteral)) return true;
    for (const v of refVars) if (refs.has(v)) return true;
    return false;
  };

  // Same-line guard (`[ -f X ] && docker build … X`): honor only when it
  // constrains this very reference.
  if (EXISTENCE_GUARD_RE.test(lines[lineIndex]) && matchesReference(lines[lineIndex])) {
    return true;
  }

  // Walk back over the enclosing block. `depth` counts CLOSED sibling blocks we
  // have stepped over going upward: a closer entered from below raises it, the
  // matching opener lowers it. Only an opener seen at depth 0 still encloses the
  // reference line.
  let depth = 0;
  for (let k = lineIndex - 1; k >= 0 && lineIndex - k <= 25; k--) {
    const l = lines[k].trim();
    if (l === "" || l.startsWith("#")) continue;

    // A function boundary above can never enclose this reference.
    if (/^\}\s*$/.test(l)) break;

    // A single-line `if …; then …; fi` opens and closes on one line: net-zero,
    // a sibling, never enclosing — skip without touching depth.
    const opensHere = BLOCK_OPENER_RE.test(l);
    const closesHere = BLOCK_CLOSER_RE.test(l) || /\b(?:fi|done|esac)\s*$/.test(l);
    if (opensHere && closesHere) continue;

    if (BLOCK_CLOSER_RE.test(l)) {
      depth++; // entered (from below) a block closed before the reference
      continue;
    }
    if (BLOCK_OPENER_RE.test(l)) {
      if (depth > 0) {
        depth--; // closes one of the already-stepped-over sibling blocks
        continue;
      }
      // depth === 0 → this opener still encloses the reference line.
      if (EXISTENCE_GUARD_RE.test(l) && matchesReference(l)) return true;
      // An enclosing opener that is NOT a matching existence guard provides no
      // protection; keep scanning further-out enclosers.
      continue;
    }
  }
  return false;
}

/**
 * Scan a setup-script's text for in-tree path references that are bare (no
 * existence guard) and missing on disk. Returns a list of violation objects.
 *
 * @param {string} text       the script body
 * @param {object} opts
 * @param {string} opts.scriptPath  absolute path of the script (for reporting)
 * @param {string} opts.repoRoot    repo root that in-tree paths resolve against
 */
export function scanScriptForMissingPaths(text, { scriptPath = "<script>", repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const lines = text.split("\n");
  const violations = [];

  const consider = (kind, rawTok, lineIndex) => {
    if (!rawTok) return;
    const tok = unquote(rawTok);
    if (!looksInTree(tok)) return; // dynamic / external / non-path — safe
    const abs = join(repoRoot, tok);
    if (existsSync(abs)) return; // present in-tree — safe
    if (hasEnclosingGuard(lines, lineIndex, rawTok)) return; // guarded — safe
    violations.push({
      script: scriptPath,
      line: lineIndex + 1,
      kind,
      path: tok,
      text: lines[lineIndex].trim(),
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.replace(/^\s+/, "");
    if (stripped.startsWith("#")) continue; // comment line

    const tokens = tokenize(raw);

    // docker build … <context>
    if (/\bdocker\s+build\b/.test(raw)) {
      const ctx = dockerBuildContext(tokens);
      consider("docker-build", ctx, i);
    }

    // COPY <src> [<src> …] <dst> (Dockerfile form; harmless if present in a heredoc)
    if (/^\s*COPY\b/.test(raw)) {
      const srcs = tokens.slice(1, -1).filter((t) => !t.startsWith("--"));
      for (const s of srcs) consider("copy", s, i);
    }

    // source <path> / . <path>
    const srcMatch = raw.match(/(?:^|\s|;|&&|\|\|)(?:source|\.)\s+("[^"]+"|'[^']+'|\S+)/);
    if (srcMatch && /(?:^|\s|;|&&|\|\|)(?:source|\.)\s/.test(raw)) {
      // Only treat as a `source` when the token before the path is the `source`
      // builtin or a standalone `.` (not `./binary` invocation or a `..`).
      const before = raw.slice(0, srcMatch.index + srcMatch[0].indexOf(srcMatch[1])).trim();
      if (/(?:^|\s|;|&&|\|\|)(?:source|\.)$/.test(before)) {
        consider("source", srcMatch[1], i);
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Top-level checker
// ---------------------------------------------------------------------------

/**
 * Check one or more setup-family scripts. Returns a structured result:
 *   {
 *     ok: boolean,
 *     violations: [...],            // bare missing in-tree path refs (hard)
 *     shellcheckViolations: [...],  // shellcheck standard lints (hard, when run)
 *     scripts: [{ script, violations, shellcheck }],
 *   }
 *
 * When shellcheck is available it runs against every script and its standard
 * lints fail the gate alongside the missing-path violations. When the binary is
 * absent the step is skipped gracefully and never affects `ok`.
 */
export function checkSetupIntegrity({
  repoRoot = DEFAULT_REPO_ROOT,
  scripts,
  runShellcheck: doShellcheck = true,
} = {}) {
  const targets = scripts && scripts.length ? scripts : listSetupScripts(repoRoot);
  const perScript = [];
  const allViolations = [];
  const shellcheckViolations = [];

  for (const scriptPath of targets) {
    let text = "";
    try {
      text = readFileSync(scriptPath, "utf8");
    } catch (err) {
      const v = { script: scriptPath, line: 0, kind: "unreadable", path: scriptPath, text: String(err && err.message) };
      allViolations.push(v);
      perScript.push({ script: scriptPath, violations: [v], shellcheck: { ran: false, lints: [], note: "unreadable" } });
      continue;
    }
    const violations = scanScriptForMissingPaths(text, { scriptPath, repoRoot });
    const shellcheck = doShellcheck ? runShellcheck(scriptPath) : { ran: false, lints: [], note: "shellcheck disabled" };
    allViolations.push(...violations);
    // shellcheck failures count only when the binary actually ran — an absent
    // binary degrades gracefully (`ran:false`) and never fails the gate.
    if (shellcheck.ran && shellcheck.failed) {
      shellcheckViolations.push({ script: scriptPath, status: shellcheck.status, lints: shellcheck.lints });
    }
    perScript.push({ script: scriptPath, violations, shellcheck });
  }

  return {
    ok: allViolations.length === 0 && shellcheckViolations.length === 0,
    violations: allViolations,
    shellcheckViolations,
    scripts: perScript,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function main() {
  const result = checkSetupIntegrity();

  for (const s of result.scripts) {
    const rel = s.script.startsWith(DEFAULT_REPO_ROOT) ? s.script.slice(DEFAULT_REPO_ROOT.length + 1) : s.script;
    if (s.shellcheck.ran) {
      if (s.shellcheck.lints.length || s.shellcheck.failed) {
        console.log(`[setup-integrity] shellcheck on ${rel}: ${s.shellcheck.lints.length} lint(s) — gate FAIL`);
        for (const l of s.shellcheck.lints) console.log("    " + l);
      } else {
        console.log(`[setup-integrity] shellcheck on ${rel}: clean`);
      }
    } else {
      console.log(`[setup-integrity] shellcheck on ${rel}: ${s.shellcheck.note}`);
    }
  }

  if (result.ok) {
    console.log(
      `[setup-integrity] PASS — no bare missing in-tree path references and no shellcheck lints in ${result.scripts.length} setup script(s).`,
    );
    return 0;
  }

  if (result.violations.length) {
    console.error(`[setup-integrity] FAIL — ${result.violations.length} bare missing in-tree path reference(s):\n`);
    for (const v of result.violations) {
      const rel = v.script.startsWith(DEFAULT_REPO_ROOT) ? v.script.slice(DEFAULT_REPO_ROOT.length + 1) : v.script;
      console.error(`  ${rel}:${v.line} [${v.kind}] missing in-tree path: ${v.path}`);
      console.error(`      ${v.text}`);
    }
    console.error(
      "\nGuard the reference with `if [ -f … ]` / `if [ -d … ]` / a for-loop existence check,\n" +
        "or repoint it at a path that exists in the tree.",
    );
  }

  if (result.shellcheckViolations.length) {
    console.error(`[setup-integrity] FAIL — shellcheck reported standard lints in ${result.shellcheckViolations.length} setup script(s):\n`);
    for (const sv of result.shellcheckViolations) {
      const rel = sv.script.startsWith(DEFAULT_REPO_ROOT) ? sv.script.slice(DEFAULT_REPO_ROOT.length + 1) : sv.script;
      console.error(`  ${rel}: shellcheck exit ${sv.status}, ${sv.lints.length} lint(s)`);
      for (const l of sv.lints) console.error("    " + l);
    }
    console.error("\nFix the shellcheck findings (or add an inline `# shellcheck disable=…` with a justification).");
  }

  return 1;
}

// Run only when invoked directly (not when imported by the test file).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
