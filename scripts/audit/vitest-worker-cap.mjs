#!/usr/bin/env node
/**
 * Vitest worker-cap gate (cinatra#3355).
 *
 * WHAT IT ENFORCES. Every workflow file that reaches `vitest` on a runner this
 * repository can schedule carries ONE workflow-level `VITEST_MAX_WORKERS`
 * assignment, and every one of them carries the SAME expected value. That is a
 * VALUE contract, not a presence check: a presence-only gate would happily pass
 * twelve files at "4" and one stale file at "3", which is the drift this gate
 * exists to catch. The expected value is declared ONCE, below, so a later
 * configuration change edits one constant and the gate then holds every
 * governed file to it.
 *
 * WHICH INVOCATIONS ARE GOVERNED — the one contract, used everywhere here. An
 * invocation is GOVERNED when it RESOLVES TO VITEST: either the word `vitest`
 * stands in command position, or the package script the command names resolves
 * to `vitest` in exactly ONE level. A workflow file is GOVERNED when at least
 * one of its invocations is. `VITEST_MAX_WORKERS` is vitest's own environment
 * name, so an invocation resolving to any OTHER runner is not merely unaffected
 * — the variable cannot reach it — and is excluded from the governed set AND
 * from the uncapped tally by that same resolved-runner test, never by a
 * filename allowlist.
 *
 * ONE LEVEL, NEVER DEEPER. If the resolved script itself calls another script
 * rather than a runner, this gate does NOT chase it: it FAILS CLOSED, naming
 * the file, the step and the unresolved script, so a future indirection is
 * caught loudly instead of passing as ungoverned.
 *
 * THE FOUR INVENTORIED EXCEPTION CLASSES, named literally (see
 * `scripts/audit/vitest-worker-cap.md` for the per-invocation inventory):
 *   1. `extension-suite-gate` — `node scripts/ci/extension-suite-gate.mjs` caps
 *      its own children at 1, spelled for BOTH vitest majors on the tree. It is
 *      left exactly as it is; this gate only asserts that cap is still there.
 *   2. `hosted-pinned` — a job whose `runs-on` is a hard-pinned GitHub-hosted
 *      label, which can therefore never reach the shared self-hosted box.
 *   3. `node:test` — node's own test runner; no vitest worker cap applies.
 *   4. `playwright` — `playwright test`; `VITEST_MAX_WORKERS` does not reach it.
 * A FIFTH class — an invocation whose resolved runner is none of the above —
 * fails the gate rather than being silently tolerated.
 *
 * NO SECOND WORKFLOW PARSER. Workflow YAML, its `run:` bodies, the shell split,
 * the cwd walk, the runner argv classifier, the package-directory resolution and
 * the `runs-on` expression reader all come from
 * `scripts/audit/ci-pinned-tests-exist.mjs`, which already owns them.
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = scanner error.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  bareNodeScriptRun,
  extractRunBlocks,
  enforcingSegmentsInBlock,
  hasTerminalFlag,
  packageScriptInvocation,
  runnerArgv,
  runsOnExpressionDefaultLabels,
  segmentTargetDir,
  shellTokens,
  splitShellSegments,
  stripShellComment,
  workspacePackageDirs,
} from "./ci-pinned-tests-exist.mjs";

/** The environment name vitest 4 reads, and the ONE place the value is declared. */
export const ENV_NAME = "VITEST_MAX_WORKERS";
/**
 * The committed worker count. cinatra#3355 records it as an INTERIM value; its
 * criterion 3 compares runner/worker configurations and may replace it. When it
 * does, this constant and the governed workflows move together — an incomplete
 * edit is exactly what this gate turns red.
 */
export const EXPECTED_VALUE = "3";
export const WORKFLOW_DIR_REL = ".github/workflows";
export const INVENTORY_DOC_REL = "scripts/audit/vitest-worker-cap.md";
export const SUITE_GATE_REL = "scripts/ci/extension-suite-gate.mjs";
export const SUITE_GATE_VALUE = "1";
export const EXCEPTION_CLASSES = Object.freeze([
  "extension-suite-gate",
  "hosted-pinned",
  "node:test",
  "playwright",
]);
/** The resolved runners this gate knows how to classify. Anything else fails. */
export const KNOWN_RUNNERS = Object.freeze(["vitest", "node:test", "playwright"]);

