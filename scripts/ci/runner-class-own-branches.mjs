// Jobs on a named runner class — cinatra#3919.
//
// A job takes its runner from a class variable, `vars.CI_RUNNER_<CLASS>`. A job
// whose `runs-on` reads a class other than the four below, or any other
// variable, runs for every event that is not a pull request and for pull
// requests from branches of this repository; a pull request from another
// repository skips it. The job carries one condition CONDITION (below) in one
// of three forms:
//
//   1. Its `if` is the condition alone, with or without the build-only head
//      condition (build-only-heads.mjs) beside it.
//   2. Its `if` carries the condition as a conjunct at any depth: every level
//      from the whole expression down to the condition is a `&&` chain with no
//      `||` at its top, and each step down removes one plain pair of
//      parentheses.
//   3. Its `runs-on` reads every variable behind the condition, as in
//      `${{ CONDITION && fromJSON(vars.CI_RUNNER_<CLASS> || '"ubuntu-latest"') || 'ubuntu-latest' }}`.
//
// The workflows of this repository write the first two forms the same way in
// every file:
//
//   if: ${{ ((EXISTING) && CONDITION) && BUILD_ONLY_HEAD_CONDITION }}
//   if: ${{ (CONDITION) && BUILD_ONLY_HEAD_CONDITION }}   (a job with no condition before)
//
// A workflow without a `pull_request` trigger needs no condition; a
// `workflow_call` trigger counts as one, and a job of a workflow with a
// `pull_request_target` trigger never counts as carrying it. Each job carries
// the condition itself: a job that only needs a job carrying it does not count.
//
// This module is the one place the condition is written. The workflow test
// (scripts/ci/__tests__/runner-class-own-branches.test.mjs) reads every
// workflow and refuses, by name, a job on such a class without it.

import { evaluateHeadCondition } from "./build-only-heads.mjs";
import { parseJobs, parseTriggers } from "./merge-group-coverage-guard.mjs";

/** The condition, exactly as every such job carries it. */
export const OWN_BRANCH_CONDITION =
  "(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)";

/** The runner classes whose jobs need no condition: gate, end-to-end, heavy and pool. */
export const EXCEPTED_RUNNER_CLASSES = Object.freeze(["GATE", "E2E", "HEAVY", "POOL"]);

/** The triggers that start a workflow for a pull request; a job under the last one never counts as carrying the condition. */
const PULL_REQUEST_TRIGGERS = Object.freeze(["pull_request", "workflow_call", "pull_request_target"]);

/** A trigger as a plain name; anything else (a flow mapping, no `on:`) is checked as a pull request workflow. */
const TRIGGER_NAME = /^[A-Za-z_]+$/;

const SUFFIX = ` && ${OWN_BRANCH_CONDITION}`;

/** The expression inside `${{ }}`, or the value itself when it is not wrapped. */
const expressionOf = (value) => {
  const text = String(value).trim();
  return text.startsWith("${{") && text.endsWith("}}") ? text.slice(3, -2).trim() : text;
};

/**
 * The operands of `text` joined at its top level by `op` (`&&` or `||`):
 * outside single-quoted strings, parentheses and brackets. Null when the
 * parentheses or the quotes do not balance, or when an operand is empty.
 */
function splitTopLevel(text, op) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "'" && text[i + 1] === "'") i++;
      else if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") quoted = true;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") {
      depth--;
      if (depth < 0) return null;
    } else if (depth === 0 && text.startsWith(op, i)) {
      parts.push(text.slice(start, i).trim());
      i += op.length - 1;
      start = i + 1;
    }
  }
  if (depth !== 0 || quoted) return null;
  parts.push(text.slice(start).trim());
  return parts.some((part) => part === "") ? null : parts;
}

/** The text inside one plain pair of parentheses that encloses all of `text`, or null. */
function groupInner(text) {
  if (!text.startsWith("(") || !text.endsWith(")")) return null;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "'" && text[i + 1] === "'") i++;
      else if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i === text.length - 1 ? text.slice(1, -1).trim() : null;
    }
  }
  return null;
}

