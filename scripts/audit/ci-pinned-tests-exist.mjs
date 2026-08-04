#!/usr/bin/env node
// CI guard, two directions over the SAME run-block parser:
//
//   1. PIN → FILE. Every test file explicitly pinned in a workflow
//      `vitest run` / `node --test` invocation MUST exist on disk.
//   2. AUDIT SUITE → RUNNER. Every `scripts/audit/__tests__` suite MUST be
//      executed by something: either the root Vitest include (`pnpm test:root`,
//      the wholesale gate of record) or an explicit workflow runner pin.
//
// Why (1) exists: `vitest run a.test.ts b.test.ts` treats positionals as
// FILTERS. If one positional matches zero files, vitest SILENTLY ignores it as
// long as the others match — the step still passes. So a pinned test that was
// renamed/lost (e.g. dropped in a rebase) leaves its pin behind and CI stays
// green while advertising coverage it no longer has. This guard is the
// secondary tripwire that turns that silent gap into a hard failure.
//
// Why (2) exists: the audit gates are the repo's structural invariants, and
// their fixture suites are what prove each gate still CATCHES what it claims to
// catch. A gate suite that no runner executes is a gate nobody knows works —
// the gate can drift from the source it mirrors and CI stays green. The
// carve-out mechanism is what makes this silent: a suite written for
// `node --test` must be listed in the root vitest.config.ts `test.exclude`
// (vitest reports "No test suite found" otherwise), and that exclusion is a
// one-line edit that removes the suite from the wholesale run. If the matching
// `node --test` step is never added — or is later deleted — the suite runs
// NOWHERE and nothing says so. Direction (2) makes that combination fail
// closed: excluded-from-root AND unpinned-in-CI is a hard error, and a
// literal-path exclusion naming a file that no longer exists is reported as
// stale config rather than left to rot.
//
// (2) deliberately lives HERE rather than in a standalone vitest suite: this
// module runs as a direct `node scripts/audit/ci-pinned-tests-exist.mjs` CLI
// step AND its tests are pinned by path in the same required job, so the check
// survives the very failure mode it guards against — narrowing or deleting the
// root include glob cannot silence it.
//
// Approach (decompose, don't fully parse a shell): extract each workflow `run:`
// block, split it into `&&`/newline segments, and for any segment that invokes a
// test runner collect its positional `*.test.{ts,tsx,mjs,mts,js}` tokens. The
// invocation cwd is resolved from step-level `working-directory:`, in-script
// `cd <dir>`, and `pnpm --filter <pkg>` (mapped to the package dir); a token is
// satisfied when a tracked test path is BOTH under that cwd AND a path-suffix of
// the token (vitest filters by path substring). With no resolvable cwd it falls
// back to a plain path-suffix match. Glob tokens (containing `*`) and
// `--exclude/--reporter/--config/--project` values are skipped.
//
// Residuals it intentionally does NOT model (documented, not silent) — these
// degrade to the still-sound path-suffix fallback, never a false POSITIVE:
// job-level `defaults.run.working-directory`, `--filter` by glob/path (non-name),
// variable-indirection paths, dynamically-built filenames, and indirectly
// launched runners. Rare, and out of scope for an existence check.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, posix } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

const SKIP_AFTER_FLAGS = new Set(["--exclude", "--reporter", "--config", "--project"]);

// Launcher words a runner may legitimately sit behind. Anything NOT in this set
// terminates the walk: `echo`, `printf`, a script name, etc. never reach a
// runner no matter what text follows them.
// `cd` is deliberately NOT here: it never launches the command that follows it
// (`cd . node --test x` is a `cd` with two arguments, not a test run), and
// crediting it would let a `|| true`-guarded line advertise coverage it does
// not have. A real `cd <dir> && <runner>` is already split on `&&` into its own
// segment before this walk, with the cwd carried across.
const RUNNER_LAUNCHERS = new Set([
  "pnpm", "pnpx", "npx", "npm", "yarn", "corepack", "exec", "env", "command", "nice", "time",
  "timeout", "cross-env", "dotenv",
]);
// Flags whose VALUE is a separate following token; that value is an argument to
// the launcher, not a command word, so it must not terminate the walk.
const LAUNCHER_VALUE_FLAGS = new Set(["--filter", "-F", "-C", "--dir", "--workspace-root", "--kill-after"]);
// Vitest flags whose value is a SEPARATE following token. Anything else that is
// not a flag is a positional operand — i.e. a filter that narrows the run.
const VITEST_VALUE_FLAGS = new Set([
  "config", "c", "project", "reporter", "outputFile", "exclude", "environment", "shard",
  "pool", "maxWorkers", "minWorkers", "testTimeout", "hookTimeout", "root", "dir", "mode", "testNamePattern", "t",
]);
// The ONLY flags a wholesale root run may carry. This is an ALLOWLIST, not a
// denylist of narrowing flags, because vitest keeps adding options that run
// fewer tests — or none at all (`--clearCache`, `--mergeReports`, `--listTags`)
// — and a denylist silently accepts each new one. An unknown flag fails closed:
// the fix is to classify it here.
const VITEST_WHOLESALE_SAFE_FLAGS = new Set([
  "config", "c", "coverage", "no-coverage", "reporter", "outputFile", "silent", "no-color", "color",
  "pool", "maxWorkers", "minWorkers", "no-file-parallelism", "fileParallelism",
  "testTimeout", "hookTimeout", "environment", "mode", "logHeapUsage", "passWithNoTests", "no-watch", "watch",
]);
// `--config`/`-c` is the one allowlisted flag whose VALUE is load-bearing: it
// must name the root config or the run is a different suite entirely.
const VITEST_CONFIG_FLAGS = new Set(["config", "c"]);
// Flags whose value is a separate following token (subset of the allowlist).
const VITEST_SAFE_VALUE_FLAGS = new Set([
  "config", "c", "reporter", "outputFile", "pool", "maxWorkers", "minWorkers",
  "testTimeout", "hookTimeout", "environment", "mode",
]);
// node:test flags that make `node --test <file>` run fewer tests than the file
// contains — possibly none. A pin carrying one of these does not prove the
// suite executed.
const NODE_NARROWING_FLAGS = new Set([
  "--test-shard", "--test-only", "--test-name-pattern", "--test-skip-pattern",
  // Node 24: reruns only the tests that have not already passed.
  "--test-rerun-failures",
]);