/**
 * Which package scripts are candidates for one-level resolution. A gate that
 * resolved EVERY `pnpm <script>` would have to fail closed on `pnpm build` and
 * `pnpm lint` too; only a test-shaped script name is a test-runner invocation
 * to begin with. `test`, `test:e2e`, `test:e2e:rbac` and `works-after:test` all
 * match; `latest` does not (the `test` must sit on a word boundary).
 */
const TEST_SCRIPT_RE = /(^|[:._-])test([:._-]|$)/i;
/** A hard-pinned GitHub-hosted runner label. */
const HOSTED_LABEL_RE = /\b(?:ubuntu|windows|macos)-(?:latest|\d[\w.]*)\b/i;

/**
 * Two token-walk constants MIRRORED from `ci-pinned-tests-exist.mjs`, which
 * keeps them private. They are shell vocabulary, not a parser: `reachesPlaywright`
 * below needs the same "step over the launcher" walk `runnerArgv` performs, and
 * `runnerArgv` itself is reused unchanged for vitest and node:test.
 */
const LAUNCHER_WORDS = new Set([
  "pnpm", "pnpx", "npx", "npm", "yarn", "corepack", "exec", "env", "command", "nice", "time",
  "timeout", "cross-env", "dotenv",
]);
const LAUNCHER_VALUE_FLAGS = new Set(["--filter", "-F", "-C", "--dir", "--workspace-root", "--kill-after"]);

/**
 * Test runners this repository does NOT use. Seeing one in command position is
 * a FIFTH exception class and is REPORTED — an unrecognized runner that simply
 * returned null would leave the advertised fifth-class refusal unreachable.
 */
const FOREIGN_RUNNER_WORDS = new Set([
  "jest", "mocha", "ava", "tap", "tape", "jasmine", "karma", "cypress", "testcafe", "uvu", "qunit",
]);

/**
 * The COMMAND-position word of one shell segment, with the token after it: the
 * same "step over the launcher" walk `runnerArgv` performs, which that helper
 * keeps to itself because it models only the two runners its own gate cares
 * about. The resolved-runner contract needs the word itself — playwright and a
 * foreign runner are both classified from it.
 */
export function commandWord(seg) {
  const trimmed = stripShellComment(seg).trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const toks = shellTokens(trimmed);
  if (hasTerminalFlag(toks)) return null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = i > 0 ? toks[i - 1] : "";
    if (LAUNCHER_VALUE_FLAGS.has(prev)) continue; // this token is that flag's value
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // FOO=bar env assignment
    if (t.startsWith("-")) continue; // a launcher flag
    if (/^\d+(?:\.\d+)?[smhd]?$/.test(t)) continue; // `timeout … 780 …`
    if (LAUNCHER_WORDS.has(t)) continue;
    const word = t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t;
    return { word, next: toks[i + 1] ?? "" };
  }
  return null;
}

/** Does this segment invoke `playwright test` in COMMAND position? */
export function reachesPlaywright(seg) {
  const cw = commandWord(seg);
  return Boolean(cw && cw.word === "playwright" && cw.next === "test");
}

/**
 * The runner ONE segment reaches literally, or null. `runnerArgv` recognizes
 * `vitest run` and `node --test`; `vitest` WITHOUT `run` (watch mode, and
 * `pnpm exec vitest --project x`) is still vitest and still reads
 * `VITEST_MAX_WORKERS`, so a governed invocation must not disappear because the
 * subcommand is absent.
 */
export function literalRunner(seg) {
  const ra = runnerArgv(seg);
  if (ra) return ra.runner === "node" ? "node:test" : ra.runner;
  const cw = commandWord(seg);
  if (!cw) return null;
  if (cw.word === "vitest") return "vitest";
  if (cw.word === "playwright" && cw.next === "test") return "playwright";
  if (FOREIGN_RUNNER_WORDS.has(cw.word)) return cw.word; // reported as a fifth class
  return null;
}

