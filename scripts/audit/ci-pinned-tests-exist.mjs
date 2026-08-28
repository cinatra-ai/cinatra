#!/usr/bin/env node
// CI guard, three directions over the SAME run-block parser:
//
//   1. PIN → FILE. Every test file explicitly pinned in a workflow
//      `vitest run` / `node --test` invocation MUST exist on disk.
//   2. AUDIT SUITE → RUNNER. Every `scripts/audit/__tests__` suite MUST be
//      executed by something: either the root Vitest include (`pnpm test:root`,
//      the wholesale gate of record) or an explicit workflow runner pin.
//   3. PACKAGE SUITE → RUNNER (cinatra#2439). Every `packages/**` test file
//      MUST be executed by something — the root include, an explicit workflow
//      pin, or a WHOLESALE package-suite invocation (`cd packages/x && pnpm
//      test`, `pnpm -C packages/x exec vitest run`, `pnpm --filter <pkg> run
//      test`) — or carry a machine-readable exception entry in
//      scripts/audit/package-suite-runner-exceptions.json.
//   4. ROOT TIER → RUNNER (cinatra#2936). Every root private proof tier —
//      a `vitest/integration/<slice>.config.ts` tier config, reached
//      through a package script — MUST be invoked by a workflow that can turn
//      a check red, or carry a machine-readable exception entry in
//      scripts/audit/root-tier-runner-exceptions.json.
//
// Why (1) exists: `vitest run a.test.ts b.test.ts` treats positionals as
// FILTERS. If one positional matches zero files, vitest SILENTLY ignores it as
// long as the others match — the step still passes. So a pinned test that was
// renamed/lost (e.g. dropped in a rebase) leaves its pin behind and CI stays
// green while advertising coverage it no longer has. This guard is the
// secondary tripwire that turns that silent gap into a hard failure.
//
// Why (4) exists: the same hole, one door further out. A tier written as a
// dedicated ROOT config plus a `"test:x": "vitest run --config
// vitest/integration/N.config.ts"` package script is invisible to (1), (2) and
// (3) alike: (1) reads file paths PINNED INSIDE a workflow and this tier pins
// none; (2) governs `scripts/audit/__tests__`; (3) governs `packages/**`. So a
// tier of this shape joins CI only when somebody adds a step, and — exactly as
// (3) found for package suites — nothing said when nobody did. Measured on
// `main` at the time of writing: of eleven such tiers, ONE was invoked by a
// workflow. The other ten were fixtures whose failure mode was silence, three of
// them the private proof tiers of the epic this direction was written for. A
// tier's config is a DELIBERATE artifact — somebody wrote a whole file to say
// "these suites need a real database and must never pass as skipped" — which is
// what makes an unrun one worth failing over rather than shrugging at.
//
// Why (3) exists: (2)'s inventory sweep found the same hole one level out.
// ~209 plain package unit suites — the whole of packages/llm, packages/chat,
// packages/agent-ui-protocol, most of packages/objects and packages/registries,
// and a dozen small packages — were executed by NO workflow at all. Not
// carved out, not quarantined: simply never wired, because a package's tests
// join CI only when somebody adds a step, and nothing said when nobody did.
// The repo-wide typecheck still compiled those files, so a TYPE error reded CI
// while a FAILING ASSERTION did not — the same distinction that motivated the
// packages/execution-plane job (cinatra#2316) and the extension-suite discovery
// gate (cinatra#2288), arriving through a third door. Direction (3) inverts the
// default: a test file under packages/ with no statically detected runner and
// no written exception is a hard failure that NAMES the file.
//
// Why (3) is STATIC and not a runner. This gate reads workflows; it does not
// execute suites. So it must decide "is this file executed" from the workflow
// text plus the vitest configuration, which is exactly what it does — and where
// it cannot decide, it refuses (see parseVitestTestGlobs / wholesaleVitestArgv)
// rather than guessing in the fail-OPEN direction.
//
// What (3) credits is therefore narrow ON PURPOSE. A run is credited only when
// it is REACHABLE (its workflow fires on a change; its step is not
// `continue-on-error`, not literal-`if: false`, not behind `||`, not after a
// top-level `exit`, not under `set +e`), its FAILURE PROPAGATES (no pipeline, no
// backgrounding, no status-masking `;` chain in the package script), its TARGET
// is unambiguous (one selector, resolvable, no unquoted expansion), and its
// ARGUMENTS provably narrow nothing. Anything else is refused, which costs a
// loud "this suite has no runner" that a human fixes — never a silent green.
//
// Residuals it does NOT model, named rather than hidden. None is used by any
// workflow in this repo today, and all but the last degrade toward NOT
// CREDITED — a false RED a human fixes, never a false green:
//   - job `strategy`/matrix expansion;
//   - YAML anchors and aliases (an aliased `on:` reads as no trigger);
//   - `defaults.run.working-directory` at workflow or job level (a step there
//     gets no cwd, so a wholesale run in it is not credited);
//   - a job whose steps come from a composite action or a reusable `uses:`
//     workflow — never traversed, so never credited;
//   - a `shell:` this walk does not model (refused outright).
//
// The ONE residual that leans the other way is a non-trivial `if:` expression:
// it is treated as EXECUTING, exactly as direction 2 already treats it.
// Evaluating one needs run context this gate cannot see, and refusing them
// instead would credit nothing at all here — every gating job in this repo
// carries the docs-only skip condition (`if: ${{ needs.detect.outputs.skip !=
// 'true' }}`), so a blanket refusal would red the gate on genuinely covered
// suites and make it unusable. Literal-`false` forms ARE honoured.
//
// Also out of scope, and pre-existing: a step-level `env:` that narrows a
// runner invisibly (`NODE_OPTIONS=--test-name-pattern=…` on a `node --test`
// pin). That is direction 2's `narrowed` model, unchanged here; no workflow in
// this repo sets NODE_OPTIONS on a test step.
//
// The discovery model is verified EMPIRICALLY, not assumed: at the time of
// writing, `packageDiscoverySet` predicted exactly the file set vitest executed
// for all 26 packages with a wholesale runner (1,090 files, zero mismatches in
// either direction).
//
// WHERE THE REVIEW LOOP WAS CLOSED, and why here. Direction 3 went through
// eight adversarial passes; every concrete fail-open they produced is closed
// above and pinned by a case in the test suite. By the last passes the findings
// had become narrower SPELLINGS of classes already modelled — a quoted flag, a
// numeric heredoc delimiter, `yarn --cwd` beside `pnpm -C` — and each needed
// someone to deliberately write an exotic shell or YAML construct into a
// REVIEWED workflow file to matter. That is a documented residual, not an open
// hole, and it is measured against the right baseline: what this replaces is
// not a stricter guard, it is NO CHECK AT ALL on ~209 suites. The stopping rule
// is written down so the next person can apply it too — when a finding needs a
// construct no workflow in this repo has ever used AND it is a variant of a
// class already refused, teach the parser only if the construct arrives.
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
  "testTimeout", "hookTimeout", "environment", "logHeapUsage", "no-watch", "watch",
]);
// `--passWithNoTests` is DELIBERATELY absent alongside `--mode`: a run that
// exits 0 having collected NOTHING is exactly the vacuous green this whole gate
// exists to catch, and paired with `--exclude` it turns any pin into one.
// `--mode` is DELIBERATELY absent. It overrides the Vite mode, and a config may
// branch on it (or load a different `.env.<mode>`) to change `test.include` /
// `test.exclude` — i.e. it can reduce discovery while looking inert. No script
// or workflow in this repo passes it; if one ever needs to, the honest fix is
// to prove the config is mode-invariant, not to widen this list.
// `--config`/`-c` is the one allowlisted flag whose VALUE is load-bearing: it
// must name the root config or the run is a different suite entirely.
const VITEST_CONFIG_FLAGS = new Set(["config", "c"]);
// Flags whose value is a separate following token (subset of the allowlist).
const VITEST_SAFE_VALUE_FLAGS = new Set([
  "config", "c", "reporter", "outputFile", "pool", "maxWorkers", "minWorkers",
  "testTimeout", "hookTimeout", "environment",
]);
// node:test flags that make `node --test <file>` run fewer tests than the file
// contains — possibly none. A pin carrying one of these does not prove the
// suite executed.
const NODE_NARROWING_FLAGS = new Set([
  "--test-shard", "--test-only", "--test-name-pattern", "--test-skip-pattern",
  // Node 24: reruns only the tests that have not already passed.
  "--test-rerun-failures",
]);