// Does this shell segment actually INVOKE a test runner, in command position?
//
// A substring test is not enough: `echo "node --test x.test.mjs"` and a
// commented-out `# node --test x.test.mjs` both contain the runner phrase and
// execute nothing. Counting either as coverage would make this guard fail OPEN
// in the exact way it exists to prevent. So walk the segment's tokens from the
// left, stepping over env assignments, known launcher words and their flag
// values, and report a runner only when one is genuinely reached as the command.
export function reachesRunner(seg) {
  return runnerArgv(seg)?.runner ?? null;
}

// Split a script body into ordered command segments.
//
// Comments are stripped PER LINE BEFORE the command separators are applied, and
// that order is load-bearing: splitting first lets a commented-out separator
// resurrect the text behind it — `echo ok # && node --test dark.test.mjs`
// becomes a segment `node --test dark.test.mjs` that GitHub never runs.
// `&&`, `;`, `||` and a single `|` all end a command; the pipe matters because
// `node --test real.test.mjs | echo dark.test.mjs` runs `echo`, not a runner.
export function splitShellSegments(body) {
  const segments = [];
  let buf = "";
  let quote = null;
  let prevSep = "";
  let prevSeg = "";
  const flush = (sep) => {
    // `true || X` and `false && X` never run X. Both are statically decidable
    // and both appear in the wild as "keep this line but disable it", so a
    // credited runner behind either would be coverage that does not exist.
    const shortCircuited =
      (prevSep === "||" && prevSeg.trim() === "true") || (prevSep === "&&" && prevSeg.trim() === "false");
    segments.push(shortCircuited ? "" : buf);
    // A short-circuited segment cannot itself gate what follows it, and the
    // dead branch stays dead through a `||`/`&&` chain, so carry the marker.
    prevSeg = shortCircuited ? prevSeg : buf;
    buf = "";
    prevSep = shortCircuited && sep !== "\n" && sep !== ";" ? prevSep : sep;
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      buf += c;
      if (c === "\\") buf += body[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      // An unquoted backslash escapes the NEXT character, so `echo safe \; cmd`
      // echoes a literal `;` and runs nothing after it. Consuming the escaped
      // char here keeps an escaped separator from splitting the command.
      buf += c + (body[++i] ?? "");
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    // A heredoc body is DATA, not commands: `cat <<EOF … node --test x … EOF`
    // runs `cat`. Skip every heredoc opened on this line, in order, applying the
    // real terminator rules — `<<EOF` needs the delimiter at column ZERO, and
    // `<<-EOF` strips leading TABS only (not spaces). Getting that wrong lets a
    // fake terminator end the body early and expose its commands.
    if (body.slice(i, i + 2) === "<<") {
      const nl = body.indexOf("\n", i);
      const lineTail = nl === -1 ? body.slice(i) : body.slice(i, nl);
      const opens = [...lineTail.matchAll(/<<(-?)\s*(["']?)([A-Za-z_][\w-]*)\2/g)].map((m) => ({
        dash: m[1] === "-",
        delim: m[3],
      }));
      if (opens.length > 0) {
        let pos = nl === -1 ? body.length : nl + 1;
        for (const { dash, delim } of opens) {
          const endRe = new RegExp(`^${dash ? "\\t*" : ""}${delim}[ \\t]*$`, "m");
          const rest = body.slice(pos);
          const end = rest.match(endRe);
          pos = end ? pos + end.index + end[0].length : body.length;
        }
        i = pos;
        flush("\n");
        continue;
      }
    }
    // A `#` starting a word begins a comment that runs to end of line — and it
    // is stripped BEFORE separators are applied. Splitting first lets a
    // commented-out separator resurrect its tail: `echo ok # && node --test x`.
    if (c === "#" && (buf === "" || /[\s;&|(]$/.test(buf))) {
      while (i < body.length && body[i] !== "\n") i++;
      flush("\n");
      continue;
    }
    if (c === "\n") {
      flush("\n");
      continue;
    }
    if (c === ";") {
      flush(";");
      continue;
    }
    if (c === "&" && body[i + 1] === "&") {
      flush("&&");
      i++;
      continue;
    }
    if (c === "|" && body[i + 1] === "|") {
      flush("||");
      i++;
      continue;
    }
    if (c === "|") {
      flush("|");
      continue;
    }
    buf += c;
  }
  flush("");
  return segments;
}

// Strip an unquoted trailing `# …` shell comment. Without this, a pin named in
// a comment ON a real runner line (`node --test real.test.mjs # dark.test.mjs`)
// is credited as executed.
export function stripShellComment(seg) {
  let quote = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(seg[i - 1]))) return seg.slice(0, i);
  }
  return seg;
}

// The runner and its ARGV for a segment that genuinely invokes one, else null.
// Returning the argv (not the raw segment) is what keeps a pre-runner env
// assignment — `TARGET=…/dark.test.mjs node --test real.test.mjs` — from being
// read as a pinned path: only tokens the runner actually receives count.
export function runnerArgv(seg) {
  const trimmed = stripShellComment(seg).trim();
  if (!trimmed || trimmed.startsWith("#")) return null; // shell comment line
  const toks = trimmed.split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = i > 0 ? toks[i - 1] : "";
    if (LAUNCHER_VALUE_FLAGS.has(prev)) continue; // this token is that flag's value
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // FOO=bar env assignment
    if (t.startsWith("-")) continue; // a launcher flag
    if (/^\d+(?:\.\d+)?[smhd]?$/.test(t)) continue; // a duration/number (`timeout … 780 …`) — never a command name
    if (t === "node" && toks[i + 1] === "--test") {
      // `node --test --test-shard=2/2 <file>` exits 0 having run ZERO tests, so
      // the pin proves the file EXISTS but not that its suite executed.
      const narrowed = toks.some((tok) => NODE_NARROWING_FLAGS.has(tok.split("=")[0]));
      return { runner: "node", argv: argvUntilRedirect(toks.slice(i + 2)), narrowed };
    }
    if ((t === "vitest" || t.endsWith("/vitest")) && toks[i + 1] === "run") {
      return { runner: "vitest", argv: argvUntilRedirect(toks.slice(i + 2)) };
    }
    if (RUNNER_LAUNCHERS.has(t)) continue;
    return null; // an unrecognized command word — this segment runs something else
  }
  return null;
}