/**
 * The job id and the raw `runs-on` value for the `run:` at `runIdx`. The walk is
 * the same column-anchored one `jobRunsOnLinux` performs (back to the key at
 * column 2, then forward to `runs-on:` at column 4); that helper returns a
 * BOOLEAN, and this gate needs the value itself — the routing variable's name is
 * the runner CLASS the inventory records, and a hard-pinned hosted label is one
 * of the four exception classes.
 */
export function jobContext(lines, runIdx) {
  let jobStart = -1;
  for (let k = runIdx; k >= 0; k--) {
    const ln = lines[k];
    if (ln.trim() === "" || /^\s*#/.test(ln)) continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind === 2 && /^\s{2}["']?[A-Za-z_][\w-]*["']?:/.test(ln)) { jobStart = k; break; }
    if (ind === 0) return { job: "", runsOn: "" };
  }
  if (jobStart === -1) return { job: "", runsOn: "" };
  const job = lines[jobStart].trim().replace(/:.*$/, "").replace(/^["']|["']$/g, "");
  for (let k = jobStart + 1; k < lines.length; k++) {
    const ln = lines[k];
    if (ln.trim() === "") continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind <= 2) break; // next job
    if (ind !== 4) continue;
    const m = ln.match(/^\s*["']?runs-on["']?:\s*(.*)$/);
    if (!m) continue;
    let value = m[1].replace(/\s#.*$/, "").trim();
    if (value === "") {
      const rest = [];
      for (let j = k + 1; j < lines.length; j++) {
        const l2 = lines[j];
        if (l2.trim() === "") continue;
        if (l2.length - l2.trimStart().length <= 4) break;
        rest.push(l2.trim());
      }
      value = rest.join(" ");
    }
    return { job, runsOn: value };
  }
  return { job, runsOn: "" };
}

/**
 * The runner CLASS a `runs-on` value names: the routing variable for the
 * `${{ fromJSON(vars.CI_RUNNER_X || '…') }}` shape every routed job writes, or
 * the literal label otherwise. `hostedPinned` is true only for a literal hosted
 * label — a routed job's label set is resolved from a repository variable at run
 * time and can change without touching any workflow file, so it is never
 * treated as unreachable from the shared box.
 */
export function runnerClass(runsOn) {
  const varName = runsOn.match(/vars\.(CI_RUNNER_[A-Z0-9_]+)/);
  if (varName && runsOnExpressionDefaultLabels(runsOn)) {
    return { cls: varName[1], hostedPinned: false };
  }
  const labels = literalLabels(runsOn);
  const pinned =
    !runsOn.includes("${{") &&
    labels.length === 1 &&
    HOSTED_LABEL_RE.test(labels[0]) &&
    !labels.some((l) => /^self-hosted$/i.test(l));
  return { cls: labels.join(", ") || runsOn || "unknown", hostedPinned: pinned };
}

/**
 * The literal labels a `runs-on` value names, in either YAML spelling — `a`,
 * `[a, b]` or a block sequence the job walk joined with spaces. A label SET
 * that also names `self-hosted` reaches the shared box, so it is never the
 * hosted-pinned exception however it is spelled.
 */
export function literalLabels(runsOn) {
  return runsOn
    .replace(/[[\]]/g, " ")
    .split(/[,\s]+/)
    .map((t) => t.replace(/^-+/, "").replace(/["']/g, "").trim())
    .filter(Boolean);
}

/**
 * Classify ONE shell segment. Returns null when it runs no test runner,
 * `{ runner, via, script }` when it resolves to one, or `{ error }` when a
 * test-shaped package script cannot be resolved in one level (fail closed).
 */
export function resolveInvocation(seg, cwd, ctx) {
  const bare = bareNodeScriptRun(seg);
  if (bare === SUITE_GATE_REL) {
    return { runner: "vitest", via: "nested", exception: "extension-suite-gate", script: null };
  }
  const direct = literalRunner(seg);
  if (direct) return { runner: direct, via: "literal", script: null };
  const ps = packageScriptInvocation(seg);
  if (!ps) return null;
  // A script is resolved by its BODY, never by its name: `pnpm verify` running
  // `vitest run` is as governed as `pnpm test` is. The test-shaped name decides
  // only what happens when resolution FAILS — failing closed on `pnpm build`
  // would red the gate for scripts that were never test-runner invocations.
  const shaped = TEST_SCRIPT_RE.test(ps.script);
  const fail = (msg) => (shaped ? { error: msg, script: ps.script } : null);
  const dir = segmentTargetDir(seg, cwd, ctx.pkgDirs);
  if (dir === null || dir === undefined) {
    return fail(`the package directory for \`${ps.script}\` cannot be resolved`);
  }
  const manifest = join(ctx.repoRoot, dir, "package.json");
  if (!existsSync(manifest)) {
    return fail(`\`${dir || "."}/package.json\` does not exist`);
  }
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
  } catch {
    return fail(`\`${dir || "."}/package.json\` is unparseable`);
  }
  const body = scripts[ps.script];
  if (typeof body !== "string") {
    return fail(`\`${dir || "."}/package.json\` has no \`scripts.${ps.script}\``);
  }
  // EVERY segment of the script body, never only the first: `playwright test &&
  // vitest run` reaches vitest too, and a governed run standing behind another
  // runner must not pass as that other runner's exception.
  const runners = [];
  for (const s2 of splitShellSegments(body)) {
    const r2 = literalRunner(s2);
    if (r2 && !runners.includes(r2)) runners.push(r2);
  }
  if (runners.includes("vitest")) return { runner: "vitest", via: "script", script: ps.script };
  if (runners.length) return { runner: runners[0], via: "script", script: ps.script };
  return fail(
    `\`scripts.${ps.script}\` in \`${dir || "."}/package.json\` reaches no test runner in ONE level (\`${body}\`)`,
  );
}

/** Every workflow-level (top-level `env:`) assignment of `name` in a workflow. */
export function workflowLevelAssignments(yamlText, name = ENV_NAME) {
  const lines = yamlText.split("\n");
  const out = [];
  let inEnv = false;
  let childIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trim() === "" || /^\s*#/.test(ln)) continue;
    const indent = ln.length - ln.trimStart().length;
    if (indent === 0) {
      inEnv = /^["']?env["']?:\s*$/.test(ln.trim());
      childIndent = null;
      continue;
    }
    if (!inEnv) continue;
    // The env mapping's OWN keys sit at one indent. Anything deeper is a nested
    // value — above all a block scalar, whose text can contain the very line
    // this gate looks for (`NOTE: |` then `VITEST_MAX_WORKERS: "3"` inside it
    // sets nothing) — so only the mapping's own depth counts as an assignment.
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue;
    const m = ln.match(/^\s+["']?([A-Za-z_][A-Za-z0-9_]*)["']?:\s*(.*)$/);
    if (!m || m[1] !== name) continue;
    const raw = m[2].replace(/\s+#.*$/, "").trim();
    out.push({ line: i + 1, value: raw.replace(/^["']|["']$/g, "") });
  }
  return out;
}

/**
 * The last line of the block a container opens at `startIdx`, whose own key sits
 * at `indent`. Blank and comment lines never close a block.
 */
function blockLastIndex(lines, startIdx, indent) {
  let end = startIdx;
  for (let k = startIdx + 1; k < lines.length; k++) {
    const ln = lines[k];
    if (ln.trim() === "" || /^\s*#/.test(ln)) continue;
    if (ln.length - ln.trimStart().length <= indent) return k - 1;
    end = k;
  }
  return end;
}

/**
 * The line indexes that are the TEXT of a block scalar (`key: |`, `key: >`).
 * `workflowLevelAssignments` keeps such text out of its reading by refusing any
 * depth but the env mapping's own; the scoped reader below has to find `env:`
 * keys at more than one depth, so it needs the text masked outright — a
 * `NOTE: |` whose body spells `env:` and an assignment under it sets nothing.
 */
function blockScalarMask(lines) {
  const masked = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (masked.has(i)) continue;
    const ln = lines[i];
    if (ln.trim() === "" || /^\s*#/.test(ln)) continue;
    if (!/:\s*[|>][-+0-9]*\s*(#.*)?$/.test(ln)) continue;
    const indent = ln.length - ln.trimStart().length;
    for (let k = i + 1; k < lines.length; k++) {
      const l2 = lines[k];
      if (l2.trim() !== "" && l2.length - l2.trimStart().length <= indent) break;
      masked.add(k);
    }
  }
  return masked;
}

/** The nearest preceding line, scalar text skipped, indented less than `indent`. */
function parentLine(lines, masked, idx, indent) {
  for (let k = idx - 1; k >= 0; k--) {
    if (masked.has(k)) continue;
    const ln = lines[k];
    if (ln.trim() === "" || /^\s*#/.test(ln)) continue;
    const ind = ln.length - ln.trimStart().length;
    if (ind < indent) return { idx: k, indent: ind, text: ln };
  }
  return null;
}

/**
 * Which scope an `env:` key opens: `job` for a job's own env mapping (the job id
 * sits at column 2, the same column-anchored shape `jobContext` walks), `step`
 * for one inside a `steps:` sequence item, and `unsupported` for an env mapping
 * this gate does not read — a service container's, say, which sets the
 * environment of the service and not of the test step. An unsupported mapping is
 * never silently dropped: if it carries the variable, the rule reds it.
 */
function envScope(lines, masked, idx, leadIndent, isSeqItem) {
  const unsupported = { scope: "unsupported", ownerIndex: idx, ownerIndent: leadIndent };
  if (isSeqItem) {
    const p = parentLine(lines, masked, idx, leadIndent);
    if (p && /^\s*["']?steps["']?:/.test(p.text)) return { scope: "step", ownerIndex: idx, ownerIndent: leadIndent };
    return unsupported;
  }
  const p = parentLine(lines, masked, idx, leadIndent);
  if (p) {
    if (/^\s*- /.test(p.text)) {
      const g = parentLine(lines, masked, p.idx, p.indent);
      if (g && /^\s*["']?steps["']?:/.test(g.text)) return { scope: "step", ownerIndex: p.idx, ownerIndent: p.indent };
    } else if (p.indent === 2 && leadIndent === 4) {
      return { scope: "job", ownerIndex: p.idx, ownerIndent: p.indent };
    }
  }
  return unsupported;
}

/**
 * Every JOB-level and STEP-level assignment of `name` — the narrowing overrides
 * `workflowLevelAssignments` deliberately does not return. The two readers stand
 * SIDE BY SIDE rather than one inside the other: the top-level reader answers the
 * value contract (exactly one assignment, at the expected value) and must keep
 * its top-level-only scope, while this one answers the MAXIMUM rule.
 *
 * The indentation discipline is the same one, for the same reason: only the env
 * mapping's OWN keys count, and block-scalar text is masked before the walk, so
 * neither a scalar that merely contains the assignment line nor one that spells a
 * whole `env:` mapping inside itself sets anything. An assignment written in the
 * FLOW form (`env: { NAME: "1" }`) is read too, and an env mapping at a scope
 * this gate does not read is returned as `unsupported` rather than dropped — an
 * override must never slip past the maximum rule unread. Each assignment carries
 * the range of lines its scope covers, which is what lets the inventory say which
 * cap actually reaches a given step.
 */
export function scopedAssignments(yamlText, name = ENV_NAME) {
  const lines = yamlText.split("\n");
  const masked = blockScalarMask(lines);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (masked.has(i)) continue;
    const ln = lines[i];
    if (ln.trim() === "" || /^\s*#/.test(ln)) continue;
    const m = ln.match(/^(\s*)(- )?["']?env["']?:\s*(.*)$/);
    if (!m) continue;
    const keyIndent = m[1].length + (m[2] ? 2 : 0);
    if (keyIndent === 0) continue; // the top-level block; the reader above owns it
    const { scope, ownerIndex, ownerIndent } = envScope(lines, masked, i, m[1].length, Boolean(m[2]));
    const coversFrom = ownerIndex + 1;
    const coversTo = blockLastIndex(lines, ownerIndex, ownerIndent) + 1;
    const { job } = jobContext(lines, i);
    // A comment is all a block-form `env:` key may carry on its own line.
    const inline = m[3].replace(/(^|\s)#.*$/, "").trim();
    if (inline !== "") {
      const flow = inline.match(new RegExp(`["']?${name}["']?\\s*:\\s*([^,}]+)`));
      if (flow) {
        const value = flow[1].trim().replace(/^["']|["']$/g, "");
        out.push({ line: i + 1, value, scope, job, coversFrom, coversTo });
      } else if (inline.includes(name)) {
        out.push({ line: i + 1, value: inline, scope: "unsupported", job, coversFrom, coversTo });
      }
      continue;
    }
    let childIndent = null;
    for (let k = i + 1; k < lines.length; k++) {
      if (masked.has(k)) continue;
      const l2 = lines[k];
      if (l2.trim() === "" || /^\s*#/.test(l2)) continue;
      const ind2 = l2.length - l2.trimStart().length;
      if (ind2 <= keyIndent) break;
      if (childIndent === null) childIndent = ind2;
      if (ind2 !== childIndent) continue;
      const a = l2.match(/^\s+["']?([A-Za-z_][A-Za-z0-9_]*)["']?:\s*(.*)$/);
      if (!a || a[1] !== name) continue;
      const raw = a[2].replace(/\s+#.*$/, "").trim();
      out.push({ line: k + 1, value: raw.replace(/^["']|["']$/g, ""), scope, job, coversFrom, coversTo });
    }
  }
  return out;
}

/**
 * The cap actually in effect for the step whose `run:` key sits at `stepLine`:
 * the narrowest assignment that covers it — a step-level one over a job-level
 * one over the workflow-level value — and `none` when no assignment reaches it
 * (a workflow with no top-level block, or one the value contract already reds
 * for carrying more than one).
 */
export function effectiveCap(workflowLevel, scoped, stepLine) {
  const covering = scoped.filter(
    (s) => (s.scope === "job" || s.scope === "step") && stepLine >= s.coversFrom && stepLine <= s.coversTo,
  );
  const stepScoped = covering.filter((s) => s.scope === "step");
  const narrowest = stepScoped.length ? stepScoped : covering;
  if (narrowest.length) return narrowest[narrowest.length - 1].value;
  if (workflowLevel.length === 1) return workflowLevel[0].value;
  return "none";
}

/**
 * The parser-derived invocation inventory: one entry per
 * (workflow, job, step line, runner class, resolved runner, disposition,
 * effective cap).
 */
export function deriveInventory(repoRoot = REPO_ROOT, workflowDir = join(repoRoot, WORKFLOW_DIR_REL)) {
  const ctx = { repoRoot, pkgDirs: workspacePackageDirs(repoRoot) };
  const files = readdirSync(workflowDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort();
  const entries = new Map();
  const errors = [];
  for (const file of files) {
    const yamlText = readFileSync(join(workflowDir, file), "utf8");
    const lines = yamlText.split("\n");
    const workflowLevel = workflowLevelAssignments(yamlText, ENV_NAME);
    const scoped = scopedAssignments(yamlText, ENV_NAME);
    for (const block of extractRunBlocks(yamlText)) {
      if (!block.isStep) continue; // a `run:` key nothing executes
      let normalized = block.body.replace(/\\[ \t]*\n/g, " ");
      if (block.fold === "folded") normalized = normalized.replace(/\n+/g, " ");
      const baseCwd = block.baseCwdUnknown ? null : block.baseCwd;
      const tracked = new Map();
      for (const t of enforcingSegmentsInBlock(normalized, baseCwd, file)) {
        const key = t.seg.trim();
        if (!tracked.has(key)) tracked.set(key, t.cwd);
      }
      // `enforcingSegmentsInBlock` yields only the segments whose FAILURE the
      // step would carry, so a segment it skipped has no tracked cwd. Reading
      // the base directory's manifest for such a segment would resolve the
      // WRONG package script whenever the block contains a `cd`, so the cwd is
      // unknown there and the resolution fails closed instead.
      const blockMovesCwd = /(^|[\n;&|])\s*cd\s/.test(normalized);
      for (const rawSeg of splitShellSegments(normalized)) {
        const seg = rawSeg.trim();
        if (!seg) continue;
        const cwd = tracked.has(seg) ? tracked.get(seg) : blockMovesCwd ? null : baseCwd;
        const res = resolveInvocation(seg, cwd, ctx);
        if (!res) continue;
        const { job, runsOn } = jobContext(lines, block.startLine - 1);
        if (res.error) {
          errors.push(`${file} (job \`${job}\`, step line ${block.startLine}): ${res.error}`);
          continue;
        }
        if (!KNOWN_RUNNERS.includes(res.runner)) {
          errors.push(
            `${file} (job \`${job}\`, step line ${block.startLine}): resolved runner \`${res.runner}\` is a FIFTH exception class — classify it in ${INVENTORY_DOC_REL} and in this gate`,
          );
          continue;
        }
        const { cls, hostedPinned } = runnerClass(runsOn);
        let disposition;
        if (res.exception) disposition = res.exception;
        else if (res.runner !== "vitest") disposition = res.runner;
        else disposition = hostedPinned ? "hosted-pinned" : "governed";
        const effective = effectiveCap(workflowLevel, scoped, block.startLine);
        const key = [file, job, block.startLine, cls, res.runner, disposition, effective].join(" | ");
        if (!entries.has(key)) {
          entries.set(key, { file, job, line: block.startLine, cls, runner: res.runner, disposition, effective });
        }
      }
    }
  }
  return { entries: [...entries.values()], errors, files };
}

/** One inventory row, exactly as it is written in the inventory document. */
export function inventoryRow(e) {
  return `| ${e.file} | ${e.job} | ${e.line} | ${e.cls} | ${e.runner} | ${e.disposition} | ${e.effective} |`;
}

/** The rows a committed inventory document carries. */
export function parseInventoryDoc(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\|\s*[\w.-]+\.ya?ml\s*\|/.test(l))
    .map((l) => l.replace(/\s*\|\s*/g, " | ").replace(/^ \| /, "| ").replace(/ \| $/, " |"));
}

/** The whole contract. Returns `{ failures, entries, governed }`. */
export function auditVitestWorkerCap(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const workflowDir = opts.workflowDir ?? join(repoRoot, WORKFLOW_DIR_REL);
  const expected = opts.expectedValue ?? EXPECTED_VALUE;
  const docPath = opts.docPath === undefined ? join(repoRoot, INVENTORY_DOC_REL) : opts.docPath;
  const suiteGatePath = opts.suiteGatePath === undefined ? join(repoRoot, SUITE_GATE_REL) : opts.suiteGatePath;
  const capMax = Number.parseInt(expected, 10);
  const failures = [];
  const { entries, errors } = deriveInventory(repoRoot, workflowDir);
  failures.push(...errors);

  const governedFiles = [...new Set(entries.filter((e) => e.disposition === "governed").map((e) => e.file))].sort();
  const values = new Map();
  for (const file of governedFiles) {
    const text = readFileSync(join(workflowDir, file), "utf8");
    const found = workflowLevelAssignments(text, ENV_NAME);
    const where = entries.find((e) => e.file === file && e.disposition === "governed");
    const at = `${file} (job \`${where.job}\`, step line ${where.line})`;
    // A cap is a MAXIMUM, so a job-level or step-level assignment that NARROWS
    // it keeps the contract and one that raises it breaks it. Read separately
    // from the top-level value contract above, which stays exactly as it is.
    for (const a of scopedAssignments(text, ENV_NAME)) {
      const n = /^\d+$/.test(a.value) ? Number.parseInt(a.value, 10) : NaN;
      const where2 = `${file} (job \`${a.job}\`, line ${a.line})`;
      if (a.scope === "unsupported") {
        failures.push(`${where2}: \`${ENV_NAME}\` is set here, but not as a job-level or step-level \`env:\` assignment this gate reads — a cap is a MAXIMUM and every override must be readable, so write it at the job or the step that owns the reason`);
      } else if (!Number.isInteger(n) || n < 1) {
        failures.push(`${where2}: ${a.scope}-level \`${ENV_NAME}\` is "${a.value}", which is not an integer of at least 1 — a cap is a MAXIMUM, so an override may only narrow it to a whole number of workers between 1 and "${expected}"`);
      } else if (n > capMax) {
        failures.push(`${where2}: ${a.scope}-level \`${ENV_NAME}\` is "${a.value}", ABOVE the workflow-level "${expected}" — a cap is a MAXIMUM, so an override may only narrow it`);
      }
    }
    if (found.length === 0) {
      failures.push(`${at}: reaches vitest but the workflow carries NO workflow-level \`${ENV_NAME}\` — add one top-level \`env:\` assignment of "${expected}"`);
      continue;
    }
    if (found.length > 1) {
      failures.push(`${at}: ${found.length} workflow-level \`${ENV_NAME}\` assignments (lines ${found.map((f) => f.line).join(", ")}) — there must be EXACTLY one`);
      continue;
    }
    values.set(file, found[0].value);
    if (found[0].value !== expected) {
      failures.push(`${at}: workflow-level \`${ENV_NAME}\` is "${found[0].value}" at line ${found[0].line}, expected "${expected}"`);
    }
  }
  const distinct = [...new Set(values.values())];
  if (distinct.length > 1) {
    failures.push(`the governed workflows do not all carry the SAME \`${ENV_NAME}\`: ${[...values.entries()].map(([f, v]) => `${f}="${v}"`).join(", ")}`);
  }

  if (suiteGatePath) {
    const gateText = existsSync(suiteGatePath) ? readFileSync(suiteGatePath, "utf8") : "";
    if (!new RegExp(`${ENV_NAME}:\\s*"${SUITE_GATE_VALUE}"`).test(gateText)) {
      failures.push(`${SUITE_GATE_REL}: the inventoried \`extension-suite-gate\` exception no longer sets \`${ENV_NAME}: "${SUITE_GATE_VALUE}"\` — re-inventory it in ${INVENTORY_DOC_REL}`);
    }
  }

  if (docPath) {
    const want = entries.map(inventoryRow).sort();
    const have = existsSync(docPath) ? parseInventoryDoc(readFileSync(docPath, "utf8")).sort() : [];
    const missing = want.filter((r) => !have.includes(r));
    const stale = have.filter((r) => !want.includes(r));
    if (missing.length || stale.length) {
      failures.push(
        `${INVENTORY_DOC_REL} does not match the derived inventory (${missing.length} missing, ${stale.length} stale). The full expected table is:\n${want.join("\n")}`,
      );
    }
  }
  return { failures, entries, governed: governedFiles };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    const { failures, entries, governed } = auditVitestWorkerCap();
    if (failures.length) {
      console.error(`Vitest worker-cap gate: ${failures.length} finding(s).`);
      for (const f of failures) console.error(`  - ${f}`);
      console.error(`\nThe contract and the per-invocation inventory live in ${INVENTORY_DOC_REL}.`);
      process.exit(1);
    }
    console.log(
      `Vitest worker-cap gate: OK — ${entries.length} test-runner invocations inventoried, ${governed.length} governed workflow(s) at ${ENV_NAME}="${EXPECTED_VALUE}".`,
    );
  } catch (err) {
    console.error(`Vitest worker-cap gate: scanner error — ${err?.stack || err}`);
    process.exit(2);
  }
}