// Flags that make a launcher or a runner PRINT AND EXIT 0 without running
// anything: `pnpm --help run test:root`, `vitest run --help <file>`,
// `node --test --help <file>`. Each exits successfully, so a credited runner
// behind one is coverage that provably never executes.
export const TERMINAL_FLAGS = new Set([
  "--help", "-h", "--version", "-v", "-V", "--dry-run", "--list", "--print-config",
]);
export function hasTerminalFlag(tokens) {
  return tokens.some((t) => TERMINAL_FLAGS.has(t.replace(/^["']|["']$/g, "").split("=")[0]));
}

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
  return splitShellCommands(body).map((c) => c.text);
}

// The same split, retaining the SEPARATOR that ended each command. Direction 3
// needs it: a runner whose command is followed by `||` has its failure swallowed
// by the alternative (`pnpm test || true`), so crediting it would advertise a
// gate that cannot turn red. `splitShellSegments` is the text-only view over
// this, unchanged for directions 1 and 2.
export function splitShellCommands(body) {
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
    segments.push({ text: shortCircuited ? "" : buf, sep });
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
      // `<<\EOF`, `<<'EOF'`, `<<"EOF"` and bare `<<EOF` all quote the body;
      // the backslash form is a real shell spelling and missing it exposed a
      // heredoc's DATA as commands.
      const opens = [...lineTail.matchAll(/<<(-?)\s*\\?(["']?)([^\s"'`;&|<>()]+)\2/g)].map((m) => ({
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
  if (hasTerminalFlag(toks)) return null; // prints help/version and exits 0
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
  if (hasTerminalFlag(toks)) return false; // `pnpm --help run test:root` prints help
  let pm = false; // a package-manager launcher was reached
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = i > 0 ? toks[i - 1] : "";
    // A package-scoped or filtered invocation is a DIFFERENT package's script,
    // not the repo-root wholesale run.
    if (LAUNCHER_VALUE_FLAGS.has(prev)) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    if (t.startsWith("--filter") || t.startsWith("-F") || t.startsWith("-C") || t.startsWith("--dir")) return false;
    // `npm --workspaces run test:root` runs the script in every WORKSPACE and
    // skips the root package; with `--if-present` it exits 0 having run nothing
    // at all. Either way it is not the repo-root wholesale suite.
    if (t === "--workspaces" || t === "-w" || t.startsWith("--workspace") || t === "--recursive" || t === "-r" || t === "--if-present") {
      return false;
    }
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

// Is a vitest argv a WHOLESALE run of `expectedConfig` — every file the config
// discovers, none filtered away? Shared by the root-suite check (direction 2)
// and the package-suite check (direction 3) so the two can never disagree about
// what "wholesale" means.
//
// `expectedConfig`: the config path a `--config`/`-c` value must equal. Pass
// null to forbid `--config` outright (a package run may not be redirected to
// some other config and still be credited as that package's suite).
export function wholesaleVitestArgv(argv, expectedConfig) {
  for (let i = 0; i < argv.length; i++) {
    // An UNQUOTED `$VAR` / `$(…)` / `${{ … }}` is a value this gate cannot see,
    // and the shell WORD-SPLITS it: `--reporter=$ARGS` with
    // `ARGS='default src/foo.test.ts'` becomes a reporter plus a positional
    // filter. Inside double quotes it cannot split, so a quoted expansion (the
    // `--outputFile.json="${{ github.workspace }}/…"` in build-image.yml) is
    // fine. Refuse the unquoted form rather than assume it expands to nothing.
    if (hasUnquotedExpansion(argv[i])) return false;
    const t = argv[i].replace(/^["']|["']$/g, "");
    if (!t.startsWith("-")) return false; // a positional operand narrows the run
    // `--flag=value` and the short `-c=value` form both carry their value inline.
    const eq = t.match(/^-{1,2}([\w.-]+)=(.*)$/);
    const name = eq ? eq[1] : t.replace(/^-+/, "");
    if (!isWholesaleSafeFlagName(name)) return false; // unknown ⇒ fail closed
    const inlineValue = eq ? eq[2].replace(/^["']|["']$/g, "") : null;
    if (VITEST_CONFIG_FLAGS.has(name)) {
      if (expectedConfig === null) return false; // redirected to another config
      const value = inlineValue ?? (argv[i + 1] ?? "").replace(/^["']|["']$/g, "");
      if (value !== expectedConfig) return false;
    }
    if (inlineValue === null && isWholesaleSafeValueFlagName(name)) {
      // The value is a SEPARATE token, so it must be checked too: the loop
      // would otherwise step straight over `--reporter $ARGS`.
      if (i + 1 < argv.length && hasUnquotedExpansion(argv[i + 1])) return false;
      i++; // consume the value
    }
  }
  return true;
}

// Does the token contain a shell/GitHub expansion OUTSIDE quotes? Only an
// unquoted one word-splits, so only an unquoted one can smuggle a positional
// operand past the flag classifier.
export function hasUnquotedExpansion(token) {
  let quote = null;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    // Single quotes suppress expansion entirely; double quotes suppress
    // word-splitting, which is the property that matters here.
    if (c === "$" || c === "`") return true;
  }
  return false;
}

// `--outputFile.<reporter>` is the dotted form of `--outputFile` (one path per
// reporter) — `pnpm --filter @cinatra-ai/execution-plane run test
// --reporter=json --outputFile.json=…` in build-image.yml uses it. It writes a
// REPORT and narrows nothing, so it belongs in the wholesale-safe set; it is
// spelled as a prefix rule rather than an enumeration only because the suffix
// is a reporter NAME, not a fixed vocabulary. Everything else still has to be
// classified in the allowlist by hand, which is the fail-closed property.
function isWholesaleSafeFlagName(name) {
  return VITEST_WHOLESALE_SAFE_FLAGS.has(name) || name.startsWith("outputFile.");
}
function isWholesaleSafeValueFlagName(name) {
  return VITEST_SAFE_VALUE_FLAGS.has(name) || name.startsWith("outputFile.");
}

// …and the script it names must still BE the wholesale root run. Rewriting
// `"test:root": "true"` would otherwise leave every root-only audit suite dark
// behind a green gate.
export function rootSuiteScriptRunsVitest(repoRoot = REPO_ROOT, script = ROOT_SUITE_SCRIPT) {
  return packageScriptIsWholesaleVitest(repoRoot, "", script, ROOT_VITEST_CONFIG);
}

// The generalised form: does `<pkgDir>/package.json`'s `<script>` run the
// wholesale vitest suite of `<pkgDir>`? `pkgDir` "" is the repo root.
//
// The grammar accepted here is deliberately NARROW, because a package script is
// where a runner is easiest to neutralise while still reading as one. A script
// runs under `sh -c` with errexit OFF, so its exit status is the status of its
// LAST command: `vitest run; echo done` exits 0 whatever the suite did, and
// `vitest run || true`, `vitest run | tee out` and `vitest run & wait` all mask
// it too. So: EVERY separator in the body must be `&&` — that is the one
// operator under which a vitest failure both stops the chain and becomes the
// script's status — and no pipe, background, redirection, subshell or unquoted
// expansion may appear anywhere in it. Anything else is refused, and the fix is
// to write the script as an unconditional `&&` chain.
export function packageScriptIsWholesaleVitest(repoRoot, pkgDir, script, expectedConfig = null) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, pkgDir, "package.json"), "utf8"));
  } catch {
    return false;
  }
  const cmd = pkg?.scripts?.[script];
  if (typeof cmd !== "string") return false;
  // A subshell, a background `&` or a redirection anywhere in the body puts the
  // invocation, or its status, somewhere this walk cannot follow. `vitest run &
  // wait` is the sharpest case: argv recovery stops at the `&`, so the argv
  // looks empty and therefore wholesale, while the suite runs detached and its
  // exit status is `wait`'s.
  if (hasUnquotedExpansion(cmd) || /[()]/.test(cmd) || hasTopLevelBackground(cmd)) return false;
  const commands = splitShellCommands(cmd);
  // `true && exit 0 && vitest run` satisfies the all-`&&` rule below yet never
  // reaches vitest. `trap` is refused for the same reason as in a workflow
  // block, and a `set` that moves errexit changes the status rules this
  // grammar assumes.
  // A `cd` moves the run into another package, where a different config
  // governs discovery: `"test": "cd ../agents && vitest run"` is not this
  // package's suite at all.
  if (
    commands.some(
      (c) =>
        /^(exit|return|exec|trap|cd)\b/.test(stripEnvPrefix(c.text)) ||
        errexitSetting(c.text) !== null ||
        isShellControlCommand(c.text),
    )
  ) {
    return false;
  }
  let found = false;
  for (const [i, { text, sep }] of commands.entries()) {
    const seg = text.trim();
    if (!seg) continue;
    // The only separator that both propagates a failure and guarantees the next
    // command ran. `""` is the end of the body; a newline inside a package
    // script body is the same status-masking shape as `;`.
    const isLast = i === commands.length - 1;
    if (!(sep === "&&" || (isLast && sep === ""))) return false;
    if (hasTopLevelRedirect(seg)) return false;
    const invocation = runnerArgv(seg);
    if (invocation?.runner !== "vitest") continue;
    if (wholesaleVitestArgv(invocation.argv, expectedConfig)) found = true;
  }
  return found;
}

// A top-level `&` (backgrounding), as distinct from `&&`. A backgrounded runner
// runs detached and its exit status never becomes the command's.
export function hasTopLevelBackground(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "\\") i++;
    else if (c === "&") {
      if (text[i + 1] === "&") i++; // `&&` — a separator, not a background
      else if (text[i - 1] === "&") continue; // second half of a `&&`
      else return true;
    }
  }
  return false;
}

// Does the segment carry a shell redirection outside quotes? A redirection is
// where argv recovery stops (`argvUntilRedirect`), so operands AFTER one are
// invisible to the flag classifier — `vitest run >out src/foo.test.ts` would
// otherwise read as wholesale while the shell passes a positional filter.
// Directions 1 and 2 legitimately cut argv at a redirect (a redirect TARGET is
// not a pin); direction 3 refuses the whole segment instead.
export function hasTopLevelRedirect(seg) {
  let quote = null;
  const text = stripShellComment(seg);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "\\") i++;
    else if (c === ">" || c === "<") return true;
  }
  return false;
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
    const m = lines[i].match(/^(\s*)(- )?["']?run["']?:\s?(.*)$/);
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
    const { dir: baseCwd, unknown: baseCwdUnknown } = stepWorkingDirectory(lines, i, keyIndent);
    // `continue-on-error: true` (step or job) means a failure here does NOT
    // fail the check. Reported, not enforced — so direction 3 must not credit a
    // runner living inside one. Directions 1 and 2 ignore the flag: an
    // existence check does not care whether the step blocks, and the audit
    // direction's own `node --test` pins are all in enforcing steps.
    const nonBlocking = stepContinuesOnError(lines, i, keyIndent) || jobContinuesOnError(lines, i);
    // A job's `runs-on` decides the DEFAULT shell: Linux gets `bash -e`, Windows
    // gets PowerShell, whose failure semantics this walk does not model at all.
    // Anything not demonstrably a Linux runner is refused.
    const linuxRunner = jobRunsOnLinux(lines, i);
    // A step-level `shell:` replaces GitHub's default `bash -e {0}`, and with it
    // the failure semantics direction 3's walk reasons about. Carried so that
    // walk can refuse a shell it does not model (see isErrexitBashShell).
    const shell = stepShell(lines, i, keyIndent);
    // A `run:` key can appear where nothing executes it — `env: { run: … }`, a
    // `with:` input, a comment-shaped mapping. Only a key inside a `steps:` list
    // item is a command GitHub runs, so direction 3 credits only those. (The
    // existence checks in directions 1 and 2 keep reading every `run:`; a pin
    // written anywhere still has to point at a real file.)
    const isStep = runKeyIsStep(lines, i, keyIndent);
    const inline = m[3];
    const scalar = inline.trim().match(/^([|>])[+-]?\d*\s*$/);
    if (inline.trim() && !scalar) {
      blocks.push({ body: inline, fold: "inline", baseCwd, baseCwdUnknown, nonBlocking, shell, isStep, linuxRunner, startLine: i + 1 });
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
    blocks.push({ body: body.join("\n"), fold, baseCwd, baseCwdUnknown, nonBlocking, shell, isStep, linuxRunner, startLine: i + 1 });
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
    const m = ln.match(/^\s*(?:- )?["']?if["']?:\s*(.+?)\s*$/);
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
    if (ind === 2 && /^\s{2}["']?[A-Za-z_][\w-]*["']?:/.test(ln)) { jobStart = k; break; }
    if (ind === 0) return false; // left the jobs: mapping without finding one
  }
  if (jobStart === -1) return false;
  for (let k = jobStart + 1; k < lines.length; k++) {
    const ln = lines[k];
    if (ln.trim() === "") continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind <= 2) break; // next job
    if (ind !== 4) continue; // job-level keys only
    const m = ln.match(/^\s*["']?if["']?:\s*(.+?)\s*$/);
    if (m && isLiterallyFalse(m[1])) return true;
  }
  return false;
}

// Is the step holding the `run:` at `runIdx` marked `continue-on-error: true`?
// Same step-bounded, column-anchored lookup as the `if:` check above. Only the
// literal-true forms count (`true`, `'true'`, `${{ true }}`); an expression is
// left alone for the same reason a non-trivial `if:` is — this gate cannot
// evaluate run context, and guessing either way would be wrong.
export function stepContinuesOnError(lines, runIdx, keyIndent) {
  const { start, end } = stepBounds(lines, runIdx, keyIndent);
  for (let k = start; k < end; k++) {
    const ln = lines[k];
    const m = ln.match(/^\s*(?:- )?["']?continue-on-error["']?:\s*(.+?)\s*$/);
    if (!m) continue;
    const ind = ln.length - ln.trimStart().length;
    const keyCol = /^\s*- /.test(ln) ? ind + 2 : ind;
    if (keyCol !== keyIndent) continue;
    // Literal `false` is the only value that keeps the step blocking. A literal
    // `true` obviously does not — and neither does an EXPRESSION, because this
    // gate cannot evaluate one and `continue-on-error: ${{ 1 == 1 }}` is a
    // perfectly ordinary way to write "true". Unlike the `if:` residual, no
    // workflow here writes an expression for continue-on-error, so reading an
    // unevaluable one as non-blocking costs nothing and closes the hole.
    if (!isLiterallyFalse(m[1])) return true;
  }
  return false;
}

// …and the job-level form, which covers every step it holds. Walks back to the
// nearest `jobs:` child key exactly as jobIsLiterallyDisabled does.
export function jobContinuesOnError(lines, runIdx) {
  let jobStart = -1;
  for (let k = runIdx; k >= 0; k--) {
    const ln = lines[k];
    if (ln.trim() === "" || /^\s*#/.test(ln)) continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind === 2 && /^\s{2}["']?[A-Za-z_][\w-]*["']?:/.test(ln)) { jobStart = k; break; }
    if (ind === 0) return false;
  }
  if (jobStart === -1) return false;
  for (let k = jobStart + 1; k < lines.length; k++) {
    const ln = lines[k];
    if (ln.trim() === "") continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind <= 2) break;
    if (ind !== 4) continue;
    const m = ln.match(/^\s*["']?continue-on-error["']?:\s*(.+?)\s*$/);
    if (m && !isLiterallyFalse(m[1])) return true;
  }
  return false;
}

// `true`, `${{ true }}`, `'true'`, with an optional trailing YAML comment.
export function isLiterallyTrue(raw) {
  const noComment = raw.replace(/\s#.*$/, "").trim();
  const expr = noComment.replace(/^["']|["']$/g, "").replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
  return expr.toLowerCase() === "true";
}

// `false`, `${{ false }}`, `'false'`, and any of those with a trailing YAML
// comment. Anything expression-shaped is NOT evaluated (documented residual).
export function isLiterallyFalse(raw) {
  const noComment = raw.replace(/\s#.*$/, "").trim();
  const expr = noComment.replace(/^["']|["']$/g, "").replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
  return expr.toLowerCase() === "false";
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
    const key = ln.match(/^\s*(?:- )?["']?working-directory["']?:\s*(.+?)\s*$/);
    if (!key) continue;
    const ind = ln.length - ln.trimStart().length;
    const keyCol = /^\s*- /.test(ln) ? ind + 2 : ind; // `- working-directory:` → key sits 2 past the dash
    if (keyCol !== keyIndent) continue;
    // Strip a trailing YAML comment BEFORE reading the value. Without this,
    // `working-directory: packages/a2a # note` fails the value match and falls
    // back to "" — the REPO ROOT — which is how a package-local run could be
    // credited as the wholesale root suite.
    const raw = key[1].replace(/\s#.*$/, "").trim();
    // An expansion (`${{ env.WD }}`) names a directory this walk cannot know.
    // `unknown` is distinct from "" and disables every cwd-based judgement.
    if (hasUnquotedExpansion(raw) || raw === "") return { dir: "", unknown: true };
    return { dir: raw.replace(/^["']|["']$/g, "").replace(/^\.\//, "").replace(/\/$/, ""), unknown: false };
  }
  return { dir: "", unknown: false };
}

// Is the `run:` at `runIdx` a real STEP command? It must sit in a list item
// (a `- ` marker at `keyIndent - 2`) whose enclosing mapping key is `steps:`.
// Anything else — `env: { run: … }`, a `with:` input — is data, not a command.
export function runKeyIsStep(lines, runIdx, keyIndent) {
  const markerIndent = keyIndent - 2;
  if (markerIndent < 0) return false;
  let itemStart = -1;
  for (let k = runIdx; k >= 0; k--) {
    const ln = lines[k];
    if (ln.trim() === "") continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind === markerIndent && /^\s*- /.test(ln)) { itemStart = k; break; }
    if (ind < markerIndent) return false; // dedented out without finding a list item
  }
  if (itemStart === -1) return false;
  for (let k = itemStart - 1; k >= 0; k--) {
    const ln = lines[k];
    if (ln.trim() === "" || /^\s*#/.test(ln)) continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind >= markerIndent) continue; // still inside a previous sibling item
    // …and that `steps:` key must belong to a JOB — `jobs:` (0) → job name (2)
    // → `steps:` (4). A document-root `steps:` is not a workflow GitHub runs.
    return /^\s{4}steps:\s*$/.test(ln);
  }
  return false;
}

// Does the job holding the `run:` at `runIdx` run on a LINUX runner? Reads the
// job's `runs-on` (a scalar, a list, or a `${{ vars.X || 'ubuntu-latest' }}`
// expression). Only a value that clearly names ubuntu/linux counts; an
// unreadable or absent one is refused, because the runner decides the default
// shell and with it every failure rule this walk applies.
export function jobRunsOnLinux(lines, runIdx) {
  let jobStart = -1;
  for (let k = runIdx; k >= 0; k--) {
    const ln = lines[k];
    if (ln.trim() === "" || /^\s*#/.test(ln)) continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind === 2 && /^\s{2}["']?[A-Za-z_][\w-]*["']?:/.test(ln)) { jobStart = k; break; }
    if (ind === 0) return false;
  }
  if (jobStart === -1) return false;
  for (let k = jobStart + 1; k < lines.length; k++) {
    const ln = lines[k];
    if (ln.trim() === "") continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind <= 2) break; // next job
    if (ind !== 4) continue;
    const m = ln.match(/^\s*["']?runs-on["']?:\s*(.*)$/);
    if (!m) continue;
    let value = m[1].replace(/\s#.*$/, "").trim();
    // A list form puts the labels on following lines.
    if (value === "") {
      const rest = [];
      for (let j = k + 1; j < lines.length; j++) {
        const l2 = lines[j];
        if (l2.trim() === "") continue;
        if (l2.length - l2.trimStart().length <= 4) break;
        rest.push(l2);
      }
      value = rest.join(" ");
    }
    // `${{ vars.RUNNER || 'ubuntu-latest' }}` can resolve to anything, so an
    // expansion is not a demonstrable Linux runner.
    if (hasUnquotedExpansion(value)) return false;
    return /ubuntu|linux/i.test(value);
  }
  return false;
}

// The step-level `shell:` for the `run:` at `runIdx`, or "" when absent (the
// GitHub default). Same step-bounded, column-anchored lookup as
// `working-directory:` beside it.
export function stepShell(lines, runIdx, keyIndent) {
  const { start, end } = stepBounds(lines, runIdx, keyIndent);
  for (let k = start; k < end; k++) {
    const ln = lines[k];
    const m = ln.match(/^\s*(?:- )?["']?shell["']?:\s*(.+?)\s*$/);
    if (!m) continue;
    const ind = ln.length - ln.trimStart().length;
    const keyCol = /^\s*- /.test(ln) ? ind + 2 : ind;
    if (keyCol !== keyIndent) continue;
    return m[1].replace(/\s#.*$/, "").trim().replace(/^["']|["']$/g, "");
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
  // Same refusal the per-package parser makes: a `root:` / `test.dir` key
  // re-bases every include glob, so the file set this function reports would no
  // longer be the file set `pnpm test:root` runs.
  if (/(^|[\s{,])["']?(root|dir)["']?\s*:/.test(src) || testBlockHasShorthand(src, "dir")) {
    throw new Error(
      `${ROOT_VITEST_CONFIG}: sets a \`root:\`/\`test.dir:\` key, which re-bases every include/exclude glob. ` +
        "Refusing to guess; teach this parser the new shape.",
    );
  }
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

// Every tracked packages/** file vitest's DEFAULT include would discover:
// `**/*.{test,spec}.?(c|m)[jt]s?(x)`. `trackedTestPaths` deliberately collects
// only `*.test.*` — that is the shape a workflow PIN can name, which is all
// directions 1 and 2 need — but direction 3 governs what a package's suite
// CONTAINS, and a `packages/x/foo.spec.ts` is a suite vitest runs. Enumerating
// the narrower set here would leave those files outside the audit entirely,
// which is the silent-gap failure this direction exists to close.
export function packageTestFiles(repoRoot = REPO_ROOT) {
  const patterns = [];
  for (const kind of ["test", "spec"]) {
    for (const ext of ["ts", "tsx", "mts", "mtsx", "cts", "ctsx", "js", "jsx", "mjs", "mjsx", "cjs", "cjsx"]) {
      patterns.push(`${PACKAGE_DIR}/**/*.${kind}.${ext}`);
    }
  }
  const res = spawnSync("git", ["ls-files", ...patterns], { cwd: repoRoot, encoding: "utf8" });
  const out = [];
  if (res.status === 0 && res.stdout) {
    for (const line of res.stdout.split("\n")) {
      const t = line.trim();
      if (t && !t.includes("/node_modules/")) out.push(t);
    }
  }
  return out.sort();
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

// ---------------------------------------------------------------------------
// Direction 3 — every packages/** suite is executed by SOMETHING (cinatra#2439)
// ---------------------------------------------------------------------------

/** The workspace tree this direction governs. */
export const PACKAGE_DIR = "packages";
/** The machine-readable no-runner exception ledger. */
export const PACKAGE_EXCEPTIONS_FILE = "scripts/audit/package-suite-runner-exceptions.json";
/** Per-package vitest config filename (relative to the package dir). */
export const PACKAGE_VITEST_CONFIG = "vitest.config.ts";

// The NON-UNIT tiers. Direction 3 governs the UNIT tier — the files a package's
// own default `vitest.config.ts` discovery matches — which is the boundary
// cinatra#2439 draws ("excluding integration/e2e/manual tiers"). These three
// suffix families are the only non-unit shapes the workspace uses; each needs a
// live DB, a Docker host, or a live Graphiti, so each already runs (where it
// runs at all) under its OWN config in its OWN job:
//
//   *.integration.test.ts/.tsx  packages/agents → the `agents-integration-db`
//                               job (Postgres service, vitest.integration.config.ts);
//                               packages/dashboards → the DASH_DB_IT arm;
//                               host tier → `extension-lifecycle-db-tests`.
//   *.e2e.test.ts               packages/execution-plane → execution-plane-e2e.yml
//                               (real Docker batteries).
//   *.manual.test.ts            run by hand against a live Graphiti; self-skips
//                               without one.
//
// Naming them HERE, rather than letting them fall out of the governed set by
// omission, is the point: the boundary is a written decision this file states
// once, and a NEW non-unit shape does not silently inherit the exemption — it
// is simply not in this list, so it is governed like a unit suite until someone
// adds it here on purpose. And the exemption is CONDITIONAL: a tier file that a
// runner does execute is still credited as covered (see auditPackageSuiteRunners),
// so this list can only ever exempt a file, never hide one that runs.
export const NON_UNIT_TIER_PATTERNS = Object.freeze([
  "**/*.integration.test.ts",
  "**/*.integration.test.tsx",
  "**/*.e2e.test.ts",
  "**/*.manual.test.ts",
]);

/** Is `file` a non-unit tier file (see NON_UNIT_TIER_PATTERNS)? */
export function isNonUnitTierFile(file, patterns = NON_UNIT_TIER_PATTERNS) {
  return patterns.some((g) => globToRegExp(g).test(file));
}

// vitest 4's own defaults, for a package that ships NO config of its own
// (packages/webhooks, packages/streams, packages/artifacts, …). Copied from
// vitest/dist/chunks/defaults — `defaultInclude` is
// `["**/*.{test,spec}.?(c|m)[jt]s?(x)"]` and `defaultExclude` is
// `["**/node_modules/**", "**/.git/**"]`.
//
// The include glob is deliberately NOT pushed through globToRegExp: that
// converter implements `**`, `*`, `?` and `{a,b}` only and REFUSES extglob
// (`?(c|m)`) and character classes (`[jt]`) rather than mis-modelling them.
// Every extension `trackedTestPaths` collects (.ts/.tsx/.mjs/.mts/.js) matches
// the default glob, so the honest model is "every tracked test file under the
// package dir", stated once here instead of smuggled through a glob.
export const VITEST_DEFAULT_GLOBS = Object.freeze({
  include: null, // null === vitest's default include (every tracked test file)
  exclude: Object.freeze(["**/node_modules/**", "**/.git/**"]),
});

// Read a vitest config's `test.include` / `test.exclude`, with per-package
// tolerances the ROOT parser does not need:
//   - a MISSING `include` or `exclude` falls back to vitest's default, rather
//     than being an error (most package configs omit `exclude`);
//   - a top-level `root:` key is REFUSED, because it re-bases every glob and
//     this parser resolves globs against the package dir. packages/mcp-server
//     sets `root: repoRoot` today; its suites ride the ROOT include, so nothing
//     asks this function about them — but the day something does, a refusal is
//     the correct answer and a silent mis-resolution is not.
export function parseVitestTestGlobs(configPath, text) {
  let src;
  if (text !== undefined) src = text;
  else if (!existsSync(configPath)) {
    // `vitest.config.ts` is absent — but vitest also honours .mts/.js/.mjs/.cts
    // and the vite.config.* family. Falling straight through to "no config ⇒
    // vitest's defaults ⇒ discovers everything" while such a file sits on disk
    // would credit whatever it narrows away. Refuse; nothing in this repo has
    // one, so teaching the parser is the fix if that ever changes.
    const rival = findRivalVitestConfig(configPath);
    if (rival) {
      throw new Error(
        `${rival}: a vitest/vite config this parser does not read. It governs discovery for this package ` +
          `instead of ${PACKAGE_VITEST_CONFIG}. Refusing to assume vitest's defaults; teach the parser the new shape.`,
      );
    }
    return { include: null, exclude: [...VITEST_DEFAULT_GLOBS.exclude] };
  }
  else src = readFileSync(configPath, "utf8");
  src = stripLineComments(src);
  if (/(^|[\s{,])["']?(root|dir)["']?\s*:/.test(src) || testBlockHasShorthand(src, 'dir')) {
    throw new Error(
      `${configPath}: sets a \`root:\`/\`test.dir:\` key, which re-bases every include/exclude glob. ` +
        "This parser resolves globs against the package directory. Refusing to guess; teach it the new shape.",
    );
  }
  // A `include:` that is NOT an array literal (a call, an identifier, a spread)
  // would fall through extractOptionalArrayLiteral as "absent" and be read as
  // vitest's default — i.e. "this package discovers EVERYTHING", which credits
  // files a narrower computed include may never run. Refuse instead.
  // `test:` must be an OBJECT LITERAL this parser can read. `test: sharedTest`
  // (an imported or computed config) carries include/exclude values that never
  // appear in this file, so falling through to "no keys ⇒ vitest's defaults"
  // would claim the package discovers everything.
  const testKey = /(^|[\s{,])["']?test["']?\s*[:,}]/.test(src); // `test:` OR the `{ test }` shorthand
  if (testKey && !/(^|[\s{,])["']?test["']?\s*:\s*\{/.test(src)) {
    throw new Error(
      `${configPath}: \`test\` is not an object literal. Refusing to guess what it discovers; ` +
        "teach this parser the new shape.",
    );
  }
  // …and each of include/exclude, WHERE PRESENT, must be an array literal.
  // A computed value (`exclude: exclusions`) or an ES shorthand (`{ include }`)
  // would otherwise read as ABSENT and fall back to vitest's defaults — which
  // for `include` means "discovers everything" and for `exclude` means "excludes
  // nothing". Both over-state coverage, so both refuse.
  for (const key of ["include", "exclude"]) {
    const present = new RegExp(`(^|[\\s{,])["']?${key}["']?\\s*[:,}]`).test(src);
    const literal = new RegExp(`(^|[\\s{,])["']?${key}["']?\\s*:\\s*\\[`).test(src);
    if (present && !literal) {
      throw new Error(
        `${configPath}: \`test.${key}\` is not an array literal. Refusing to guess what it discovers; ` +
          "teach this parser the new shape.",
      );
    }
  }
  const includeBody = extractOptionalArrayLiteral(src, "include", configPath);
  const excludeBody = extractOptionalArrayLiteral(src, "exclude", configPath);
  // Conditional spreads are folded into EXCLUDE (both branches — the more-is-
  // excluded reading is fail-closed) but REFUSED in INCLUDE, where folding both
  // branches would UNION them and credit files only one branch discovers. Same
  // asymmetry the root parser already enforces.
  const include =
    includeBody === null ? null : parseArrayElements(includeBody, "include", { conditionalSpreads: false });
  const exclude =
    excludeBody === null
      ? [...VITEST_DEFAULT_GLOBS.exclude]
      : parseArrayElements(excludeBody, "exclude", { conditionalSpreads: true });
  if (include !== null && include.length === 0) {
    throw new Error(`${configPath}: parsed an EMPTY test.include — refusing.`);
  }
  return { include, exclude };
}

// Is `key` present as an ES SHORTHAND property (`test: { dir, include: […] }`)
// inside the config's `test: { … }` body? Scoped to that body deliberately: a
// bare `root` elsewhere is almost always a local variable — every package config
// that aliases paths writes `path.join(root, "…")` — and treating one as a
// config key would refuse a perfectly ordinary file.
export function testBlockHasShorthand(src, key) {
  const at = src.search(/(^|[\s{,])["']?test["']?\s*:\s*\{/);
  if (at === -1) return false;
  const open = src.indexOf("{", at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return false;
  return new RegExp(`(^|[\\s{,])["']?${key}["']?\\s*[,}]`).test(src.slice(open + 1, end));
}

// `extractArrayLiteral`, but an ABSENT key returns null instead of throwing.
// A DUPLICATED key still throws: two `include: [` arrays in one config means
// this parser cannot tell which one governs, and picking either is a guess.
export function extractOptionalArrayLiteral(src, key, label = ROOT_VITEST_CONFIG) {
  const re = new RegExp(`(^|[\\s{,])["']?${key}["']?\\s*:\\s*\\[`, "g");
  const starts = [];
  let m;
  while ((m = re.exec(src)) !== null) starts.push(m.index + m[0].length - 1);
  if (starts.length === 0) return null;
  if (starts.length > 1) {
    throw new Error(
      `${label}: expected at most one \`${key}: [\` — found ${starts.length}. ` +
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
  throw new Error(`${label}: unbalanced \`${key}: [\` array.`);
}

// A vitest/vite config in the same directory under a filename this parser does
// not read. Returns its path, or null.
export function findRivalVitestConfig(configPath) {
  const dir = dirname(configPath);
  for (const base of ["vitest.config", "vite.config"]) {
    for (const ext of ["ts", "mts", "cts", "js", "mjs", "cjs"]) {
      const candidate = join(dir, `${base}.${ext}`);
      if (candidate !== configPath && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Every repo-relative test path a WHOLESALE run of `pkgDir` would execute.
// `include: null` means vitest's default glob, which matches every tracked test
// file under the package (see VITEST_DEFAULT_GLOBS).
export function packageDiscoverySet(pkgDir, tracked, repoRoot = REPO_ROOT) {
  const globs = parseVitestTestGlobs(join(repoRoot, pkgDir, PACKAGE_VITEST_CONFIG));
  const out = new Set();
  const prefix = pkgDir + "/";
  for (const p of tracked) {
    if (!p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    const included = globs.include === null ? true : globs.include.some((g) => globToRegExp(g).test(rel));
    if (!included) continue;
    if (globs.exclude.some((g) => globToRegExp(g).test(rel))) continue;
    out.add(p);
  }
  return out;
}

// Quote-aware word split. The older direction-1/2 walks split on /\s+/, which
// is sound for the shapes they read (bare paths and flags) but wrong for a
// quoted value containing spaces — and one such value is load-bearing here:
//
//   pnpm --filter @cinatra-ai/execution-plane run test \
//     --outputFile.json="${{ github.workspace }}/execution-plane-unit-report.json"
//
// A naive split turns that into three tokens, two of which look like POSITIONAL
// operands, so a genuinely wholesale run reads as a narrowed one and 36 real
// suites report as unrun. A `${{ … }}` GitHub expression is kept atomic for the
// same reason even when it is not quoted.
export function shellTokens(text) {
  const out = [];
  let buf = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === "\\") buf += text[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "\\") {
      buf += c + (text[++i] ?? "");
      continue;
    }
    if (text.slice(i, i + 3) === "${{") {
      const end = text.indexOf("}}", i);
      const stop = end === -1 ? text.length : end + 2;
      buf += text.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (buf) out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}

// pnpm words that mean "run a BINARY", not "run a package script". Reaching one
// of these ends the script-invocation walk: `pnpm exec vitest run` is a runner
// invocation (handled by runnerArgv), never a `vitest` script.
const PM_BINARY_WORDS = new Set(["exec", "npx", "dlx", "command", "create", "dc"]);
// pnpm launcher flags whose value names a DIRECTORY the command runs in.
const PM_DIR_FLAGS = new Set(["-C", "--dir", "--prefix", "--cwd"]);
// `pnpm -w test` / `pnpm --workspace-root run test` run the WORKSPACE ROOT's
// script, whatever directory the step sits in. Treated as a selector naming the
// root so the `packages/` prefix check rejects it, rather than silently
// crediting the cwd's package for a suite that never ran.
const PM_ROOT_FLAGS = new Set(["-w", "--workspace-root"]);
// …and whose value names a workspace PACKAGE.
const PM_FILTER_FLAGS = new Set(["--filter", "-F"]);

// The package directory a segment's command runs in: an explicit `--filter
// <name>` (resolved through the workspace map) or `-C <dir>` beats the carried
// cwd. Returns null — credit NOTHING — in three cases:
//   - a filter naming a package this map does not know (a glob or path filter);
//   - MORE THAN ONE selector (`pnpm -C packages/llm --filter @x/objects test`
//     runs objects; taking the first match would credit llm, which is a wrong
//     package, not merely a missing one);
//   - a selector whose value carries an unquoted expansion, so this walk cannot
//     know which package it names.
// The caller must NOT fall back to the cwd on null.
export function segmentTargetDir(seg, cwd, pkgDirs) {
  const toks = shellTokens(stripShellComment(seg).trim());
  const selected = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const eq = t.match(/^(-{1,2}[\w-]+)=(.*)$/);
    const name = eq ? eq[1] : t;
    const rawValue = eq ? eq[2] : (toks[i + 1] ?? "");
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (PM_FILTER_FLAGS.has(name)) {
      if (hasUnquotedExpansion(rawValue)) return null;
      selected.push(pkgDirs.has(value) ? pkgDirs.get(value) : null);
      continue;
    }
    if (PM_DIR_FLAGS.has(name)) {
      if (hasUnquotedExpansion(rawValue)) return null;
      selected.push(value.replace(/^\.\//, "").replace(/\/$/, ""));
      continue;
    }
    if (PM_ROOT_FLAGS.has(name)) selected.push("");
  }
  if (selected.length > 1) return null; // ambiguous — refuse rather than pick
  if (selected.length === 1) return selected[0];
  return cwd;
}

// Does this segment invoke a package SCRIPT (`pnpm test`, `pnpm run test`,
// `pnpm --filter <pkg> run test`)? Returns { script, forwarded } or null.
// Deliberately narrow: a package-manager launcher must be reached first, and a
// binary word (`exec`, `dlx`, …) disqualifies, so only a real script call
// counts.
export function packageScriptInvocation(seg) {
  const trimmed = stripShellComment(seg).trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const toks = shellTokens(trimmed);
  if (hasTerminalFlag(toks)) return null;
  let pm = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = i > 0 ? toks[i - 1] : "";
    if (LAUNCHER_VALUE_FLAGS.has(prev)) continue; // this token is that flag's value
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // FOO=bar env assignment
    if (t.startsWith("-")) continue;
    if (/^\d+(?:\.\d+)?[smhd]?$/.test(t)) continue;
    if (t === "pnpm" || t === "npm" || t === "yarn" || t === "pnpx" || t === "corepack") {
      pm = true;
      continue;
    }
    if (PM_BINARY_WORDS.has(t)) return null; // runs a binary, not a script
    if (t === "run") {
      if (!pm) return null;
      continue;
    }
    if (RUNNER_LAUNCHERS.has(t)) continue;
    if (!pm) return null; // a bare command word with no package manager in front
    return { script: t, forwarded: argvUntilRedirect(toks.slice(i + 1)) };
  }
  return null;
}

// Every package directory some workflow runs WHOLESALE, mapped to the workflow
// files that do it. Two shapes count, and only these two:
//
//   a) a direct runner — `cd packages/x && pnpm exec vitest run [safe flags]`,
//      `pnpm -C packages/x exec vitest run …`, or a step-level
//      `working-directory:` doing the same — with NO positional operand, since
//      every positional narrows the run to a filter;
//   b) a package SCRIPT — `cd packages/x && pnpm test`, `pnpm --filter <pkg>
//      run test …` — whose package.json body is itself (a), and whose forwarded
//      arguments are wholesale-safe.
//
// A `--config` pointing anywhere but the package's own config disqualifies (b
// and a alike): that is a different suite wearing this package's name.
export function findWholesalePackageRuns(repoRoot = REPO_ROOT, workflowDir = WORKFLOW_DIR, knownPkgDirs) {
  const pkgDirs = knownPkgDirs ?? workspacePackageDirs(repoRoot);
  const runs = new Map(); // pkgDir → Set<workflow file>
  for (const { file, seg, cwd } of enforcingRunnerSegments(workflowDir)) {
    const target = segmentTargetDir(seg, cwd, pkgDirs);
    if (target === null) continue; // ambiguous/unknown target — credit nothing
    if (!target.startsWith(PACKAGE_DIR + "/")) continue;
    const invocation = runnerArgv(seg);
    let wholesale = false;
    if (invocation?.runner === "vitest") {
      wholesale = wholesaleVitestArgv(invocation.argv, PACKAGE_VITEST_CONFIG);
    } else {
      const scriptCall = packageScriptInvocation(seg);
      wholesale =
        scriptCall !== null &&
        wholesaleVitestArgv(scriptCall.forwarded, PACKAGE_VITEST_CONFIG) &&
        packageScriptIsWholesaleVitest(repoRoot, target, scriptCall.script, PACKAGE_VITEST_CONFIG);
    }
    if (!wholesale) continue;
    if (!runs.has(target)) runs.set(target, new Set());
    runs.get(target).add(file);
  }
  return runs;
}

// Every shell command in every workflow that can ACTUALLY TURN A CHECK RED,
// with the cwd it runs in. One definition of "enforcing", used by direction 3
// for wholesale package runs, for pins, and for the root-suite invocation, so
// the three cannot disagree about what counts as a gate.
//
// A command qualifies only when ALL of the following hold:
//   - its workflow fires on a CHANGE (pull_request / pull_request_target /
//     push / merge_group), with no path filter narrowing that trigger away;
//   - its step and job are not `continue-on-error: true`, and neither is
//     switched off by a literal-false `if:`;
//   - its shell has bash errexit semantics (the GitHub default, `bash`, `sh`);
//   - errexit is still ON where it sits (no `set +e` / `set +o errexit` above);
//   - nothing above it in the block ends execution (`exit`, `return`, `exec`);
//   - it is not in a pipeline, not backgrounded, and not in a list holding `||`;
//   - it carries no top-level redirection (which hides argv from the classifier);
//   - and its LIST can gate: a SIMPLE command fires errexit wherever it sits,
//     while an `&&`-list only gates as the block's LAST list.
//
// WHY THE LAST RULE IS NOT PEDANTRY — measured against `bash -e`, GitHub's
// default `run:` shell:
//   `false; echo x`                     → 1   (a simple command fires errexit)
//   `cd /tmp && false && cd /`          → 1   (…as the LAST list, its status is the step's)
//   `cd /tmp && false && cd /` + a line → 0   (errexit does NOT fire for an
//                                              `&&`-list, and the next line
//                                              overwrites its status)
// That is exactly why the four `cd <pkg> && vitest … && cd ../..` lines this
// repo carried could not fail their step — a real defect cinatra#2439 found by
// having to model this, and fixed in the same change.
export function* enforcingRunnerSegments(workflowDir = WORKFLOW_DIR) {
  const files = readdirSync(workflowDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  for (const file of files) {
    const yamlText = readFileSync(join(workflowDir, file), "utf8");
    if (!workflowRunsOnChanges(yamlText)) continue;
    for (const { body, fold, baseCwd, baseCwdUnknown, nonBlocking, shell, isStep, linuxRunner } of extractRunBlocks(yamlText)) {
      if (!isStep || nonBlocking) continue;
      // An explicit `shell:` overrides the runner default, so a modelled shell
      // on a Windows runner is still fine; an OMITTED shell is only `bash -e`
      // on Linux.
      if (!linuxRunner && (shell === "" || shell === undefined)) continue;
      if (!isErrexitBashShell(shell)) continue;
      let normalized = body.replace(/\\[ \t]*\n/g, " ");
      if (fold === "folded") normalized = normalized.replace(/\n+/g, " ");
      yield* enforcingSegmentsInBlock(normalized, baseCwdUnknown ? null : baseCwd, file);
    }
  }
}

// The per-block half of the rules above. `cwd` is `null` when a `cd` this walk
// could not follow makes the directory unknowable — distinct from `""` (the
// repo root), and the callers must not fall back to a guess.
export function* enforcingSegmentsInBlock(script, baseCwd = "", file = "") {
  const lists = groupShellLists(splitShellCommands(script));
  const lastIdx = lists.length - 1;
  let cwd = baseCwd;
  let errexit = true;
  let prevTerminator = "";
  for (const [i, list] of lists.entries()) {
    const cmds = list.commands;
    // `exit`/`return`/`exec <cmd>` ends the block wherever it sits, not only at
    // the head of a list: `true && exit 0 && node --test x` reaches the `exit`
    // and never the runner. `trap` is refused for the same reason one level
    // out — `trap "exit 0" ERR` turns every later failure into a green step,
    // and this walk models no traps at all.
    if (cmds.some((c) => /^(exit|return|exec|trap)\b/.test(stripEnvPrefix(c.text)))) return;
    // Shell CONTROL constructs (`if … then … fi`, loops, `case`, a brace or
    // subshell group) put commands on paths this flat walk does not follow —
    // `if false; then pnpm test; fi` runs nothing and exits 0. There is no
    // partial credit to be had here, so the whole block is abandoned.
    if (cmds.some((c) => isShellControlCommand(c.text))) return;
    // …and an errexit change anywhere in the list takes effect from there on.
    let setSeen = false;
    for (const c of cmds) {
      const st = errexitSetting(c.text.trim());
      if (st !== null) {
        errexit = st;
        setSeen = true;
      }
    }
    if (setSeen) continue;
    // A `cd` in a PIPELINE or a background job runs in a SUBSHELL, so the
    // parent's cwd is untouched; a `cd` in a list holding `||` may not have run
    // at all. Either way the cwd from here on is unknowable.
    // A pipeline puts BOTH sides in subshells, so a `cd` on either end of a `|`
    // leaves the parent's cwd alone (`true | cd packages/agents` → pwd unchanged),
    // and a backgrounded `cd packages/agents & wait` likewise. `prevTerminator`
    // is what catches the right-hand side, which its own terminator cannot see.
    const unreliable =
      list.terminator === "|" ||
      prevTerminator === "|" ||
      list.terminator === "&" ||
      cmds.some((c) => c.op === "||" || hasTopLevelBackground(c.text));
    prevTerminator = list.terminator;
    for (const [j, { text }] of cmds.entries()) {
      const cdMatch = stripEnvPrefix(text).match(/^cd\s+(\S+)/);
      if (!cdMatch) continue;
      // A `cd` behind ANY operator may not have run: `test -d x && cd ../a2a`
      // leaves the shell where it was when the test fails. Only the FIRST
      // command of a list is unconditional, so anything later makes the cwd
      // unknowable rather than moved.
      if (unreliable || j > 0 || hasUnquotedExpansion(cdMatch[1])) {
        cwd = null;
        continue;
      }
      const dir = cdMatch[1];
      if (dir === "../.." || dir === "../../" || dir.startsWith("/")) cwd = "";
      else if (cwd === null) cwd = null;
      else if (dir === "..") cwd = posix.dirname(cwd || ".") === "." ? "" : posix.dirname(cwd);
      else cwd = cwd ? posix.join(cwd, dir) : dir;
    }
    if (!errexit || unreliable) continue;
    const isSimple = cmds.length === 1;
    if (!isSimple && i !== lastIdx) continue;
    for (const { text } of cmds) {
      const seg = text.trim();
      if (!seg) continue;
      // A redirection hides operands from the argv classifier; a background `&`
      // detaches the command so its exit status never becomes the step's
      // (`bash -e -c 'false & wait'` exits 0, measured).
      if (hasTopLevelRedirect(seg) || hasTopLevelBackground(seg)) continue;
      yield { file, seg, cwd };
    }
  }
}

// Words that open (or belong to) a shell control construct. Reaching one means
// this flat command walk can no longer say which commands execute, so it stops.
export const SHELL_CONTROL_WORDS = new Set([
  "if", "then", "elif", "else", "fi", "while", "until", "for", "do", "done",
  "case", "esac", "select", "function", "{", "}", "(", ")",
]);

// Does this command open a control construct or a FUNCTION DEFINITION? A
// definition is the sharpest case: `demo() {` … `}` never runs its body, and
// the closing brace arrives after the walk would already have credited the
// runner inside it.
export function isShellControlCommand(text) {
  const t = stripEnvPrefix(text);
  if (t === "") return false;
  const first = t.split(/\s+/)[0];
  if (SHELL_CONTROL_WORDS.has(first)) return true;
  return /^[\w.-]+\s*\(\s*\)/.test(t) || /^function\b/.test(t);
}

// Group `splitShellCommands` output into LISTS: runs of commands joined by
// `&&`/`||`, each ended by a newline, `;`, `|` or `&`. `op` on a command is the
// operator that joins it to the NEXT command in the same list.
export function groupShellLists(commands) {
  const lists = [];
  let current = [];
  let pendingOp = null; // an `&&`/`||` whose right operand is on the NEXT line
  for (const { text, sep } of commands) {
    // `true ||` then a newline then `pnpm test:root` is ONE list: the shell
    // continues after a trailing `&&`/`||`. Reading the newline as a list break
    // would hand the short-circuited command its own gating list.
    if (pendingOp !== null && text.trim() === "" && sep === "\n") continue;
    if (pendingOp !== null) {
      current.push({ text, op: sep === "&&" || sep === "||" ? sep : null });
      pendingOp = sep === "&&" || sep === "||" ? sep : null;
      if (pendingOp !== null) continue;
      if (current.some((c) => c.text.trim())) lists.push({ commands: current, terminator: sep });
      current = [];
      continue;
    }
    if (sep === "&&" || sep === "||") {
      current.push({ text, op: sep });
      pendingOp = sep;
      continue;
    }
    current.push({ text, op: null });
    if (current.some((c) => c.text.trim())) lists.push({ commands: current, terminator: sep });
    current = [];
  }
  if (current.some((c) => c.text.trim())) lists.push({ commands: current, terminator: "" });
  return lists;
}

// `set -e` / `set +e` in every spelling bash accepts, including the long
// `set -o errexit` form. Returns true (on), false (off) or null (not a `set`
// that touches errexit).
export function errexitSetting(command) {
  const t = stripEnvPrefix(command.trim());
  if (!/^set\b/.test(t)) return null;
  // EVERY operand is read, not just the first: `set -x +e` turns tracing on and
  // errexit OFF, and matching only `-x` would miss that entirely. `-o errexit`
  // / `+o errexit` are the long spellings of the same switch.
  let state = null;
  const toks = t.split(/\s+/).slice(1);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const m = tok.match(/^([+-])(.*)$/);
    if (!m) continue;
    if (m[2] === "o") {
      if (toks[i + 1] === "errexit") {
        state = m[1] === "-";
        i++;
      }
      continue;
    }
    if (m[2].includes("e")) state = m[1] === "-";
  }
  return state;
}

// Drop leading `FOO=bar` env assignments: `X=1 exit 0` is still an `exit`.
export function stripEnvPrefix(command) {
  // Quote-aware, because `FOO="a b" exit 0` splits into three words only if the
  // quoted value is kept whole — a naive scan hands back `b" exit 0` and the
  // `exit` is never seen. The command WORD is then unquoted too (`"exit" 0`),
  // and the `command` / `builtin` prefixes are stepped over: `command exit 0`
  // and `command set +e` are an `exit` and a `set` like any other.
  const toks = shellTokens(command.trim());
  let i = 0;
  for (;;) {
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    if (i < toks.length && ["command", "builtin", "eval", "nohup"].includes(unquoteWord(toks[i]))) {
      i++;
      continue;
    }
    break;
  }
  if (i >= toks.length) return "";
  return [unquoteWord(toks[i]), ...toks.slice(i + 1)].join(" ");
}

/** Strip surrounding quotes from a single shell word. */
export function unquoteWord(word) {
  return word.replace(/^["']|["']$/g, "");
}

// Does this `shell:` value give bash-with-errexit failure semantics? GitHub's
// DEFAULT for `run` on Linux is `bash -e {0}`; an explicit `shell: bash` is
// `bash --noprofile --norc -eo pipefail {0}` and `shell: sh` is `sh -e {0}`.
// Everything else — `pwsh`, `python`, `cmd`, or a custom template such as
// `bash {0}` (no `-e`) — either has different semantics or none this walk
// models, so it is refused rather than analysed as if it were bash.
export function isErrexitBashShell(shell) {
  if (shell === undefined || shell === null || shell === "") return true; // the default
  return shell === "bash" || shell === "sh";
}

// Does this workflow run on a CHANGE (so its jobs put a check on a PR or a main
// push)? Read off the top-level `on:` block by key, at the two shapes GitHub
// accepts — a mapping (`on:` then indented keys) and a list/inline
// (`on: [push, pull_request]`). Unparseable or absent `on:` reads as NOT
// change-triggered, the fail-closed direction: the cost is a suite reported as
// unrun (loud, fixable) instead of an unrun suite reported as covered.
export function workflowRunsOnChanges(yamlText) {
  const CHANGE_TRIGGERS = ["pull_request", "pull_request_target", "push", "merge_group"];
  const lines = yamlText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) continue; // a full-line YAML comment
    const m = lines[i].match(/^(?:on|"on"|'on'|true):\s*(.*)$/);
    if (!m) continue;
    const inline = m[1].replace(/#.*$/, "").trim();
    if (inline) {
      // `on: push` or `on: [push, pull_request]`. A flow MAPPING
      // (`on: { pull_request: { paths: [...] } }`) carries its filter inline, so
      // any `paths` here disqualifies the whole line — fail closed.
      if (/\b(paths(-ignore)?|branches-ignore)\b/.test(inline)) return false;
      const names = inline.replace(/^[[{]|[\]}]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").replace(/:.*$/, ""));
      return names.some((n) => CHANGE_TRIGGERS.includes(n));
    }
    let current = null;
    let filtered = false;
    for (let k = i + 1; k < lines.length; k++) {
      const ln = lines[k];
      if (ln.trim() === "" || /^\s*#/.test(ln)) continue;
      const ind = ln.length - ln.trimStart().length;
      if (ind === 0) break; // left the `on:` mapping
      if (ind === 2) {
        // A trigger is only useful here if it fires on EVERY change to the
        // package being credited. `paths:`/`paths-ignore:` narrows it to a file
        // set this gate does not evaluate, so such a trigger is not counted —
        // fail-closed, and true of no crediting workflow in this repo today.
        if (current !== null && !filtered) return true;
        const key = ln.trim().replace(/:.*$/, "").replace(/^-\s*/, "").replace(/^["']|["']$/g, "");
        current = CHANGE_TRIGGERS.includes(key) ? key : null;
        // `pull_request: { paths: ["docs/**"] }` — the filter rides the SAME
        // line in flow style, where the block-style scan below never sees it.
        filtered = current !== null && /\b(paths(-ignore)?|branches-ignore)\b/.test(ln);
        continue;
      }
      if (current !== null && /^\s*["']?(paths(-ignore)?|branches-ignore)["']?\s*:/.test(ln)) filtered = true;
    }
    return current !== null && !filtered;
  }
  return false;
}

// Direction 3's own view of the pins: only those that sit in an ENFORCING
// command (see enforcingRunnerSegments). Directions 1 and 2 keep using the
// unfiltered sets — an existence check does not care whether a step blocks, and
// #2434's audit-suite contract is unchanged — but coverage does care: a
// `node --test` pin in a `continue-on-error` step, or in a manual-only
// workflow, proves the file exists and nothing more.
export function resolveEnforcedPins(repoRoot = REPO_ROOT, workflowDir = WORKFLOW_DIR, knownPaths, knownPkgDirs) {
  const tracked = knownPaths ?? trackedTestPaths(repoRoot);
  const pkgDirs = knownPkgDirs ?? workspacePackageDirs(repoRoot);
  const resolved = new Set();
  const nodeExact = new Set();
  for (const { seg, cwd } of enforcingRunnerSegments(workflowDir)) {
    if (cwd === null) continue;
    for (const { token, cwd: segCwd, runner, narrowed } of pinnedTestsInBlock(seg, "literal", cwd, pkgDirs)) {
      const norm = token.replace(/^\.\//, "");
      if (runner === "node") {
        const exact = segCwd ? posix.join(segCwd, norm) : norm;
        if (existsSync(join(repoRoot, exact))) {
          resolved.add(exact);
          if (!narrowed) nodeExact.add(exact);
        }
        continue;
      }
      // A vitest pin only reaches files the config governing ITS cwd discovers.
      // A repo-root `vitest run packages/foo/dark.test.ts` is filtered by the
      // ROOT config, not by packages/foo's — so it is not evidence about
      // packages/foo at all, and direction 3 records it only when the run is
      // scoped INSIDE the package (rule 1 already covers the root-include case).
      if (!segCwd || !segCwd.startsWith(PACKAGE_DIR + "/")) continue;
      // …and a narrowing/vacuous flag makes even that prove nothing.
      if (invocationCannotProveExecution(seg)) continue;
      const hits = tracked.filter(
        (q) => q === posix.join(segCwd, norm) || (q.startsWith(segCwd + "/") && q.endsWith("/" + norm)),
      );
      for (const h of hits) resolved.add(h);
    }
  }
  return { resolved, nodeExact };
}

// Flags that make a PINNED run prove nothing: `--exclude` can carve the pinned
// file back out, and `--passWithNoTests` turns "selected zero files" into a
// green exit. Together they are how a pin can name a file and execute nothing.
export function invocationCannotProveExecution(seg) {
  // Token-wise and UNQUOTED: `"--exclude=live.test.ts"` is the same flag as its
  // bare spelling, and a substring scan over the raw segment misses it. `-t` /
  // `--testNamePattern` can match nothing, and `--config`/`-c` swaps in a
  // configuration whose exclude may carve the pinned file straight back out.
  const NARROWING = new Set([
    "--exclude", "--passWithNoTests", "--changed", "--shard", "--testNamePattern", "-t",
    "--project", "--dir", "--root", "--config", "-c", "--related", "--bail",
  ]);
  return shellTokens(stripShellComment(seg)).some((raw) => NARROWING.has(unquoteWord(raw).split("=")[0]));
}

// Is the wholesale root suite invoked from an ENFORCING command at the repo
// root? Direction 2 asks only whether SOME workflow invokes it
// (findRootSuiteInvocations); direction 3 credits ~120 packages/** files to
// that one step, so it asks the stronger question.
export function rootSuiteIsEnforced(workflowDir = WORKFLOW_DIR, repoRoot = REPO_ROOT) {
  if (!rootSuiteScriptRunsVitest(repoRoot)) return false;
  for (const { seg, cwd } of enforcingRunnerSegments(workflowDir)) {
    if (cwd === "" && invokesRootSuite(seg)) return true;
  }
  return false;
}

// Read + VALIDATE the no-runner exception ledger. Every field is mandatory and
// checked; an unparseable or malformed ledger THROWS rather than degrading to
// "no exceptions" (which would fail the gate loudly) or to "everything is
// excepted" (which would fail it silently open). The issue link is required and
// shape-checked because a quarantine without a filed follow-up is just an
// unrun test with better paperwork — the contract cinatra#2439 sets is that
// quarantine is the ONLY no-runner state and it always carries an issue.
export function readPackageSuiteExceptions(repoRoot = REPO_ROOT, text) {
  const file = join(repoRoot, PACKAGE_EXCEPTIONS_FILE);
  let raw = text;
  if (raw === undefined) {
    if (!existsSync(file)) return [];
    raw = readFileSync(file, "utf8");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${PACKAGE_EXCEPTIONS_FILE}: not valid JSON — ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.exceptions)) {
    throw new Error(`${PACKAGE_EXCEPTIONS_FILE}: expected an object with an \`exceptions\` array.`);
  }
  const seen = new Set();
  const out = [];
  for (const [i, entry] of parsed.exceptions.entries()) {
    const at = `${PACKAGE_EXCEPTIONS_FILE}[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${at}: expected an object.`);
    }
    const { file: f, kind, issue, reason } = entry;
    if (typeof f !== "string" || !f.startsWith(PACKAGE_DIR + "/") || !/\.test\.(tsx|ts|mjs|mts|js)$/.test(f)) {
      throw new Error(`${at}: \`file\` must be a packages/** test path, got ${JSON.stringify(f)}.`);
    }
    if (seen.has(f)) throw new Error(`${at}: duplicate entry for ${f}.`);
    seen.add(f);
    // ONE decision kind may appear here. `main-only` is the OTHER contract
    // state and it is NOT an exception: a main-only suite still executes and
    // still reds its check, so it is detected as a real runner like any other.
    if (kind !== "quarantine") {
      throw new Error(`${at}: \`kind\` must be "quarantine" (the only no-runner state), got ${JSON.stringify(kind)}.`);
    }
    if (typeof issue !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(issue)) {
      throw new Error(`${at}: \`issue\` must be a GitHub issue URL, got ${JSON.stringify(issue)}.`);
    }
    if (typeof reason !== "string" || reason.trim().length < 20) {
      throw new Error(`${at}: \`reason\` must be a written sentence (>= 20 chars).`);
    }
    out.push({ file: f, kind, issue, reason });
  }
  return out;
}

// Direction 3: the verdict for every packages/** test file.
//
//   { ungated, exempt, staleExceptions, redundantExceptions }
//
// `ungated`  — no runner, no exception. HARD FAILURE.
// `exempt`   — no runner, named in the ledger with a filed issue.
// `stale…`   — a ledger entry whose file is gone.
// `redundant…` — a ledger entry for a file that IS executed: the quarantine it
//                advertises does not exist, so the ledger lies about CI's shape.
export function auditPackageSuiteRunners(repoRoot = REPO_ROOT, workflowDir = WORKFLOW_DIR, opts = {}) {
  const tracked = opts.tracked ?? trackedTestPaths(repoRoot);
  const pkgDirs = opts.pkgDirs ?? workspacePackageDirs(repoRoot);
  const globs = opts.globs ?? parseRootVitestTestGlobs(repoRoot);
  const pins = opts.pins ?? resolveEnforcedPins(repoRoot, workflowDir, tracked, pkgDirs);
  const wholesale = opts.wholesale ?? findWholesalePackageRuns(repoRoot, workflowDir, pkgDirs);
  const rootEnforced = opts.rootEnforced ?? rootSuiteIsEnforced(workflowDir, repoRoot);
  const exceptions = opts.exceptions ?? readPackageSuiteExceptions(repoRoot);
  const exceptionByFile = new Map(exceptions.map((e) => [e.file, e]));

  const packageFiles = opts.packageFiles ?? packageTestFiles(repoRoot);
  const discovery = new Map(); // pkgDir → Set<path>, computed lazily
  const discoveryFor = (pkgDir) => {
    if (!discovery.has(pkgDir)) discovery.set(pkgDir, packageDiscoverySet(pkgDir, tracked, repoRoot));
    return discovery.get(pkgDir);
  };

  const ungated = [];
  const exempt = [];
  const tierExcluded = [];
  const covered = new Set();
  for (const f of packageFiles) {
    const pkgDir = f.split("/").slice(0, 2).join("/");
    // 1. The wholesale ROOT run. Independent of the package's own config —
    //    the root include names these tiers by glob (packages/mcp-server,
    //    packages/sdk-extensions, …) and `pnpm test:root` executes them.
    if (rootEnforced && ridesRootVitestRun(f, globs)) {
      covered.add(f);
      continue;
    }
    // 2. An exact `node --test <path>` pin runs the file whatever any vitest
    //    config says, so it is checked before the discovery-set gate below.
    if (pins.nodeExact.has(f)) {
      covered.add(f);
      continue;
    }
    // 3. Everything else routes through vitest, which applies the governing
    //    config's include/exclude BEFORE any CLI positional. So a file the
    //    package config does not discover cannot be reached by a wholesale run
    //    OR by a pin — the pin's positional would select nothing and the step
    //    would still pass. Skipping this check is precisely the fail-OPEN
    //    reading direction 2 already refuses for the root config.
    const discovered = discoveryFor(pkgDir).has(f);
    if (discovered && (wholesale.has(pkgDir) || pins.resolved.has(f))) {
      covered.add(f);
      continue;
    }
    // 4. NOT covered. A non-unit tier file (integration / e2e / manual) leaves
    //    the governed set HERE, after every coverage route has been tried — so
    //    the tier list can exempt an unrun file but can never hide one that
    //    runs, and a tier file is never reported as quarantined either.
    if (isNonUnitTierFile(f)) {
      tierExcluded.push(f);
      continue;
    }
    const entry = exceptionByFile.get(f);
    if (entry) exempt.push(entry);
    else ungated.push({ file: f, pkgDir, discovered, wholesale: wholesale.has(pkgDir) });
  }

  const trackedSet = new Set(tracked);
  const staleExceptions = exceptions.filter((e) => !trackedSet.has(e.file));
  const redundantExceptions = exceptions.filter((e) => covered.has(e.file));
  return { ungated, exempt, tierExcluded, staleExceptions, redundantExceptions, wholesale, packageFiles };
}


// ── Direction 4 — root integration tiers (cinatra#2936) ─────────────────────
//
// GOVERNED SET: every `*.config.ts` FILE under `vitest/integration/` — the tier
// directory; the repository root carries product files only. The FILE and not
// the script is the unit, because the file is the
// durable artifact — a tier whose script was renamed away is exactly as unrun
// as one whose step was deleted, and keying on the script would make the first
// case invisible.
//
// CREDITED only when a workflow segment that can ACTUALLY TURN A CHECK RED
// (`enforcingRunnerSegments` — the same definition directions 2 and 3 use, so
// the four cannot disagree about what a gate is) runs, at the repository root:
//   a) a root package script whose body is a WHOLESALE `vitest run --config
//      <that tier>` — `packageScriptIsWholesaleVitest`, so a script rewritten
//      to `true`, narrowed with a positional, or masked with `;` / `|` / `||`
//      / `&` stops being a runner; or
//   b) a direct `pnpm exec vitest run --config <that tier> [safe flags]`; or
//   c) an AGGREGATE script that reaches (a) — the closure below.
//
// The closure walks UPWARD from the tier: a script joins when its body is an
// unconditional `&&` chain (the one separator under which a failure both stops
// the chain and becomes the script's status) and one of its segments invokes a
// script already in the set. npm's implicit `pre*` / `post*` lifecycle edges are
// NOT modelled, and neither is a tier reached only through them — that direction
// costs a false RED a human fixes, never a false green.
//
// RESIDUALS, named. A step whose invocation carries a forwarded argument
// (`pnpm test:x --maxWorkers=2`) is NOT credited: `invokesRootSuite` requires
// the script name to be the last token, because a forwarded positional narrows
// the run and this walk cannot tell which is which. Again a false RED, fixed by
// writing the step bare. Everything `enforcingRunnerSegments` already refuses —
// a manual-only workflow, a `continue-on-error` step, a literal-`false` job, a
// non-bash shell — is refused here unchanged.
//
// And it INHERITS that walk's one residual that leans the other way, stated
// here rather than left to be rediscovered: a non-literal `if:` reads as
// EXECUTING (see the file header). So a tier pointed at a job guarded by, say,
// `if: github.event_name == 'workflow_dispatch'` inside a change-triggered
// workflow would be credited though that job never fires on a PR. Refusing
// non-literal `if:` instead would credit nothing at all — every gating job in
// this repository carries the docs-only skip condition — which is why
// directions 2 and 3 already read them this way, and why direction 4 does not
// diverge. The stopping rule the header states applies: teach the parser when
// the construct actually arrives in a reviewed workflow.
//
// THE LEDGER IS THE ONLY OTHER STATE. A tier with no runner must be named in
// ROOT_TIER_EXCEPTIONS_FILE with the slice that owns it and a written reason.
// The `slice` may well be a CLOSED issue, and that is precisely the shape this
// records: the tier shipped and its runner did not. There is no third state —
// and a ledger entry for a tier that IS run, or for a config that no longer
// exists, is itself a failure, so the list can only shrink honestly.
export const ROOT_TIER_EXCEPTIONS_FILE = "scripts/audit/root-tier-runner-exceptions.json";

// The location + naming convention every root tier follows: one
// `vitest/integration/<slice>.config.ts` per tier. The tiers left the repository
// root so the root carries product files only; the audit keys on the directory
// instead, and a tier file anywhere else is not a root tier.
export const ROOT_TIER_DIR = "vitest/integration";
export const ROOT_TIER_CONFIG_RE = /^vitest\/integration\/[A-Za-z0-9._-]+\.config\.ts$/;

/** Every root tier config file on disk, sorted. */
export function rootTierConfigs(repoRoot = REPO_ROOT) {
  const dir = join(repoRoot, ROOT_TIER_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => `${ROOT_TIER_DIR}/${f}`)
    .filter((f) => ROOT_TIER_CONFIG_RE.test(f))
    .sort();
}

/** The root package.json's scripts, or {} when it cannot be read. */
export function rootPackageScripts(repoRoot = REPO_ROOT) {
  try {
    return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))?.scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * The `--config` / `-c` values a command line names, unquoted.
 *
 * Both spellings and both forms (`--config x`, `--config=x`, `-c x`, `-c=x`) —
 * the same vocabulary `wholesaleVitestArgv` classifies, read here for the value
 * rather than for the verdict.
 */
export function vitestConfigTokens(cmd) {
  const toks = shellTokens(cmd);
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = unquoteWord(toks[i]);
    if (!t.startsWith("-")) continue;
    const eq = t.match(/^-{1,2}([\w.-]+)=(.*)$/);
    const name = eq ? eq[1] : t.replace(/^-+/, "");
    if (!VITEST_CONFIG_FLAGS.has(name)) continue;
    out.push(unquoteWord(eq ? eq[2] : (toks[i + 1] ?? "")));
  }
  return out;
}

/**
 * Does this argv name THIS tier's config explicitly?
 *
 * `wholesaleVitestArgv(argv, expected)` only checks a `--config` it FINDS: an
 * argv carrying none is wholesale for the config vitest would pick by default,
 * which for a repository-root run is `vitest.config.ts` — the root unit tier,
 * not a private tier. Directions 2 and 3 can leave that implicit because the
 * config they expect IS the default one; direction 4 cannot, so the flag must
 * be there and must name this tier. Reading the ARGV and not the segment text
 * also refuses a decoy — `echo --config <tier> && vitest run`, or an
 * `X=--config <tier>` env assignment in front of a bare run — where the token
 * appears beside an invocation that never receives it.
 */
export function argvNamesConfig(argv, config) {
  for (let i = 0; i < argv.length; i++) {
    const t = unquoteWord(argv[i]);
    if (!t.startsWith("-")) continue;
    const eq = t.match(/^-{1,2}([\w.-]+)=(.*)$/);
    const name = eq ? eq[1] : t.replace(/^-+/, "");
    if (!VITEST_CONFIG_FLAGS.has(name)) continue;
    if (unquoteWord(eq ? eq[2] : (argv[i + 1] ?? "")) === config) return true;
  }
  return false;
}

/**
 * A package script body as an unconditional `&&` chain of segments — or null
 * when any part of it masks a status or moves execution somewhere this walk
 * cannot follow. Same grammar as `packageScriptIsWholesaleVitest`, factored out
 * so the aggregate-script closure and the wholesale check cannot drift apart.
 */
export function scriptChainSegments(cmd) {
  if (typeof cmd !== "string") return null;
  if (hasUnquotedExpansion(cmd) || /[()]/.test(cmd) || hasTopLevelBackground(cmd)) return null;
  const commands = splitShellCommands(cmd);
  if (
    commands.some(
      (c) =>
        /^(exit|return|exec|trap|cd)\b/.test(stripEnvPrefix(c.text)) ||
        errexitSetting(c.text) !== null ||
        isShellControlCommand(c.text),
    )
  ) {
    return null;
  }
  const segs = [];
  for (const [i, { text, sep }] of commands.entries()) {
    const isLast = i === commands.length - 1;
    if (!(sep === "&&" || (isLast && sep === ""))) return null;
    const seg = text.trim();
    if (hasTopLevelRedirect(seg)) return null;
    if (seg) segs.push(seg);
  }
  return segs;
}

/**
 * Is THIS script a wholesale run of THIS tier?
 *
 * The chain rules are `scriptChainSegments`' (which are
 * `packageScriptIsWholesaleVitest`'s), and the accepted invocation must itself
 * name the tier config — see `argvNamesConfig` for why that is not implied.
 */
export function scriptRunsTierWholesale(repoRoot = REPO_ROOT, script, config, scripts) {
  const all = scripts ?? rootPackageScripts(repoRoot);
  const segs = scriptChainSegments(all[script]);
  if (segs === null) return false;
  return segs.some((seg) => {
    const invocation = runnerArgv(seg);
    return (
      invocation?.runner === "vitest" &&
      argvNamesConfig(invocation.argv, config) &&
      wholesaleVitestArgv(invocation.argv, config)
    );
  });
}

/**
 * Grow a set of root package scripts UPWARD through aggregate scripts.
 *
 * A script joins when its body is an unconditional `&&` chain — the one
 * separator under which a failure both stops the chain and becomes the script's
 * status — and one of its segments invokes a script already in the set. npm's
 * implicit `pre*` / `post*` lifecycle edges are NOT modelled, so a member
 * reached only through one is not credited: a false RED, never a false green.
 *
 * Shared by directions 4 and 5 so the two cannot disagree about what an
 * aggregate is. `refuse` lets a caller drop a segment BEFORE it is read as an
 * invocation; direction 4 passes none (its behaviour is unchanged), direction 5
 * passes `segmentHasCommandPrefix` — see `auditGateIsEnforced` for why.
 */
// The package-manager words that ARE the invocation rather than something in
// front of it. Everything else this file already steps over as a launcher is a
// WRAPPER — `env`, `cross-env`, `dotenv`, `nice`, `time`, `timeout`,
// `command`, `exec` — and every one of those can change which binary runs or
// what environment it starts in.
const PACKAGE_MANAGER_WORDS = new Set(["pnpm", "pnpx", "npm", "yarn", "corepack"]);

// The words that run the REST of the line with something changed in front of
// it. DERIVED from `RUNNER_LAUNCHERS` rather than listed by hand, so a launcher
// added there later is refused here the same day instead of quietly opening a
// door; the shell builtins `stripEnvPrefix` steps over are added to it.
export const COMMAND_PREFIX_WORDS = new Set([
  ...[...RUNNER_LAUNCHERS].filter((w) => !PACKAGE_MANAGER_WORDS.has(w)),
  "builtin",
  "eval",
  "nohup",
  "xargs",
  "sudo",
]);

/**
 * Does anything stand between the start of this segment and its command word —
 * an environment assignment, or one of the wrapper words above?
 *
 * Direction 5 refuses every one of them. The prefix is what decides WHICH
 * binary runs and HOW it starts, so a segment carrying one proves nothing about
 * whether the gate behind it ever executed.
 */
export function segmentHasCommandPrefix(seg) {
  const toks = shellTokens(stripShellComment(seg).trim());
  if (toks.length === 0) return false;
  const head = unquoteWord(toks[0]);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return true;
  return COMMAND_PREFIX_WORDS.has(head);
}

export function closeOverAggregateScripts(reaching, all, { refuse = () => false } = {}) {
  for (let grew = reaching.size > 0; grew; ) {
    grew = false;
    for (const [name, cmd] of Object.entries(all)) {
      if (reaching.has(name)) continue;
      const segs = scriptChainSegments(cmd);
      if (segs === null) continue;
      if (segs.some((seg) => !refuse(seg) && [...reaching].some((member) => invokesRootSuite(seg, member)))) {
        reaching.add(name);
        grew = true;
      }
    }
  }
  return reaching;
}

/** Every root package script that REACHES a tier config, transitively. */
export function scriptsReachingTier(repoRoot = REPO_ROOT, config, scripts) {
  const all = scripts ?? rootPackageScripts(repoRoot);
  const reaching = new Set();
  for (const name of Object.keys(all)) {
    if (scriptRunsTierWholesale(repoRoot, name, config, all)) reaching.add(name);
  }
  return closeOverAggregateScripts(reaching, all);
}

/** Does some enforcing workflow segment run this tier? */
export function rootTierIsEnforced(config, opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const workflowDir = opts.workflowDir ?? WORKFLOW_DIR;
  const reaching = opts.reaching ?? scriptsReachingTier(repoRoot, config, opts.scripts);
  const segments = opts.segments ?? [...enforcingRunnerSegments(workflowDir)];
  for (const { seg, cwd } of segments) {
    // A run inside another package is another package's suite; an UNKNOWN cwd
    // (`null`) is refused rather than assumed to be the root.
    if (cwd !== "") continue;
    for (const script of reaching) {
      if (invokesRootSuite(seg, script)) return true;
    }
    const invocation = runnerArgv(seg);
    if (
      invocation?.runner === "vitest" &&
      argvNamesConfig(invocation.argv, config) &&
      wholesaleVitestArgv(invocation.argv, config)
    ) {
      return true;
    }
  }
  return false;
}

// Read + VALIDATE the root-tier ledger, on the same terms as direction 3's:
// every field mandatory and checked, and a malformed ledger THROWS rather than
// degrading to "no exceptions" (a loud, wrong failure) or to "everything is
// excepted" (a silent, wrong pass).
export function readRootTierExceptions(repoRoot = REPO_ROOT, text) {
  const file = join(repoRoot, ROOT_TIER_EXCEPTIONS_FILE);
  let raw = text;
  if (raw === undefined) {
    if (!existsSync(file)) return [];
    raw = readFileSync(file, "utf8");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${ROOT_TIER_EXCEPTIONS_FILE}: not valid JSON — ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.exceptions)) {
    throw new Error(`${ROOT_TIER_EXCEPTIONS_FILE}: expected an object with an \`exceptions\` array.`);
  }
  const seen = new Set();
  const out = [];
  for (const [i, entry] of parsed.exceptions.entries()) {
    const at = `${ROOT_TIER_EXCEPTIONS_FILE}[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${at}: expected an object.`);
    }
    const { config, slice, reason } = entry;
    if (typeof config !== "string" || !ROOT_TIER_CONFIG_RE.test(config)) {
      throw new Error(`${at}: \`config\` must be a vitest/integration/<slice>.config.ts tier config, got ${JSON.stringify(config)}.`);
    }
    if (seen.has(config)) throw new Error(`${at}: duplicate entry for ${config}.`);
    seen.add(config);
    // The SLICE, not a follow-up: the issue whose work the tier is, and where
    // wiring it belongs. It may be closed — that is the state this records.
    if (typeof slice !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(slice)) {
      throw new Error(`${at}: \`slice\` must be a GitHub issue URL, got ${JSON.stringify(slice)}.`);
    }
    if (typeof reason !== "string" || reason.trim().length < 20) {
      throw new Error(`${at}: \`reason\` must be a written sentence (>= 20 chars).`);
    }
    out.push({ config, slice, reason });
  }
  return out;
}

// Direction 4's verdict for every root tier config.
//
// `ungated`   — no runner, no ledger entry. HARD FAILURE.
// `exempt`    — no runner, named in the ledger with its slice and a reason.
// `stale…`    — a ledger entry whose config file is gone.
// `redundant…`— a ledger entry for a tier a workflow DOES run: the ledger
//               describes a state CI is not in.
export function auditRootIntegrationTiers(repoRoot = REPO_ROOT, workflowDir = WORKFLOW_DIR, opts = {}) {
  const configs = opts.configs ?? rootTierConfigs(repoRoot);
  const scripts = opts.scripts ?? rootPackageScripts(repoRoot);
  const segments = opts.segments ?? [...enforcingRunnerSegments(workflowDir)];
  const exceptions = opts.exceptions ?? readRootTierExceptions(repoRoot);
  const byConfig = new Map(exceptions.map((e) => [e.config, e]));

  const enforced = [];
  const ungated = [];
  const exempt = [];
  for (const config of configs) {
    const reaching = [...scriptsReachingTier(repoRoot, config, scripts)].sort();
    if (rootTierIsEnforced(config, { repoRoot, workflowDir, scripts, segments, reaching: new Set(reaching) })) {
      enforced.push({ config, scripts: reaching });
      continue;
    }
    const entry = byConfig.get(config);
    if (entry) exempt.push(entry);
    else ungated.push({ config, scripts: reaching });
  }

  const present = new Set(configs);
  const enforcedSet = new Set(enforced.map((e) => e.config));
  return {
    tiers: configs,
    enforced,
    ungated,
    exempt,
    staleExceptions: exceptions.filter((e) => !present.has(e.config)),
    redundantExceptions: exceptions.filter((e) => enforcedSet.has(e.config)),
  };
}

// ── Direction 5 — plan (B) §6's own named gates (cinatra#2936) ──────────────
//
// THE CLAUSE, verbatim from the plan's Conformance block: "The lifecycle-screens
// epic's own gates — the one-card gate, the host-parity ratchet, the held-turn
// card contract — stay green through every wave."
//
// "Stay green" presupposes that something RUNS them. Two of the three were run:
// the host-parity ratchet's suite by its package's wholesale runner, the
// held-turn card contract's by the wholesale root suite. The third — the
// one-card gate — is an executable `scripts/audit/*.mjs` and NOT a test file,
// so it fell outside every direction above: direction 2 watches a gate's
// __tests__ SUITE, never whether a workflow runs the GATE. The gate could
// therefore go red and no check would move, which is the same vacuity class
// direction 4 closed for root tiers, arriving through one more door.
//
// GOVERNED SET: exactly the three artifacts the clause names, written out here.
// A LITERAL list and not a pattern, deliberately — the clause names three gates
// by hand, so the gate that holds the clause names the same three by hand. A
// fourth arrives when the plan says so, not when a filename happens to match.
//
// CREDITED, per kind, always through a segment that can ACTUALLY TURN A CHECK
// RED (`enforcingRunnerSegments` — the same definition directions 2, 3 and 4
// use, so the five cannot disagree about what a gate is):
//   `audit-gate`     — an enforcing segment at the repository root runs the
//                      script BARE (`node <path>`, nothing after it), directly
//                      or through a root package script whose unconditional
//                      `&&` chain does. Bare because these gates take MODE
//                      flags: `--audit` asks a weaker question ("no NEW false
//                      claim") and `--complete` a different one, and a step
//                      that ran only a mode flag would not hold the clause.
//   `root-suite`     — the file rides the wholesale root Vitest run and that
//                      run is really invoked by an enforcing step.
//   `package-suite`  — direction 3 credits the file: it is in the governed
//                      packages/** set and is neither ungated, quarantined, nor
//                      classified as a non-unit tier.
// And, for every kind, the artifact must EXIST. A gate renamed away is exactly
// as unrun as one whose step was deleted.
//
// NO LEDGER, AND THAT IS THE POINT. Directions 3 and 4 carry an exceptions file
// because they govern hundreds of files and debt has to be countable. This set
// has three members, each one named by a ratified plan as a gate that stays
// green; "recorded as unwired" is not a state the clause allows. The only way
// out is to wire it — or to change the plan, which changes this list.
//
// RESIDUALS, named. The suite arms ask the wholesale question only: a file that
// is PINNED by an enforcing step but no longer rides its wholesale runner reads
// as unwired here. That is a false RED a human fixes by looking, never a false
// green, and it is the same lean directions 3 and 4 already take. A LAUNCHER
// WRAPPER is not modelled either, and neither is an ENVIRONMENT PREFIX:
// `nice -n 10 node <gate>`, `timeout 60 pnpm gate:x`, `cross-env X=1 pnpm gate:x`
// and `CI=1 node <gate>` all read as unwired, so the step is written bare — and
// the wrapper list is derived from this file's own launcher set rather than
// written out, so it cannot fall behind it. All of them lean the same way —
// a false RED a human fixes — and the env-prefix refusal is the one that has to
// be absolute, because the prefix is what decides which `node` runs at all — it
// is refused on BOTH doors, the direct run and the package-script invocation,
// and inside the aggregate walk.
//
// WHAT IS STILL NOT MODELLED, said rather than left to be found: a job-level or
// step-level `env:` block. A syntactically bare `node <gate>` inherits it, so a
// `NODE_OPTIONS` set there would not be seen here. No direction in this file
// reads a job's `env:` — they all read segment text — so closing it is a change
// to the shared reader and not to this direction, and it is left where the rest
// of the file leaves it. The reachable shapes are refused; this one is named.
// And this direction inherits the header's one residual in the other direction: a
// non-literal `if:` reads as EXECUTING, so a step in a job guarded by an
// expression that never fires would be credited. Refusing those would credit
// nothing at all — every gating job in this repository carries the docs-only
// skip — which is why the directions above read them this way and why this one
// does not diverge.
export const SECTION_6_GATES = Object.freeze([
  Object.freeze({
    clause: "the one-card gate",
    artifact: "scripts/audit/chat-hitl-one-card-gate.mjs",
    kind: "audit-gate",
  }),
  Object.freeze({
    clause: "the host-parity ratchet",
    artifact: "packages/chat/src/__tests__/lifecycle-host-parity-ratchet.test.tsx",
    kind: "package-suite",
  }),
  Object.freeze({
    clause: "the held-turn card contract",
    artifact: "src/lib/lifecycle/__tests__/held-turn-card-contract.test.ts",
    kind: "root-suite",
  }),
]);

/**
 * The path a segment runs BARE under `node`, or null.
 *
 * EXACTLY two words, `node <path>`, and nothing else. No argument after the
 * path (a mode flag makes it a different question), no redirection (whose target
 * is a file the shell writes, not a gate that ran), no terminal flag.
 *
 * AND NO ENVIRONMENT PREFIX — not even a harmless-looking one, which is the
 * whole reason this does NOT go through `stripEnvPrefix` the way the rest of
 * this file does. The prefix decides WHICH `node` runs and HOW it starts:
 * `PATH=./fake-bin node <gate>` runs a `node` that can exit 0 without reading
 * the gate at all, and `NODE_OPTIONS=--require=./exit-zero.cjs node <gate>`
 * short-circuits the real one. Neither is distinguishable here from `CI=1`
 * without modelling the shell's own lookup, so the whole shape is refused: a
 * credited gate that never ran is exactly the failure this direction exists to
 * prevent, and `CI=1 node <gate>` reading as unwired is a false RED a human
 * fixes by writing the step bare. `command` / `eval` / `nohup` wrappers are
 * refused with it, for the same reason and by the same rule.
 *
 * `runnerArgv` is not reused here — it models TEST RUNNERS (`node --test`,
 * `vitest run`) and returns null for a plain script — so this is the one shape
 * it does not cover.
 */
export function bareNodeScriptRun(seg) {
  const trimmed = stripShellComment(seg).trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (hasTopLevelRedirect(trimmed)) return null;
  // RAW words, COUNTED BEFORE anything is unquoted or dropped: `node <gate> ''`
  // is three shell words and passes an argument, and filtering the empty one
  // away first would credit it as bare.
  const raw = shellTokens(trimmed);
  if (raw.length !== 2) return null;
  const toks = raw.map((tok) => unquoteWord(tok));
  if (toks[0] !== "node") return null;
  if (hasTerminalFlag(toks)) return null;
  const path = toks[1].replace(/^\.\//, "");
  return path && !path.startsWith("-") ? path : null;
}

/** Does some enforcing workflow segment run this audit gate script, bare? */
export function auditGateIsEnforced(artifact, opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const workflowDir = opts.workflowDir ?? WORKFLOW_DIR;
  const segments = opts.segments ?? [...enforcingRunnerSegments(workflowDir)];
  const scripts = opts.scripts ?? rootPackageScripts(repoRoot);
  // The root package scripts whose own `&&` chain runs it bare, then the
  // aggregates that reach one — direction 4's walk, called and not copied. Same
  // chain grammar, so a script masked with `;` / `||` / `&` — or rewritten to
  // `true` — stops being a runner here too.
  const reaching = closeOverAggregateScripts(
    new Set(
      Object.entries(scripts)
        .filter(([, cmd]) => (scriptChainSegments(cmd) ?? []).some((s) => bareNodeScriptRun(s) === artifact))
        .map(([name]) => name),
    ),
    scripts,
    { refuse: segmentHasCommandPrefix },
  );
  for (const { seg, cwd } of segments) {
    // A run inside another package is another package's business; an UNKNOWN
    // cwd (`null`) is refused rather than assumed to be the root.
    if (cwd !== "") continue;
    // BOTH DOORS REFUSE A PREFIX. The two-word rule already closes the direct
    // one, but the package-script door goes through `invokesRootSuite`, which
    // steps OVER an environment assignment — so `PATH=./fake-bin pnpm gate:x`
    // would be credited while a `pnpm` that reads nothing exits 0. The same
    // refusal is threaded into the aggregate walk above, so a prefix cannot be
    // hidden one script further up either.
    if (segmentHasCommandPrefix(seg)) continue;
    if (bareNodeScriptRun(seg) === artifact) return true;
    for (const script of reaching) {
      if (invokesRootSuite(seg, script)) return true;
    }
  }
  return false;
}

/** Direction 5's verdict for every gate the clause names. */
export function auditSection6Gates(repoRoot = REPO_ROOT, workflowDir = WORKFLOW_DIR, opts = {}) {
  const gates = opts.gates ?? SECTION_6_GATES;
  const segments = opts.segments ?? [...enforcingRunnerSegments(workflowDir)];
  const scripts = opts.scripts ?? rootPackageScripts(repoRoot);
  // LAZY, each of them: an `audit-gate` verdict must not be made to own a
  // root vitest config or a packages/** tree it never reads.
  let globs = opts.globs;
  let pkgAudit = opts.packageAudit;
  let rootEnforced = opts.rootEnforced;

  const enforced = [];
  const unwired = [];
  for (const gate of gates) {
    const { artifact, clause, kind } = gate;
    if (!existsSync(join(repoRoot, artifact))) {
      unwired.push({ ...gate, why: "the artifact is not on disk" });
      continue;
    }
    if (kind === "audit-gate") {
      if (auditGateIsEnforced(artifact, { repoRoot, workflowDir, segments, scripts })) {
        enforced.push({ ...gate, how: "run bare by an enforcing step" });
      } else {
        unwired.push({ ...gate, why: "NO enforcing step runs it (a bare `node <path>` run, or a root script that is one)" });
      }
      continue;
    }
    if (kind === "root-suite") {
      globs ??= parseRootVitestTestGlobs(repoRoot);
      rootEnforced ??= rootSuiteIsEnforced(workflowDir, repoRoot);
      if (ridesRootVitestRun(artifact, globs) && rootEnforced) {
        enforced.push({ ...gate, how: `covered by the wholesale \`pnpm ${ROOT_SUITE_SCRIPT}\` run` });
      } else {
        unwired.push({ ...gate, why: `neither discovered by ${ROOT_VITEST_CONFIG} nor reached by an enforcing \`pnpm ${ROOT_SUITE_SCRIPT}\` step` });
      }
      continue;
    }
    if (kind === "package-suite") {
      globs ??= parseRootVitestTestGlobs(repoRoot);
      pkgAudit ??= auditPackageSuiteRunners(repoRoot, workflowDir, { globs });
      // The complement of direction 3's own coverage decision, read off its
      // report rather than recomputed: a file it governs and does not classify
      // as ungated, quarantined or non-unit-tier is one it credits.
      const uncovered = new Set([
        ...pkgAudit.ungated.map((u) => u.file),
        ...pkgAudit.exempt.map((e) => e.file),
        ...pkgAudit.tierExcluded,
      ]);
      if (pkgAudit.packageFiles.includes(artifact) && !uncovered.has(artifact)) {
        enforced.push({ ...gate, how: "covered by its package's wholesale runner" });
      } else {
        unwired.push({ ...gate, why: `no ${PACKAGE_DIR}/** runner executes it (direction 3 does not credit it)` });
      }
      continue;
    }
    throw new Error(`SECTION_6_GATES: unknown kind ${JSON.stringify(kind)} for ${clause}.`);
  }
  return { gates, enforced, unwired };
}

// Run as a CLI gate — all five directions, all findings reported before
// exiting so one run tells the whole truth.
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

  // ── Direction 3 — packages/** (cinatra#2439) ────────────────────────────
  // `globs` and the pin resolution are reused, not recomputed: one workflow
  // scan feeds all three directions, so they cannot disagree about what the
  // workflows say (and the step does not pay for a second parse).
  // Direction 3 gets the ENFORCED pin view, not the raw one: a pin in a
  // manual-only workflow or a `continue-on-error` step proves the file exists
  // (direction 1's business) but gates nothing.
  const pkg = auditPackageSuiteRunners(REPO_ROOT, WORKFLOW_DIR, { globs });
  if (pkg.ungated.length > 0) {
    failed = true;
    console.error("\n✗ packages/** suites that NO CI runner executes:");
    for (const u of pkg.ungated) {
      const why = !u.discovered
        ? `NOT in ${u.pkgDir}/${PACKAGE_VITEST_CONFIG}'s discovery set`
        : u.wholesale
          ? `discovered by ${u.pkgDir}/${PACKAGE_VITEST_CONFIG} but no runner reaches it`
          : `no wholesale runner for ${u.pkgDir}`;
      console.error(`  - ${u.file} (${why})`);
    }
    console.error(
      "\nEach file above runs in NO workflow. Fix by EITHER wiring its package's\n" +
        "suite into CI (a wholesale `cd <pkg> && pnpm test` / `pnpm -C <pkg> exec\n" +
        "vitest run` step, which covers every file the package config discovers and\n" +
        "every file added later) OR — if the suite is broken and its repair is out of\n" +
        `scope — QUARANTINING it: exclude it in its package's ${PACKAGE_VITEST_CONFIG}\n` +
        `and add an entry to ${PACKAGE_EXCEPTIONS_FILE} naming the file, the reason,\n` +
        "and the FILED follow-up issue. Those are the only two states; there is no\n" +
        "third. A `vitest run <file>` pin does NOT work for a file the package config\n" +
        "excludes: vitest applies include/exclude BEFORE the CLI positional, so the\n" +
        "filter selects nothing and the step passes green.",
    );
  } else {
    console.log(
      `✓ every ${PACKAGE_DIR}/** unit suite is executed by a CI runner ` +
        `(${pkg.packageFiles.length} files, ${pkg.wholesale.size} wholesale package runners, ` +
        `${pkg.exempt.length} quarantined, ${pkg.tierExcluded.length} non-unit tier)`,
    );
  }

  if (pkg.staleExceptions.length > 0) {
    failed = true;
    console.error(`\n✗ ${PACKAGE_EXCEPTIONS_FILE} names files that do not exist:`);
    for (const e of pkg.staleExceptions) console.error(`  - ${e.file} (${e.issue})`);
    console.error("\nRemove the stale entry — it advertises a quarantine for a file that is gone.");
  }
  if (pkg.redundantExceptions.length > 0) {
    failed = true;
    console.error(`\n✗ ${PACKAGE_EXCEPTIONS_FILE} quarantines files a CI runner DOES execute:`);
    for (const e of pkg.redundantExceptions) console.error(`  - ${e.file} (${e.issue})`);
    console.error(
      "\nThe entry describes a state CI is not in, so the ledger no longer reads as\n" +
        "the truth it claims to be. Delete the entry (and close its follow-up issue if\n" +
        "the suite is genuinely repaired).",
    );
  }

  // ── Direction 4 — root integration tiers (cinatra#2936) ─────────────────
  // The enforcing-segment scan is shared with direction 3's view of the same
  // workflows, for the same reason: one definition of "a gate", four
  // directions reading it.
  // ONE enforcing-segment scan feeds directions 4 and 5, for the reason
  // direction 4 gives about directions 2 and 3: one definition of "a gate",
  // five directions reading it — and the step does not pay for a second parse.
  const segments = [...enforcingRunnerSegments()];
  const rootScripts = rootPackageScripts();
  const tier = auditRootIntegrationTiers(REPO_ROOT, WORKFLOW_DIR, { segments, scripts: rootScripts });
  if (tier.ungated.length > 0) {
    failed = true;
    console.error("\n✗ root integration tiers that NO CI runner executes:");
    for (const t of tier.ungated) {
      const how = t.scripts.length > 0 ? `reached by \`pnpm ${t.scripts.join("` / `pnpm ")}\`` : "reached by NO package script";
      console.error(`  - ${t.config} (${how})`);
    }
    console.error(
      "\nEach tier above is a dedicated tier config — somebody wrote a whole file to\n" +
        "say these suites need a real database and must never pass as skipped — and\n" +
        "no workflow runs it, so its suites run NOWHERE. Fix by EITHER adding a step\n" +
        "to a job with the services that tier needs (`pnpm <its script>`, bare: a\n" +
        "forwarded argument is not credited, because this gate cannot tell a flag\n" +
        `from a filter) OR adding an entry to ${ROOT_TIER_EXCEPTIONS_FILE} naming\n` +
        "the config, the SLICE that owns it, and the reason. Those are the only two\n" +
        "states; there is no third.",
    );
  } else {
    console.log(
      `✓ every root integration tier is executed by a CI runner ` +
        `(${tier.tiers.length} tiers, ${tier.enforced.length} wired, ${tier.exempt.length} recorded as unwired)`,
    );
  }

  if (tier.staleExceptions.length > 0) {
    failed = true;
    console.error(`\n✗ ${ROOT_TIER_EXCEPTIONS_FILE} names configs that do not exist:`);
    for (const e of tier.staleExceptions) console.error(`  - ${e.config} (${e.slice})`);
    console.error("\nRemove the stale entry — it records a gap for a tier that is gone.");
  }
  if (tier.redundantExceptions.length > 0) {
    failed = true;
    console.error(`\n✗ ${ROOT_TIER_EXCEPTIONS_FILE} records tiers a CI runner DOES execute:`);
    for (const e of tier.redundantExceptions) console.error(`  - ${e.config} (${e.slice})`);
    console.error(
      "\nThe entry describes a state CI is not in, so the ledger no longer reads as\n" +
        "the truth it claims to be. Delete the entry — the tier is wired.",
    );
  }

  // ── Direction 5 — plan (B) §6's own named gates (cinatra#2936) ──────────
  // Same shared scans again: the workflow segments above, direction 3's report
  // for the packages/** arm, and the root globs parsed once at the top.
  const section6 = auditSection6Gates(REPO_ROOT, WORKFLOW_DIR, {
    globs,
    segments,
    scripts: rootScripts,
    packageAudit: pkg,
  });
  if (section6.unwired.length > 0) {
    failed = true;
    console.error("\n✗ gates plan (B) §6 names that NO CI runner executes:");
    for (const g of section6.unwired) console.error(`  - ${g.artifact} — ${g.clause}: ${g.why}`);
    console.error(
      "\nThat plan's Conformance clause says these gates \"stay green through every\n" +
        "wave\". A gate no workflow runs cannot stay anything — it can go red and not\n" +
        "one check moves. Fix by adding a step to a job that can turn a required\n" +
        "check red: for an audit gate a BARE `node <path>` run (a mode flag such as\n" +
        "`--audit` asks a weaker question and is not credited); for a suite, a\n" +
        "wholesale runner that covers it. There is no ledger here and no third\n" +
        "state — the clause names these gates, and each one either runs or does not.",
    );
  } else {
    const auditGates = section6.gates.filter((g) => g.kind === "audit-gate").length;
    const suites = section6.gates.length - auditGates;
    console.log(
      `✓ every gate plan (B) §6 names is executed by a CI runner ` +
        `(${section6.gates.length} gates, ${auditGates} audit gate${auditGates === 1 ? "" : "s"}, ` +
        `${suites} suite${suites === 1 ? "" : "s"})`,
    );
  }

  if (failed) process.exit(1);
}