/** True when `text` is the condition, inside any number of further plain pairs of parentheses. */
function isCondition(text) {
  let current = text.trim();
  while (current !== OWN_BRANCH_CONDITION) {
    current = groupInner(current);
    if (current === null) return false;
  }
  return true;
}

/**
 * True when the expression `text` carries the condition as a conjunct at any
 * depth: the condition is compared as a whole first; a plain pair of
 * parentheses around the whole is one step down; otherwise the level must be a
 * `&&` chain of two terms or more with no top-level `||`, one of whose terms
 * carries it.
 */
function carriesAsConjunct(text) {
  const current = text.trim();
  if (current === OWN_BRANCH_CONDITION) return true;
  const inner = groupInner(current);
  if (inner !== null) return carriesAsConjunct(inner);
  const alternatives = splitTopLevel(current, "||");
  if (alternatives === null || alternatives.length > 1) return false;
  const conjuncts = splitTopLevel(current, "&&");
  return conjuncts !== null && conjuncts.length > 1 && conjuncts.some(carriesAsConjunct);
}

/**
 * Split a job's own condition into this condition and the rest. Returns
 * `{ carries, existing }`: `carries` is true when the value carries the
 * condition alone or as a conjunct (the first two forms above); `existing` is
 * X for `(X) && CONDITION` with `(X)` one group, null for the condition alone,
 * and the value itself otherwise.
 */
export function splitOwnBranchGuard(existing) {
  if (existing == null) return { carries: false, existing: null };
  const value = String(existing).trim();
  const inner = expressionOf(value);
  if (inner === OWN_BRANCH_CONDITION) return { carries: true, existing: null };
  if (inner.endsWith(SUFFIX)) {
    const group = groupInner(inner.slice(0, -SUFFIX.length).trim());
    if (group !== null) return { carries: true, existing: group };
  }
  return { carries: carriesAsConjunct(inner), existing: value };
}

/** True when a job's whole `if:` value carries the condition alone or as a conjunct. */
export const carriesOwnBranchCondition = (ifValue) => ifValue != null && carriesAsConjunct(expressionOf(ifValue));

/**
 * Whether the condition lets a job run for one head
 * `{ eventName, headRef, headRepo, repository }`.
 */
export const runsForHead = (head) => evaluateHeadCondition(OWN_BRANCH_CONDITION, head);