// Cut argv at the first redirection. A redirection TARGET is a file the shell
// writes, not a test the runner reads: `node --test real.test.mjs > dark.test.mjs`
// runs one test and truncates another file. Crediting the target as executed
// would be exactly backwards.
export function argvUntilRedirect(argv) {
  const stop = argv.findIndex((t) => /^\d*[<>]/.test(t) || t === "&>" || t === "&");
  return stop === -1 ? argv : argv.slice(0, stop);
}

// Does this segment invoke the WHOLESALE root Vitest suite (`pnpm test:root`)?
// The audit suites that ride the root include are executed by that one step and
// nothing else, so its existence is part of the coverage claim.
export function invokesRootSuite(seg, script = ROOT_SUITE_SCRIPT) {
  const trimmed = stripShellComment(seg).trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  const toks = trimmed.split(/\s+/).filter(Boolean);
  let pm = false; // a package-manager launcher was reached
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = i > 0 ? toks[i - 1] : "";
    // A package-scoped or filtered invocation is a DIFFERENT package's script,
    // not the repo-root wholesale run.
    if (LAUNCHER_VALUE_FLAGS.has(prev)) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    if (t.startsWith("--filter") || t.startsWith("-F") || t.startsWith("-C") || t.startsWith("--dir")) return false;
    if (t.startsWith("-")) continue;
    if (/^\d+(?:\.\d+)?[smhd]?$/.test(t)) continue;
    // The script name only counts as an invocation when a package manager is
    // running it — `command -v test:root` and `pnpm exec test:root` are not the
    // root suite. `exec` runs a BINARY, so it disqualifies too.
    // Forwarded arguments narrow the run (`pnpm test:root -- scripts/audit`,
    // `-- --dir packages/objects`), so the script name must be the LAST token.
    if (t === script) return pm && i === toks.length - 1;
    if (t === "run" && toks[i + 1] === script) continue;
    if (t === "pnpm" || t === "npm" || t === "yarn" || t === "pnpx" || t === "corepack") {
      pm = true;
      continue;
    }
    if (t === "exec" || t === "npx" || t === "command") return false;
    if (RUNNER_LAUNCHERS.has(t)) continue;
    return false;
  }
  return false;
}

// …and the script it names must still BE the wholesale root run. Rewriting
// `"test:root": "true"` would otherwise leave every root-only audit suite dark
// behind a green gate.
export function rootSuiteScriptRunsVitest(repoRoot = REPO_ROOT, script = ROOT_SUITE_SCRIPT) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  } catch {
    return false;
  }
  const cmd = pkg?.scripts?.[script];
  if (typeof cmd !== "string") return false;
  // Command position, via the same walk the workflow parser uses: `echo vitest
  // run` must not count.
  const invocation = runnerArgv(cmd);
  if (invocation?.runner !== "vitest") return false;
  // …and the invocation must be WHOLESALE: the root config (explicitly or by
  // default) and not a single positional operand, because every positional
  // narrows the run to a filter and leaves the rest of the include dark.
  for (let i = 0; i < invocation.argv.length; i++) {
    const t = invocation.argv[i].replace(/^["']|["']$/g, "");
    if (!t.startsWith("-")) return false; // a positional operand narrows the run
    // `--flag=value` and the short `-c=value` form both carry their value inline.
    const eq = t.match(/^-{1,2}([\w.-]+)=(.*)$/);
    const name = eq ? eq[1] : t.replace(/^-+/, "");
    if (!VITEST_WHOLESALE_SAFE_FLAGS.has(name)) return false; // unknown ⇒ fail closed
    const inlineValue = eq ? eq[2].replace(/^["']|["']$/g, "") : null;
    if (VITEST_CONFIG_FLAGS.has(name)) {
      const value = inlineValue ?? (invocation.argv[i + 1] ?? "").replace(/^["']|["']$/g, "");
      if (value !== ROOT_VITEST_CONFIG) return false;
    }
    if (inlineValue === null && VITEST_SAFE_VALUE_FLAGS.has(name)) i++; // consume the value
  }
  return true;
}

// Extract every `run:` script body from a workflow YAML. Handles inline
// `run: cmd`, list-item `- run: cmd`, and block scalars `run: |` (literal —
// newlines are command separators) / `run: >-` (folded — newlines are spaces,
// so a single `vitest run` spans continuation lines). Returns
// { body, fold: "inline"|"folded"|"literal", startLine }.
export function extractRunBlocks(yamlText) {
  const lines = yamlText.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(- )?run:\s?(.*)$/);
    if (!m) continue;
    // keyIndent = the column of the `run` KEY (2 past the `- ` marker when the
    // run line carries it); step keys all share this column.
    const keyIndent = m[1].length + (m[2] ? 2 : 0);
    // A step DISABLED with a literal-false `if:` never runs, so the runner it
    // holds proves nothing. Non-trivial `if:` expressions are NOT evaluated —
    // they depend on run context this gate cannot see — and are treated as
    // executing (documented residual, same class as the branch-protection
    // limitation on findRootSuiteInvocations).
    if (stepIsLiterallyDisabled(lines, i, keyIndent) || jobIsLiterallyDisabled(lines, i)) {
      continue;
    }
    const baseCwd = stepWorkingDirectory(lines, i, keyIndent);
    const inline = m[3];
    const scalar = inline.trim().match(/^([|>])[+-]?\d*\s*$/);
    if (inline.trim() && !scalar) {
      blocks.push({ body: inline, fold: "inline", baseCwd, startLine: i + 1 });
      continue;
    }
    const fold = scalar && scalar[1] === ">" ? "folded" : "literal";
    // Block scalar: collect following lines indented deeper than the key.
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const ln = lines[j];
      if (ln.trim() === "") { body.push(""); continue; }
      const indent = ln.length - ln.trimStart().length;
      if (indent <= keyIndent) break;
      body.push(ln);
    }
    blocks.push({ body: body.join("\n"), fold, baseCwd, startLine: i + 1 });
    i = j - 1;
  }
  return blocks;
}

// The line range of the step owning the `run:`/key at `runIdx`, bounded by its
// list marker at `keyIndent - 2` and the next sibling marker (or a dedent past
// it). Shared by the `working-directory:` and `if:` lookups so both read the
// same step.
export function stepBounds(lines, runIdx, keyIndent) {
  const markerIndent = keyIndent - 2;
  let start = 0;
  for (let k = runIdx; k >= 0; k--) {
    const ln = lines[k];
    if (ln.trim() === "") continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind === markerIndent && /^\s*- /.test(ln)) { start = k; break; }
    if (ind < markerIndent) { start = k + 1; break; }
  }
  let end = lines.length;
  for (let k = start + 1; k < lines.length; k++) {
    const ln = lines[k];
    if (ln.trim() === "") continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind <= markerIndent) { end = k; break; }
  }
  return { start, end };
}

// Is the step holding the `run:` at `runIdx` switched OFF by a literal-false
// `if:`? Only the unambiguous forms count — `if: false`, `if: ${{ false }}`,
// `if: 'false'`. Anything expression-shaped is left alone: this gate cannot
// evaluate run context, and guessing would either credit a skipped step or
// discredit a real one.
export function stepIsLiterallyDisabled(lines, runIdx, keyIndent) {
  const { start, end } = stepBounds(lines, runIdx, keyIndent);
  for (let k = start; k < end; k++) {
    const ln = lines[k];
    const m = ln.match(/^\s*(?:- )?if:\s*(.+?)\s*$/);
    if (!m) continue;
    const ind = ln.length - ln.trimStart().length;
    const keyCol = /^\s*- /.test(ln) ? ind + 2 : ind;
    if (keyCol !== keyIndent) continue;
    if (isLiterallyFalse(m[1])) return true;
  }
  return false;
}

// A job disabled with a literal-false `if:` takes every step with it. Jobs are
// mapping keys under `jobs:` at indent 2, so walk BACK from the run line to the
// nearest such key and read that job's own `if:` (indent 4).
export function jobIsLiterallyDisabled(lines, runIdx) {
  let jobStart = -1;
  for (let k = runIdx; k >= 0; k--) {
    const ln = lines[k];
    if (ln.trim() === "" || /^\s*#/.test(ln)) continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind === 2 && /^\s{2}[A-Za-z_][\w-]*:\s*$/.test(ln)) { jobStart = k; break; }
    if (ind === 0) return false; // left the jobs: mapping without finding one
  }
  if (jobStart === -1) return false;
  for (let k = jobStart + 1; k < lines.length; k++) {
    const ln = lines[k];
    if (ln.trim() === "") continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind <= 2) break; // next job
    if (ind !== 4) continue; // job-level keys only
    const m = ln.match(/^\s*if:\s*(.+?)\s*$/);
    if (m && isLiterallyFalse(m[1])) return true;
  }
  return false;
}