const JOBS_LINE = /^jobs:\s*(#.*)?$/;
const JOB_HEADER = /^ {2}(['"]?)([A-Za-z_][\w-]*)\1:(.*)$/;
const isComment = (line) => /^\s*#/.test(line);
const withoutComment = (value) => value.replace(/(^|\s)#.*$/, "").trim();

/**
 * `{ blocks, orphan }`: blocks maps each job id to the job's own lines,
 * whole-line comments dropped, or to null when the job is taken from an alias
 * or written in another shape; orphan is true when a line of the jobs block
 * stands before the first job.
 */
function jobBlocks(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => JOBS_LINE.test(l));
  const blocks = new Map();
  let orphan = false;
  if (start === -1) return { blocks, orphan };
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== "" && /^\S/.test(line)) break;
    const head = line.match(JOB_HEADER);
    if (head) {
      const shape = withoutComment(head[3]);
      current = shape === "" || /^&\S+$/.test(shape) ? [] : null;
      blocks.set(head[2], current);
      continue;
    }
    if (current === null && line.trim() !== "" && !isComment(line) && blocks.size === 0) orphan = true;
    if (current && !isComment(line)) current.push(line);
  }
  return { blocks, orphan };
}

/**
 * True when the job's lines are not laid out the way this reader reads them:
 * keys not at four spaces, or a quoted `runs-on` / `if` key.
 */
function otherLayout(lines) {
  const first = lines.find((l) => l.trim() !== "");
  return (first !== undefined && !/^ {4}\S/.test(first)) || lines.some((l) => /^\s*(['"])(runs-on|if)\1\s*:/.test(l));
}

/** A quoted YAML value, then at most a comment. */
const QUOTED_VALUE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(?:\s+#.*)?$/;

/**
 * The value of the four-space key line `line`, its comment removed: a plain
 * value ends at ` #`, a quoted one at its closing quote. Null for a quoted
 * value this reader does not read whole (one that does not close on the line).
 */
function valueOf(line, key) {
  const raw = line.replace(new RegExp(`^ {4}${key}:`), "").trim();
  if (!/^['"]/.test(raw)) return raw.replace(/\s+#.*$/, "").trim();
  const quoted = raw.match(QUOTED_VALUE);
  return quoted ? quoted[1] : null;
}

/** The lines nested under the four-space key at `at`, up to the next key at that indent or less. */
function nestedUnder(lines, at) {
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") continue;
    if (!/^ {5,}/.test(line)) break;
    out.push(line);
  }
  return out;
}

/**
 * A variable read as `vars.NAME` or as `vars['NAME']` / `vars["NAME"]`; the
 * context and the name match without regard to case.
 */
const VARIABLE = /\bvars(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*(['"])([^'"]+)\2\s*\])/gi;
const variablesIn = (text) => [...text.matchAll(VARIABLE)].map((m) => (m[1] ?? m[3]).toUpperCase());
/** A variable read through a computed index, `vars[<expression>]`: no name this reader can read. */
const COMPUTED_READ = /\bvars\s*\[(?!\s*(['"])[^'"]+\1\s*\])/i;
const readsVariable = (text) => variablesIn(text).length > 0 || COMPUTED_READ.test(text);

/** One read behind the condition: the read itself, or the read first inside `fromJSON(`, a quoted default after it. */
const READ = String.raw`vars(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\s*(?:'[^']+'|"[^"]+")\s*\])`;
const GUARDED_READ = new RegExp(
  String.raw`^(?:${READ}|fromJSON\(\s*${READ}\s*(?:\|\|\s*'(?:[^']|'')*'\s*)?\))$`,
  "i",
);

/**
 * True when a `runs-on` value is one `${{ }}` expression in which every
 * variable read stands behind the condition (the third form above): each
 * operand of its top-level `||` either reads no variable or is
 * `CONDITION && READ`.
 */
function guardsEveryRead(value) {
  const text = value.trim();
  if (!text.startsWith("${{") || !text.endsWith("}}")) return false;
  const inner = text.slice(3, -2).trim();
  if (inner.includes("${{") || inner.includes("}}")) return false;
  const alternatives = splitTopLevel(inner, "||");
  if (alternatives === null) return false;
  let guarded = 0;
  for (const alternative of alternatives) {
    if (!readsVariable(alternative)) continue;
    const terms = splitTopLevel(alternative, "&&");
    if (terms === null || terms.length !== 2 || !isCondition(terms[0]) || !GUARDED_READ.test(terms[1])) return false;
    guarded++;
  }
  return guarded > 0;
}

/** The class a runner variable names: CLASS for `CI_RUNNER_<CLASS>`, else the variable itself. */
const classOf = (variable) => {
  const m = variable.match(/^CI_RUNNER_([A-Z0-9_]+)$/);
  return m ? m[1] : variable;
};

/** Only `CI_RUNNER_<CLASS>` with CLASS one of the four is excepted; any other name is not. */
const isExcepted = (variable) => {
  const m = variable.match(/^CI_RUNNER_([A-Z0-9_]+)$/);
  return m !== null && EXCEPTED_RUNNER_CLASSES.includes(m[1]);
};

/**
 * The runner class one job reads, from its four-space `runs-on:` key:
 * `{ classes, guarded }` (the classes outside the excepted four, empty when
 * none; guarded when every read stands behind the condition) or
 * `{ unreadable: true }` when the key reads a variable in a form this reader
 * does not read (a list, a mapping, a block scalar, a value continued on the
 * next lines, a computed index, a quoted value not closed on its line, or a matrix
 * value whose strategy reads one), when the job's keys are not at four spaces
 * or the key is quoted, or when the key or the job is taken from an alias or a
 * merge key.
 */
function runnerOf(lines) {
  if (lines.some((l) => /^ {4}<<\s*:/.test(l))) return { unreadable: true };
  if (otherLayout(lines) && lines.some(readsVariable)) return { unreadable: true };
  const at = lines.findIndex((l) => /^ {4}runs-on:/.test(l));
  if (at === -1) return { classes: [], guarded: false };
  const value = valueOf(lines[at], "runs-on");
  if (value === null || value.startsWith("*")) return { unreadable: true };
  if (nestedUnder(lines, at).some(readsVariable)) return { unreadable: true };
  if (value === "" || /^[>|]/.test(value)) return { classes: [], guarded: false };
  if (value.startsWith("[")) return readsVariable(value) ? { unreadable: true } : { classes: [], guarded: false };
  if (COMPUTED_READ.test(value)) return { unreadable: true };
  if (/\bmatrix\./.test(value)) {
    const strategy = lines.findIndex((l) => /^ {4}strategy:/.test(l));
    const read = strategy === -1 ? [] : [lines[strategy], ...nestedUnder(lines, strategy)];
    if (read.some(readsVariable)) return { unreadable: true };
  }
  const classes = variablesIn(value)
    .filter((v) => !isExcepted(v))
    .map(classOf);
  return { classes: [...new Set(classes)], guarded: guardsEveryRead(value) };
}

/**
 * A job's own four-space `if:` key: `{ value }` (null when it has none) or
 * `{ unreadable: true }` for an alias, a value continued on the next lines, or
 * a quoted value not closed on its line.
 */
function conditionOf(lines) {
  const at = lines.findIndex((l) => /^ {4}if:/.test(l));
  if (at === -1) return { value: null };
  const value = valueOf(lines[at], "if");
  if (value === null || value.startsWith("*") || nestedUnder(lines, at).length > 0) return { unreadable: true };
  return { value };
}

/**
 * Every job, in a workflow a pull request starts, whose `runs-on` reads a
 * runner class outside the excepted four (or any other variable, or reads one
 * in a form this reader does not read) and that does not carry the condition
 * itself. A workflow whose triggers this reader does not read as plain names
 * is checked as one a pull request starts. Takes `[{ file, text }]`; returns
 * `[{ file, job, runnerClass }]` sorted by file and job (`runnerClass` is
 * "unreadable" for a `runs-on` or an `if` this reader does not read).
 */
export function findUnguardedRunnerJobs(workflows) {
  const found = [];
  for (const { file, text } of workflows) {
    const read = parseTriggers(text);
    const triggers = read ?? [];
    const unread = read === null || triggers.some((t) => !TRIGGER_NAME.test(t));
    if (!unread && !triggers.some((t) => PULL_REQUEST_TRIGGERS.includes(t))) continue;
    const neverGuarded = triggers.some((t) => t.includes("pull_request_target"));
    const { blocks, orphan } = jobBlocks(text);
    const keys = new Set(blocks.keys());
    if (orphan) for (const { key } of parseJobs(text)) keys.add(key);
    for (const key of keys) {
      const lines = blocks.get(key);
      const runner = lines ? runnerOf(lines) : { unreadable: true };
      const runnerClass = runner.unreadable ? "unreadable" : runner.classes[0];
      if (runnerClass === undefined) continue;
      if (!neverGuarded) {
        const condition = lines ? conditionOf(lines) : { unreadable: true };
        if (condition.unreadable) {
          found.push({ file, job: key, runnerClass: "unreadable" });
          continue;
        }
        if (runner.guarded || carriesOwnBranchCondition(condition.value)) continue;
      }
      found.push({ file, job: key, runnerClass });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.job.localeCompare(b.job));
}