// `false`, `${{ false }}`, `'false'`, and any of those with a trailing YAML
// comment. Anything expression-shaped is NOT evaluated (documented residual).
export function isLiterallyFalse(raw) {
  const noComment = raw.replace(/\s#.*$/, "").trim();
  const expr = noComment.replace(/^["']|["']$/g, "").replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
  return expr === "false";
}

// Find a step-level `working-directory:` for the `run:` at `runIdx`. GitHub
// Actions runs the step's commands from that dir, so a pinned path is relative to
// it. The key can appear BEFORE or AFTER `run` and may be the step's first key
// (`- working-directory: …`), so scan the WHOLE step — bounded by its list
// marker at `keyIndent - 2` — for a `working-directory:` whose KEY column equals
// `keyIndent`. Returns "" (repo root) if none.
function stepWorkingDirectory(lines, runIdx, keyIndent) {
  const { start, end } = stepBounds(lines, runIdx, keyIndent);
  for (let k = start; k < end; k++) {
    const ln = lines[k];
    const wd = ln.match(/^\s*(?:- )?working-directory:\s*["']?([^"'\s]+)["']?\s*$/);
    if (!wd) continue;
    const ind = ln.length - ln.trimStart().length;
    const keyCol = /^\s*- /.test(ln) ? ind + 2 : ind; // `- working-directory:` → key sits 2 past the dash
    if (keyCol === keyIndent) return wd[1].replace(/^\.\//, "").replace(/\/$/, "");
  }
  return "";
}

// Map of workspace package name → repo-relative dir (from each tracked
// package.json `name`). Lets `pnpm --filter <name> exec vitest …` resolve to the
// package root the test path is relative to.
export function workspacePackageDirs(repoRoot = REPO_ROOT) {
  const res = spawnSync("git", ["ls-files", "package.json", "*/package.json", "**/package.json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const map = new Map();
  if (res.status === 0 && res.stdout) {
    for (const rel of res.stdout.split("\n")) {
      const r = rel.trim();
      if (!r) continue;
      try {
        const pkg = JSON.parse(readFileSync(join(repoRoot, r), "utf8"));
        if (pkg && typeof pkg.name === "string") {
          const dir = posix.dirname(r);
          map.set(pkg.name, dir === "." ? "" : dir);
        }
      } catch {
        /* unparseable package.json — skip */
      }
    }
  }
  return map;
}

// Given one run-block body, return the pinned test tokens with the cwd each was
// invoked under (relative to repo root; "" === repo root).
export function pinnedTestsInBlock(body, fold = "literal", baseCwd = "", pkgDirs = new Map()) {
  const out = [];
  // Shell line continuations (`\` at end of line) join with the next line in
  // BOTH fold types — e.g. `node --test \` then test files on following lines.
  // A folded (`>-`) block ADDITIONALLY turns every newline into a space, so the
  // whole `vitest run a b c` is one command. A literal (`|`) block otherwise
  // keeps newlines as real command separators.
  let normalized = body.replace(/\\[ \t]*\n/g, " ");
  if (fold === "folded") normalized = normalized.replace(/\n+/g, " ");
  const segments = splitShellSegments(normalized);
  let cwd = baseCwd; // step-level working-directory: is the starting cwd
  for (const rawSeg of segments) {
    const seg = rawSeg.trim();
    if (!seg) continue;
    const cdMatch = seg.match(/^cd\s+(\S+)/);
    if (cdMatch) {
      const dir = cdMatch[1];
      if (dir === "../.." || dir === "../../" || dir.startsWith("/")) cwd = "";
      else if (dir === "..") cwd = posix.dirname(cwd || ".") === "." ? "" : posix.dirname(cwd);
      else cwd = cwd ? posix.join(cwd, dir) : dir;
      // a `cd` segment may ALSO contain `&& vitest …` — but we split on `&&`,
      // so the runner is its own later segment. Continue to token scan anyway
      // in case a runner shares this segment without `&&`.
    }
    // `pnpm --filter <pkg> exec …` / `pnpm -F <pkg> …` runs in that package's
    // dir, and the test path is relative to it. This is a per-COMMAND flag (not a
    // persistent `cd`), so scope it to THIS segment only — a later unfiltered
    // runner in the same block must not inherit it. Unknown name (glob/path)
    // leaves the cwd → suffix fallback.
    let segCwd = cwd;
    const filterMatch = seg.match(/(?:--filter|-F)(?:=|\s+)(@?[A-Za-z0-9._/-]+)/);
    if (filterMatch && pkgDirs.has(filterMatch[1])) segCwd = pkgDirs.get(filterMatch[1]);
    const invocation = runnerArgv(seg);
    if (!invocation) continue;
    // Scan the runner's OWN argv, token by token — never the raw segment. Text
    // before the runner (env assignments, a wrapper's arguments) and text after
    // an unquoted `#` are not arguments, so a path appearing there is not a pin.
    for (let k = 0; k < invocation.argv.length; k++) {
      const raw = invocation.argv[k];
      const token = raw.replace(/^["']|["']$/g, "");
      if (!/^[\w@./-]+\.test\.(?:tsx|ts|mjs|mts|js)$/.test(token)) continue;
      if (token.includes("*")) continue; // glob filter, not a file
      const prev = k > 0 ? invocation.argv[k - 1].replace(/^["']|["']$/g, "") : "";
      if (SKIP_AFTER_FLAGS.has(prev)) continue; // space form: `--exclude x.test.ts`
      out.push({ token, cwd: segCwd, runner: invocation.runner, narrowed: invocation.narrowed === true });
    }
    // `=`-form skip flags (`--exclude=x.test.ts`) never reach the loop above:
    // the whole `--exclude=…` token fails the bare-path shape test.
  }
  return out;
}

// The full POSIX paths of every test file tracked in the repo. Used for
// path-SUFFIX resolution: vitest filters by path substring, and a pin invoked
// under GitHub Actions `working-directory:` or `pnpm --filter <pkg>` carries a
// path relative to that dir — i.e. a SUFFIX of the real repo-root-relative path.
// Suffix matching (not basename matching) keeps that sound: a pin
// `src/app/missing/route.test.ts` is NOT satisfied by an unrelated
// `src/other/route.test.ts`, so a genuine zero-match is still caught.
export function trackedTestPaths(repoRoot = REPO_ROOT) {
  const res = spawnSync("git", ["ls-files", "*.test.ts", "*.test.tsx", "*.test.mjs", "*.test.mts", "*.test.js"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const paths = [];
  if (res.status === 0 && res.stdout) {
    for (const line of res.stdout.split("\n")) {
      if (line.trim()) paths.push(line.trim());
    }
  }
  return paths;
}

// Scan all (or given) workflow files and resolve EVERY pinned runner token to
// the repo-relative test path(s) it actually selects.
//
//   { resolved: Set<string>, missing: [{ file, token, cwd, resolved }] }
//
// `resolved` is the "this file is executed by an explicit CI runner
// invocation" set (direction 2); `missing` is the pin-points-at-nothing set
// (direction 1). Both fall out of one parse, so the two directions can never
// disagree about what a workflow actually runs.
export function resolveWorkflowPins(repoRoot = REPO_ROOT, workflowDir = WORKFLOW_DIR, knownPaths, knownPkgDirs) {
  const tracked = knownPaths ?? trackedTestPaths(repoRoot);
  const pkgDirs = knownPkgDirs ?? workspacePackageDirs(repoRoot);
  const files = readdirSync(workflowDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const missing = [];
  const resolvedPaths = new Set();
  // Exact `node --test <path>` pins, tracked separately: they are the ONLY pin
  // shape that can execute a file the root vitest config EXCLUDES (see
  // findUngatedAuditTests).
  const nodeExact = new Set();
  for (const file of files) {
    const yamlText = readFileSync(join(workflowDir, file), "utf8");
    for (const { body, fold, baseCwd } of extractRunBlocks(yamlText)) {
      for (const { token, cwd, runner, narrowed } of pinnedTestsInBlock(body, fold, baseCwd, pkgDirs)) {
        const norm = token.replace(/^\.\//, "");
        // `node --test <path>` takes a PATH, not a filter: it runs that one file
        // and discovers nothing else. Vitest's path-SUBSTRING semantics — where
        // a bare `foo.test.mjs` selects every tracked `*/foo.test.mjs` — must
        // therefore not be applied to a node pin, or a same-named root file
        // would make a nested suite look executed when node ran only the root.
        if (runner === "node") {
          const exact = cwd ? posix.join(cwd, norm) : norm;
          if (existsSync(join(repoRoot, exact))) {
            resolvedPaths.add(exact);
            if (!narrowed) nodeExact.add(exact);
          } else missing.push({ file, token, cwd, resolved: exact });
          continue;
        }
        if (cwd) {
          // cwd is statically known (a `cd <dir>`, `working-directory:`, or
          // resolved `--filter` scope). vitest still filters by path SUBSTRING,
          // but only over tests discovered UNDER that dir — so accept a tracked
          // path that is BOTH inside `cwd/` AND a suffix of the token. The
          // `startsWith(cwd + "/")` guard excludes a same-suffix file in a
          // sibling package (the false-green that would otherwise slip through).
          const resolved = posix.join(cwd, norm);
          const hits = tracked.filter(
            (p) => p === resolved || (p.startsWith(cwd + "/") && p.endsWith("/" + norm)),
          );
          if (hits.length > 0) {
            for (const h of hits) resolvedPaths.add(h);
            continue;
          }
          if (existsSync(join(repoRoot, resolved))) {
            resolvedPaths.add(resolved);
            continue;
          }
          missing.push({ file, token, cwd, resolved });
        } else {
          // No statically-known cwd (root-relative, or a working-directory:/
          // pnpm --filter invocation we can't resolve): accept an exact path OR
          // a path-suffix match — vitest filters by path substring, so the pin
          // token being a suffix of a real test path means it will run.
          const hits = tracked.filter((p) => p === norm || p.endsWith("/" + norm));
          if (hits.length > 0) {
            for (const h of hits) resolvedPaths.add(h);
            continue;
          }
          if (existsSync(join(repoRoot, norm))) {
            resolvedPaths.add(norm);
            continue;
          }
          missing.push({ file, token, cwd, resolved: norm });
        }
      }
    }
  }
  return { resolved: resolvedPaths, nodeExact, missing };
}

// Direction 1: the list of pins that point at nothing. A pin is "missing" only
// when neither its exact (cwd-resolved) path is present on disk NOR any tracked
// test file path ends with the pinned token (the path-suffix rule that resolves
// working-directory:/--filter invocations without false-suppressing a genuine
// miss).
export function findMissingPinnedTests(repoRoot = REPO_ROOT, workflowDir = WORKFLOW_DIR, knownPaths, knownPkgDirs) {
  return resolveWorkflowPins(repoRoot, workflowDir, knownPaths, knownPkgDirs).missing;
}

// ---------------------------------------------------------------------------
// Direction 2 — every audit-gate suite is executed by SOMETHING.
// ---------------------------------------------------------------------------

/** The audit-gate fixture suites this guard governs. */
export const AUDIT_TEST_DIR = "scripts/audit/__tests__";
/** The root Vitest config whose include/exclude decides `pnpm test:root`. */
export const ROOT_VITEST_CONFIG = "vitest.config.ts";
/** The package script that runs the wholesale root suite. */
export const ROOT_SUITE_SCRIPT = "test:root";

// Strip `//` line comments WITHOUT touching a `//` inside a string literal, so
// the array scan below reads code and not prose. Block comments are not used
// inside the two arrays; a `/*` there would be left alone (and would surface as
// an unparseable-shape refusal only if it hid the array bounds).
export function stripLineComments(src) {
  let out = "";
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[++i] ?? "";
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

// Extract the bracket-balanced body of `key: [ … ]`. REFUSES (throws) on an
// absent, duplicated or unbalanced key rather than returning an empty set — an
// empty exclusion list would silently pass every file in direction 2, which is
// exactly the fail-OPEN outcome this guard exists to prevent.
export function extractArrayLiteral(src, key) {
  const re = new RegExp(`(^|[\\s{,])${key}\\s*:\\s*\\[`, "g");
  const starts = [];
  let m;
  while ((m = re.exec(src)) !== null) starts.push(m.index + m[0].length - 1);
  if (starts.length !== 1) {
    throw new Error(
      `${ROOT_VITEST_CONFIG}: expected exactly one \`${key}: [\` — found ${starts.length}. ` +
        "Refusing to guess; teach this parser the new shape.",
    );
  }
  let depth = 0;
  for (let i = starts[0]; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) return src.slice(starts[0] + 1, i);
    }
  }
  throw new Error(`${ROOT_VITEST_CONFIG}: unbalanced \`${key}: [\` array.`);
}

// The literal glob strings of the root config's `test.include` / `test.exclude`.
// Conditional tiers (`...(env ? [] : ["**/*.integration.test.ts"])`) contribute
// their guarded literals to `exclude` — conservative by construction: a file
// that MIGHT be excluded is treated as excluded and must therefore carry a CI
// pin.
export function parseRootVitestTestGlobs(repoRoot = REPO_ROOT, text) {
  const src = stripLineComments(text ?? readFileSync(join(repoRoot, ROOT_VITEST_CONFIG), "utf8"));
  // include is UNDER-approximated (only unconditional literals) and exclude is
  // OVER-approximated (conditional tiers contribute both branches). Both errors
  // point the same way: a file is more likely to be judged "not covered by the
  // root run" and therefore to REQUIRE an explicit CI pin. Erring the other way
  // would let an unrun suite pass.
  const include = parseArrayElements(extractArrayLiteral(src, "include"), "include", { conditionalSpreads: false });
  const exclude = parseArrayElements(extractArrayLiteral(src, "exclude"), "exclude", { conditionalSpreads: true });
  if (include.length === 0) throw new Error(`${ROOT_VITEST_CONFIG}: parsed an EMPTY test.include — refusing.`);
  if (exclude.length === 0) throw new Error(`${ROOT_VITEST_CONFIG}: parsed an EMPTY test.exclude — refusing.`);
  return { include, exclude };
}

// Split an array-literal body into its top-level elements, respecting nesting
// and quoting so a comma inside `(… ? [] : ["a","b"])` or inside a string does
// not split an element.
export function splitTopLevelElements(body) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

// Read the elements of a `test.include` / `test.exclude` array, REFUSING any
// element shape this parser does not model.
//
// The refusal is the load-bearing part. A "collect every quoted string" scan
// has two failure modes, and both are silent: it swallows a ternary CONDITION
// operand (`process.env.X === "1"`) as if it were a glob, and — far worse — it
// says nothing when an element is a spread of an identifier
// (`...auditExclusions`) or any other expression, quietly dropping real
// exclusions and re-classifying carved-out suites as "covered by the root run".
// Refusing an unmodelled shape turns that into a loud, obvious failure whose
// fix is to teach this function the new shape.
export function parseArrayElements(body, key, { conditionalSpreads = false } = {}) {
  const STRING_RE = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/;
  const out = [];
  for (const el of splitTopLevelElements(body)) {
    const str = el.match(STRING_RE);
    if (str) {
      const value = str[1] ?? str[2];
      if (!/[/*]/.test(value)) {
        throw new Error(
          `${ROOT_VITEST_CONFIG}: test.${key} element ${JSON.stringify(value)} is neither a path nor a glob. ` +
            "Refusing to guess; teach this parser the new shape.",
        );
      }
      out.push(value);
      continue;
    }
    // The one modelled non-literal shape: an env-conditional tier
    // `...(process.env.FLAG === "1" ? [] : ["glob", …])`. Both branches are
    // folded in — the tier MIGHT be excluded, and treating it as excluded is
    // the fail-closed reading. The shape is validated STRUCTURALLY (both
    // branches must be array literals of plain strings), not by scraping the
    // expression for path-shaped strings: a scrape accepts
    // `...(flag ? auditExclusions : ["known/*"])` and silently drops the
    // identifier branch.
    if (conditionalSpreads && /^\.\.\.\s*\(/.test(el)) {
      out.push(...parseConditionalSpread(el, key));
      continue;
    }
    throw new Error(
      `${ROOT_VITEST_CONFIG}: test.${key} element \`${el.slice(0, 60)}\` is not a plain string literal` +
        (conditionalSpreads ? " or a modelled conditional spread" : "") +
        ". Refusing to guess; teach this parser the new shape.",
    );
  }
  return out;
}

// `...( <cond> ? [ …literals ] : [ …literals ] )` — the ONLY conditional shape
// this parser models. Both branches must be array literals of plain strings;
// an identifier, call or nested conditional in either branch throws, because
// folding in "whatever strings I can find" would quietly drop the rest.
export function parseConditionalSpread(el, key) {
  const refuse = (why) =>
    new Error(
      `${ROOT_VITEST_CONFIG}: test.${key} conditional spread \`${el.slice(0, 70)}\` ${why}. ` +
        "Refusing to guess; teach this parser the new shape.",
    );
  const open = el.indexOf("(");
  if (open === -1 || !el.endsWith(")")) throw refuse("is not a parenthesised expression");
  const inner = el.slice(open + 1, -1);
  const q = indexAtTopLevel(inner, "?");
  if (q === -1) throw refuse("has no top-level `?` (only a ternary is modelled)");
  const colon = indexAtTopLevel(inner.slice(q + 1), ":");
  if (colon === -1) throw refuse("has no top-level `:`");
  const branches = [inner.slice(q + 1, q + 1 + colon).trim(), inner.slice(q + 2 + colon).trim()];
  const out = [];
  for (const branch of branches) {
    if (!(branch.startsWith("[") && branch.endsWith("]"))) {
      throw refuse(`has a non-array branch \`${branch.slice(0, 40)}\``);
    }
    out.push(...parseArrayElements(branch.slice(1, -1), key, { conditionalSpreads: false }));
  }
  return out;
}

/** Index of `ch` at bracket/paren/quote depth 0, or -1. */
export function indexAtTopLevel(text, ch) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

// Minimal, anchored glob → RegExp for the shapes vitest configs actually use:
// `**/` (any depth), `**` (any suffix), `*` / `?` (within one segment) and
// `{a,b}` alternation. Unbalanced braces throw rather than silently mis-match.
export function globToRegExp(glob) {
  // Refuse syntax this converter does not implement instead of escaping it into
  // a literal. Silently treating `*.test.[mj]s` as literal text means the
  // exclusion matches nothing here while vitest applies it for real — the
  // suites it carves out would be reported as riding the root run. A refusal is
  // loud and its fix is to teach this function the construct.
  const unmodelled = glob.match(/[[\]()!]|\\./);
  if (unmodelled) {
    throw new Error(
      `unmodelled glob syntax ${JSON.stringify(unmodelled[0])} in ${JSON.stringify(glob)} — ` +
        "this converter implements only **, *, ? and {a,b}. Teach it the construct.",
    );
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) throw new Error(`unbalanced { in glob: ${glob}`);
      const inner = glob.slice(i + 1, end);
      // Only a flat comma alternation of 2+ literal branches is modelled.
      // picomatch also honours `{1..3}` ranges and nested braces, and treats a
      // SINGLE-item `{foo}` as the literal text `{foo}` — mis-modelling any of
      // those makes a real exclusion look ineffective, which is the fail-open
      // direction. Refuse instead.
      if (inner.includes("{") || inner.includes("}")) throw new Error(`nested brace in glob: ${glob}`);
      if (/\.\./.test(inner)) throw new Error(`brace range in glob: ${glob}`);
      if (!inner.includes(",")) throw new Error(`single-item brace in glob (literal in picomatch): ${glob}`);
      // picomatch expands wildcards INSIDE a branch (`{foo,*.test.mjs}`); this
      // converter treats branches as literal text, so refuse rather than
      // under-match and make a real exclusion look ineffective.
      if (/[*?]/.test(inner)) throw new Error(`wildcard inside a brace branch: ${glob}`);
      out += `(?:${inner.split(",").map(esc).join("|")})`;
      i = end + 1;
    } else if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:[^/]+/)*";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
    } else if (c === "*") {
      out += "[^/]*";
      i += 1;
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += esc(c);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Every tracked audit-gate suite, repo-relative. */
export function auditTestFiles(repoRoot = REPO_ROOT) {
  return trackedTestPaths(repoRoot).filter((p) => p.startsWith(AUDIT_TEST_DIR + "/"));
}

// A file "rides the wholesale root run" when the include selects it and no
// exclusion takes it back out — i.e. exactly what `pnpm test:root` executes.
export function ridesRootVitestRun(file, globs) {
  const included = globs.include.some((g) => globToRegExp(g).test(file));
  if (!included) return false;
  return !globs.exclude.some((g) => globToRegExp(g).test(file));
}

// Which workflows invoke the wholesale root suite. "Rides the root include" is
// only a coverage claim while SOMETHING still runs `pnpm test:root`; delete that
// one step and every root-only audit suite goes dark at once. So the claim is
// verified, not assumed.
//
// What this cannot check without network access: whether the job holding that
// step is a REQUIRED context on the default branch. That lives in branch
// protection, not in the repo, and this gate is deliberately dependency-free.
// Presence is the checkable half; requiredness is asserted by the job's own
// header comment and by branch protection.
export function findRootSuiteInvocations(workflowDir = WORKFLOW_DIR) {
  const files = readdirSync(workflowDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const hits = [];
  for (const file of files) {
    const yamlText = readFileSync(join(workflowDir, file), "utf8");
    for (const { body, fold, baseCwd } of extractRunBlocks(yamlText)) {
      let normalized = body.replace(/\\[ \t]*\n/g, " ");
      if (fold === "folded") normalized = normalized.replace(/\n+/g, " ");
      // The ROOT suite must be launched from the REPO ROOT. `pnpm test:root`
      // run under `working-directory: packages/objects` — or after a `cd` into
      // a package — is that package's script, not the wholesale root run, so
      // the cwd is tracked exactly as the pin scanner tracks it.
      let cwd = baseCwd;
      let found = false;
      for (const rawSeg of splitShellSegments(normalized)) {
        const seg = rawSeg.trim();
        if (!seg) continue;
        const cdMatch = seg.match(/^cd\s+(\S+)/);
        if (cdMatch) {
          const dir = cdMatch[1];
          if (dir === "../.." || dir === "../../" || dir.startsWith("/")) cwd = "";
          else if (dir === "..") cwd = posix.dirname(cwd || ".") === "." ? "" : posix.dirname(cwd);
          else cwd = cwd ? posix.join(cwd, dir) : dir;
          continue;
        }
        if (cwd === "" && invokesRootSuite(seg)) {
          found = true;
          break;
        }
      }
      if (found) {
        hits.push(file);
        break;
      }
    }
  }
  return [...new Set(hits)];
}

// Direction 2: audit suites executed by NO runner at all.
//
// The acceptance rule for a root-EXCLUDED suite is deliberately narrow: only an
// exact `node --test <path>` pin counts. A `vitest run <excluded-file>` pin does
// NOT, because vitest discovers files through the config's include/exclude
// FIRST and only then applies CLI positionals as filters — a positional naming
// an excluded file selects nothing and the step still passes. Accepting such a
// pin would credit coverage that provably does not run.
export function findUngatedAuditTests(repoRoot = REPO_ROOT, workflowDir = WORKFLOW_DIR, opts = {}) {
  const globs = opts.globs ?? parseRootVitestTestGlobs(repoRoot);
  const files = opts.auditFiles ?? auditTestFiles(repoRoot);
  const nodeExact = opts.nodeExact ?? resolveWorkflowPins(repoRoot, workflowDir).nodeExact;
  const ungated = [];
  for (const file of files) {
    if (ridesRootVitestRun(file, globs)) continue;
    if (nodeExact.has(file)) continue;
    ungated.push(file);
  }
  return ungated;
}

// A literal-path exclusion naming a file that no longer exists. Harmless at
// runtime, but it is the fossil of a suite that was renamed or deleted, and it
// keeps the carve-out list from being readable as the truth it claims to be.
export function findStaleRootExclusions(repoRoot = REPO_ROOT, globs) {
  const g = globs ?? parseRootVitestTestGlobs(repoRoot);
  return g.exclude.filter((x) => !/[*?{}]/.test(x) && !existsSync(join(repoRoot, x)));
}

// Run as a CLI gate — both directions, all findings reported before exiting so
// one run tells the whole truth.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let failed = false;

  const { resolved, nodeExact, missing } = resolveWorkflowPins();
  if (missing.length > 0) {
    failed = true;
    console.error("✗ CI pins test files that do not exist on disk:");
    for (const m of missing) {
      console.error(`  - ${m.file}: pinned "${m.token}"${m.cwd ? ` (cwd ${m.cwd})` : ""} → ${m.resolved} MISSING`);
    }
    console.error(
      "\nA pinned-but-missing test passes silently (vitest ignores zero-match positionals).\n" +
        "Restore the file, or remove the stale pin from the workflow.",
    );
  } else {
    console.log("✓ all workflow-pinned test files exist on disk");
  }

  const globs = parseRootVitestTestGlobs();

  const rootRuns = findRootSuiteInvocations();
  const rootOnly = auditTestFiles().filter((f) => ridesRootVitestRun(f, globs) && !resolved.has(f));
  if (rootRuns.length === 0 || !rootSuiteScriptRunsVitest()) {
    failed = true;
    console.error(
      rootRuns.length === 0
        ? `\n✗ NO workflow invokes the wholesale root suite (\`pnpm ${ROOT_SUITE_SCRIPT}\`).\n` +
          `  ${rootOnly.length} audit-gate suite(s) are executed by that step and nothing else,\n` +
          "  so they now run nowhere. Restore the step, or pin each suite explicitly."
        : `\n✗ the \`${ROOT_SUITE_SCRIPT}\` script no longer runs the wholesale root Vitest suite.\n` +
          `  ${rootOnly.length} audit-gate suite(s) depend on it; a script that does not run\n` +
          `  \`vitest run\` over ${ROOT_VITEST_CONFIG} (unnarrowed) leaves them dark behind a green step.`,
    );
  } else {
    console.log(
      `✓ the wholesale root suite runs in ${rootRuns.join(", ")} (${rootOnly.length} audit suites depend on it)`,
    );
  }

  const ungated = findUngatedAuditTests(REPO_ROOT, WORKFLOW_DIR, { globs, nodeExact });
  if (ungated.length > 0) {
    failed = true;
    console.error("\n✗ audit-gate suites that NO CI runner executes:");
    for (const f of ungated) console.error(`  - ${f}`);
    console.error(
      `\nEach file above is carved out of ${ROOT_VITEST_CONFIG}'s \`test.exclude\` (so the\n` +
        "wholesale `pnpm test:root` skips it) and is pinned by no workflow runner, so it\n" +
        "runs NOWHERE. A gate suite nobody runs cannot prove its gate still catches\n" +
        "anything. Fix by EITHER dropping the exclusion (if it is a vitest suite, so the\n" +
        "wholesale root run picks it up) OR adding a `node --test <file>` step to a\n" +
        "required job. A `vitest run <file>` pin does NOT work here: vitest applies this\n" +
        "config's exclude BEFORE the CLI positional, so the filter selects nothing.",
    );
  } else {
    console.log("✓ every scripts/audit/__tests__ suite is executed by a CI runner");
  }

  const stale = findStaleRootExclusions(REPO_ROOT, globs);
  if (stale.length > 0) {
    failed = true;
    console.error(`\n✗ ${ROOT_VITEST_CONFIG} excludes literal paths that do not exist:`);
    for (const s of stale) console.error(`  - ${s}`);
    console.error("\nRemove the stale exclusion — it advertises a carve-out for a file that is gone.");
  } else {
    console.log(`✓ no stale literal-path exclusions in ${ROOT_VITEST_CONFIG}`);
  }

  if (failed) process.exit(1);
}
