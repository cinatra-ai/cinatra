// Jobs on a named runner class run for pull requests from branches of this
// repository only — cinatra#3919.
//
// A job whose `runs-on` reads a runner class variable other than the gate,
// end-to-end, heavy and pool classes carries one condition
// (scripts/ci/runner-class-own-branches.mjs): it runs for every event that is
// not a pull request and for pull requests from branches of this repository.
// This test pins the reader on fixture workflows, reads EVERY file under
// .github/workflows/ and refuses, by name, such a job without the condition in
// a workflow a pull request starts, and evaluates the condition for each kind
// of event. A workflow without a pull request trigger needs no condition.
//
// The workflows are read line-based with the repository's own readers
// (parseTriggers / parseJobs / parseJobAttrs), as the other workflow tests
// read them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BUILD_ONLY_HEAD_CONDITION, evaluateHeadCondition } from "../build-only-heads.mjs";
import {
  EXCEPTED_RUNNER_CLASSES,
  OWN_BRANCH_CONDITION,
  carriesOwnBranchCondition,
  findUnguardedRunnerJobs,
  runsForHead,
  splitOwnBranchGuard,
} from "../runner-class-own-branches.mjs";
import { parseJobAttrs } from "../merge-readiness-inventory.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

/** The repository the workflows run in, as `github.repository` reads. */
const REPOSITORY = "cinatra-ai/cinatra";
const OTHER_REPOSITORY = "example-org/cinatra";

/** A runner class line, the way every workflow of this repository writes one. */
const runsOn = (klass) => `\${{ fromJSON(vars.CI_RUNNER_${klass} || '"ubuntu-latest"') }}`;

/** The canonical form: the job's own condition, this condition, the build-only head condition. */
const guarded = (existing) =>
  existing
    ? `\${{ ((${existing}) && ${OWN_BRANCH_CONDITION}) && ${BUILD_ONLY_HEAD_CONDITION} }}`
    : `\${{ (${OWN_BRANCH_CONDITION}) && ${BUILD_ONLY_HEAD_CONDITION} }}`;

const check = (text, file = "example.yml") => findUnguardedRunnerJobs([{ file, text }]);

describe("the condition itself", () => {
  // (i)
  it("is the one expression, written once", () => {
    expect(OWN_BRANCH_CONDITION).toBe(
      "(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)",
    );
  });

  // (h)
  const HEADS = [
    { label: "a push", eventName: "push", headRef: "", headRepo: null, runs: true },
    { label: "a pull request from a branch of this repository", eventName: "pull_request", headRef: "feat/x", headRepo: REPOSITORY, runs: true },
    { label: "a pull request from another repository", eventName: "pull_request", headRef: "feat/x", headRepo: OTHER_REPOSITORY, runs: false },
    { label: "a merge queue group", eventName: "merge_group", headRef: "", headRepo: null, runs: true },
  ].map((h) => ({ ...h, repository: REPOSITORY }));

  for (const head of HEADS) {
    it(`${head.runs ? "runs" : "is skipped"} for ${head.label}`, () => {
      expect(evaluateHeadCondition(OWN_BRANCH_CONDITION, head)).toBe(head.runs);
      expect(runsForHead(head)).toBe(head.runs);
    });
  }
});

describe("the reading of a workflow's jobs", () => {
  // (a)
  it("refuses a pull request job on another runner class without the condition, by name", () => {
    expect(
      check(`on: pull_request
jobs:
  render:
    runs-on: ${runsOn("EXAMPLE")}
`),
    ).toEqual([{ file: "example.yml", job: "render", runnerClass: "EXAMPLE" }]);
  });

  // (b)
  it("passes the same job carrying the condition in the canonical form", () => {
    for (const existing of [null, "needs.select.outputs.mode != 'none'"]) {
      const text = `on: pull_request
jobs:
  render:
    if: ${guarded(existing)}
    runs-on: ${runsOn("EXAMPLE")}
`;
      expect(check(text), String(existing)).toEqual([]);
      expect(carriesOwnBranchCondition(parseJobAttrs(text).get("render").if)).toBe(true);
    }
  });

  // (c)
  it("passes the same job in a workflow started by hand only", () => {
    expect(
      check(`on:
  workflow_dispatch:
jobs:
  render:
    runs-on: ${runsOn("EXAMPLE")}
`),
    ).toEqual([]);
  });

  // (d)
  it("passes a pull request job on the gate, end-to-end, heavy or pool class without the condition", () => {
    expect([...EXCEPTED_RUNNER_CLASSES]).toEqual(["GATE", "E2E", "HEAVY", "POOL"]);
    for (const klass of EXCEPTED_RUNNER_CLASSES) {
      expect(
        check(`on: pull_request
jobs:
  build:
    runs-on: ${runsOn(klass)}
`),
        klass,
      ).toEqual([]);
    }
  });

  // (e)
  it("refuses the condition outside the canonical form", () => {
    const orForm = `on: pull_request
jobs:
  render:
    if: \${{ (needs.select.outputs.mode != 'none' || ${OWN_BRANCH_CONDITION}) && ${BUILD_ONLY_HEAD_CONDITION} }}
    runs-on: ${runsOn("EXAMPLE")}
`;
    const inComment = `on: pull_request
jobs:
  render:
    # if: ${guarded(null)}
    if: \${{ ${BUILD_ONLY_HEAD_CONDITION} }}
    runs-on: ${runsOn("EXAMPLE")}
`;
    for (const text of [orForm, inComment]) {
      expect(check(text)).toEqual([{ file: "example.yml", job: "render", runnerClass: "EXAMPLE" }]);
    }
    expect(splitOwnBranchGuard(`a || ${OWN_BRANCH_CONDITION}`).carries).toBe(false);
    expect(splitOwnBranchGuard(`(a) || (b) && ${OWN_BRANCH_CONDITION}`).carries).toBe(false);
    expect(splitOwnBranchGuard(null)).toEqual({ carries: false, existing: null });
  });

  it("refuses another variable name, a bracket read and a block scalar that read a runner variable", () => {
    const job = (runsOnLines) => `on: pull_request
jobs:
  render:
${runsOnLines}
`;
    for (const name of EXCEPTED_RUNNER_CLASSES) {
      expect(check(job(`    runs-on: \${{ vars.${name} }}`)), name).toEqual([
        { file: "example.yml", job: "render", runnerClass: name },
      ]);
    }
    expect(check(job(`    runs-on: \${{ fromJSON(vars['CI_RUNNER_EXAMPLE'] || '"ubuntu-latest"') }}`))).toEqual([
      { file: "example.yml", job: "render", runnerClass: "EXAMPLE" },
    ]);
    expect(check(job(`    runs-on: \${{ fromJSON(vars["CI_RUNNER_GATE"] || '"ubuntu-latest"') }}`))).toEqual([]);
    expect(check(job(`    runs-on: >-\n      ${runsOn("EXAMPLE")}`))).toEqual([
      { file: "example.yml", job: "render", runnerClass: "unreadable" },
    ]);
  });

  it("refuses a variable read on a continued line or through a computed index as unreadable", () => {
    const job = (runsOnLines) => `on: pull_request
jobs:
  render:
${runsOnLines}
    steps:
      - run: echo ok
`;
    const unreadable = [{ file: "example.yml", job: "render", runnerClass: "unreadable" }];
    expect(check(job(`    runs-on: [\n      "\${{ vars.CI_RUNNER_EXAMPLE }}"\n    ]`))).toEqual(unreadable);
    expect(check(job(`    runs-on: \${{\n      vars.CI_RUNNER_EXAMPLE }}`))).toEqual(unreadable);
    expect(check(job(`    runs-on: \${{ vars[inputs.runner_variable] }}`))).toEqual(unreadable);
    expect(check(job(`    runs-on: \${{ fromJSON(vars[format('CI_RUNNER_{0}', 'GATE')]) }}`))).toEqual(unreadable);
    expect(check(job(`    runs-on: [\n      "ubuntu-latest"\n    ]`))).toEqual([]);
  });

  // (f)
  it("refuses a job that only needs a job carrying the condition", () => {
    expect(
      check(`on: pull_request
jobs:
  first:
    if: ${guarded(null)}
    runs-on: ${runsOn("EXAMPLE")}
  second:
    needs: first
    runs-on: ${runsOn("EXAMPLE")}
`),
    ).toEqual([{ file: "example.yml", job: "second", runnerClass: "EXAMPLE" }]);
  });
});

describe("the repository's own workflows", () => {
  // (g)
  const files = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  const workflows = files.map((f) => ({
    file: `.github/workflows/${f}`,
    text: fs.readFileSync(path.join(WORKFLOWS_DIR, f), "utf8"),
  }));

  it("name no job on another runner class without the condition", () => {
    expect(workflows.length).toBeGreaterThan(0);
    expect(findUnguardedRunnerJobs(workflows)).toEqual([]);
  });

  it("give the condition to the picture comparison and to the worker image smoke job", () => {
    for (const [file, job] of [
      ["design-visual-verify.yml", "pixel-diff"],
      ["build-exec-images.yml", "build-and-smoke-worker"],
    ]) {
      const text = workflows.find((w) => w.file === `.github/workflows/${file}`)?.text ?? "";
      expect(carriesOwnBranchCondition(parseJobAttrs(text).get(job)?.if ?? null), `${file}#${job}`).toBe(true);
    }
  });
});

describe("the grammar of the guard", () => {
  // A job carries the condition in its `if` (alone, or as a conjunct at any
  // depth of plainly parenthesised && chains with no || above it) or in its
  // `runs-on` (every variable read behind `CONDITION &&`).
  const C = OWN_BRANCH_CONDITION;
  const A = "needs.a.outputs.x == 'true'";
  const B = "needs.b.outputs.y == 'true'";
  const workflow = ({ on = "on: pull_request", ifValue = null, runsOnValue = runsOn("EXAMPLE") } = {}) => `${on}
jobs:
  render:
${ifValue === null ? "" : `    if: ${ifValue}\n`}    runs-on: ${runsOnValue}
    steps:
      - run: echo ok
`;
  const listed = (runnerClass) => [{ file: "example.yml", job: "render", runnerClass }];
  const withIf = (expression) => check(workflow({ ifValue: `\${{ ${expression} }}` }));
  const withRunsOn = (expression) => check(workflow({ runsOnValue: `\${{ ${expression} }}` }));
  const fromJson = (read) => `fromJSON(${read} || '"ubuntu-latest"')`;

  // twin: a1 accepted: the if is the condition alone
  it("a1 accepts an if of the condition alone", () => {
    expect(withIf(C)).toEqual([]);
  });

  // twin: a2 accepted: the if is A && (condition) && B
  it("a2 accepts A && CONDITION && B", () => {
    expect(withIf(`${A} && ${C} && ${B}`)).toEqual([]);
  });

  it("a2 accepts (CONDITION) && A", () => {
    expect(withIf(`(${C}) && ${A}`)).toEqual([]);
  });

  it("a2 accepts A && (CONDITION)", () => {
    expect(withIf(`${A} && (${C})`)).toEqual([]);
  });

  // twin: n1 guarded: ((A) && (condition)) && B
  it("a2 accepts ((A) && (CONDITION)) && B", () => {
    expect(withIf(`((${A}) && (${C})) && ${B}`)).toEqual([]);
  });

  // twin: n2 guarded: (((A)) && ((condition))) && (B)
  it("a2 accepts (((A)) && ((CONDITION))) && (B)", () => {
    expect(withIf(`(((${A})) && ((${C}))) && (${B})`)).toEqual([]);
  });

  // twin: n3 guarded: ((condition)) && B
  it("a2 accepts ((CONDITION)) && B", () => {
    expect(withIf(`((${C})) && ${B}`)).toEqual([]);
  });

  // twin: n4 guarded: A && (B && (condition))
  it("a2 accepts A && (B && (CONDITION))", () => {
    expect(withIf(`${A} && (${B} && (${C}))`)).toEqual([]);
  });

  it("a2 accepts (A && CONDITION) && B", () => {
    expect(withIf(`(${A} && ${C}) && ${B}`)).toEqual([]);
  });

  it("a2 accepts the two staged if lines", () => {
    for (const existing of ["needs.select.outputs.mode != 'none'", "needs.changes.outputs.worker == 'true'"]) {
      expect(check(workflow({ ifValue: guarded(existing) })), existing).toEqual([]);
    }
  });

  // twin: a3 accepted: the read directly behind (condition) && in runs-on
  it("a3 accepts a runs-on of CONDITION && vars.NAME || 'ubuntu-latest'", () => {
    expect(withRunsOn(`${C} && vars.CI_RUNNER_EXAMPLE || 'ubuntu-latest'`)).toEqual([]);
    expect(withRunsOn(`((${C})) && vars.CI_RUNNER_EXAMPLE || 'ubuntu-latest'`)).toEqual([]);
  });

  // twin: a4 accepted: the real line, the read first inside fromJSON( behind (condition) && with a quoted default
  it("a4 accepts a runs-on of CONDITION && fromJSON(vars.NAME || a quoted default) || 'ubuntu-latest'", () => {
    expect(withRunsOn(`${C} && ${fromJson("vars.CI_RUNNER_EXAMPLE")} || 'ubuntu-latest'`)).toEqual([]);
  });

  // twin: a5 accepted: a bracket read behind the condition, plain and inside fromJSON(
  it("a5 accepts a bracket read in single quotes, plain and inside fromJSON(", () => {
    expect(withRunsOn(`${C} && vars['CI_RUNNER_EXAMPLE'] || 'ubuntu-latest'`)).toEqual([]);
    expect(withRunsOn(`${C} && ${fromJson("vars['CI_RUNNER_EXAMPLE']")} || 'ubuntu-latest'`)).toEqual([]);
  });

  // twin: a5 accepted: a bracket read behind the condition, plain and inside fromJSON(
  it("a5 accepts a bracket read in double quotes, plain and inside fromJSON(", () => {
    expect(withRunsOn(`${C} && vars["CI_RUNNER_EXAMPLE"] || 'ubuntu-latest'`)).toEqual([]);
    expect(withRunsOn(`${C} && ${fromJson('vars["CI_RUNNER_EXAMPLE"]')} || 'ubuntu-latest'`)).toEqual([]);
  });

  // twin: a4 accepted: the real line, the read first inside fromJSON( behind (condition) && with a quoted default
  it("the smoke workflow's runs-on of pull request 3916 reads guarded", () => {
    expect(
      check(`on: pull_request
jobs:
  hmr-smoke:
    if: \${{ !(github.event.pull_request.head.repo.full_name == github.repository && (startsWith(github.head_ref, 'merge-queue/') || startsWith(github.head_ref, 'merge-batch/'))) }}
    runs-on: \${{ (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && fromJSON(vars.CI_RUNNER_DEV_SMOKE || '"ubuntu-latest"') || 'ubuntu-latest' }}
    timeout-minutes: 30
`),
    ).toEqual([]);
  });

  // twin: r5 unguarded: an if of A || (condition)
  it("r5 refuses an if of A || (CONDITION)", () => {
    expect(withIf(`${A} || (${C})`)).toEqual(listed("EXAMPLE"));
  });

  // twin: m1 unguarded: ((A) || (condition)) && B
  it("refuses ((A) || (CONDITION)) && B", () => {
    expect(withIf(`((${A}) || (${C})) && ${B}`)).toEqual(listed("EXAMPLE"));
  });

  // twin: m2 unguarded: !((A) && (condition)) && B
  it("refuses !((A) && (CONDITION)) && B", () => {
    expect(withIf(`!((${A}) && (${C})) && ${B}`)).toEqual(listed("EXAMPLE"));
  });

  // twin: m3 unguarded: (A && (B || (condition))) && A
  it("refuses (A && (B || (CONDITION))) && A", () => {
    expect(withIf(`(${A} && (${B} || (${C}))) && ${A}`)).toEqual(listed("EXAMPLE"));
  });

  // twin: m4 unguarded: contains(github.head_ref, '(condition) && x') && A, the condition's text inside a string
  it("refuses the condition's text inside a string", () => {
    expect(withIf(`contains(github.head_ref, '${C.replaceAll("'", "''")} && x') && ${A}`)).toEqual(listed("EXAMPLE"));
  });

  // twin: m5 unguarded: A && B without the condition
  it("refuses A && B without the condition", () => {
    expect(withIf(`${A} && ${B}`)).toEqual(listed("EXAMPLE"));
  });

  it("refuses the condition written without its own parentheses inside a group", () => {
    expect(withIf(`(${A} && ${C.slice(1, -1)}) && ${B}`)).toEqual(listed("EXAMPLE"));
  });

  // twin: r1 unguarded: a second read after the expression's own ||
  it("r1 refuses a second read after the expression's own ||", () => {
    expect(withRunsOn(`${C} && vars.CI_RUNNER_EXAMPLE || vars.CI_RUNNER_EXAMPLE`)).toEqual(listed("EXAMPLE"));
  });

  // twin: r2 unguarded: a second read inside the default of fromJSON(
  it("r2 refuses a second read inside the default of fromJSON(", () => {
    expect(withRunsOn(`${C} && fromJSON(vars.CI_RUNNER_EXAMPLE || vars.CI_RUNNER_EXAMPLE) || 'ubuntu-latest'`)).toEqual(
      listed("EXAMPLE"),
    );
  });

  // twin: r3 unguarded: fromJSON( without the condition
  it("r3 refuses fromJSON( without the condition", () => {
    expect(withRunsOn(fromJson("vars.CI_RUNNER_EXAMPLE"))).toEqual(listed("EXAMPLE"));
  });

  // twin: r4 unguarded: the read inside another function behind the condition
  it("r4 refuses the read inside another function behind the condition", () => {
    expect(withRunsOn(`${C} && toJSON(vars.CI_RUNNER_EXAMPLE) || 'ubuntu-latest'`)).toEqual(listed("EXAMPLE"));
    expect(withRunsOn(`${C} && format('{0}', vars.CI_RUNNER_EXAMPLE) || 'ubuntu-latest'`)).toEqual(listed("EXAMPLE"));
  });

  // twin: r6 unguarded: a condition whose text differs in one token
  it("r6 refuses a condition whose text differs in one token", () => {
    const changed = C.replace("!=", "==");
    expect(changed).not.toBe(C);
    expect(withIf(`(${A}) && ${changed}`)).toEqual(listed("EXAMPLE"));
    expect(withRunsOn(`${changed} && ${fromJson("vars.CI_RUNNER_EXAMPLE")} || 'ubuntu-latest'`)).toEqual(listed("EXAMPLE"));
  });

  // twin: r7 unchanged: an unresolved index, an alias and a merge key refuse as unreadable; a longer name is no read
  it("r7 refuses an index that is an expression as unreadable", () => {
    expect(withRunsOn(`${C} && vars[matrix.x] || 'ubuntu-latest'`)).toEqual(listed("unreadable"));
    expect(withRunsOn(`${C} && fromJSON(vars[inputs.x] || '"ubuntu-latest"') || 'ubuntu-latest'`)).toEqual(
      listed("unreadable"),
    );
  });

  // twin: a runs-on in a block scalar, a mapping or a list is read whole; an alias or a merge key refuses as unreadable
  it("r7 refuses a runs-on taken from an alias as unreadable", () => {
    expect(
      check(`on: pull_request
jobs:
  setup:
    runs-on: &runner ${runsOn("GATE")}
  render:
    runs-on: *runner
`),
    ).toEqual(listed("unreadable"));
  });

  // twin: a runs-on in a block scalar, a mapping or a list is read whole; an alias or a merge key refuses as unreadable
  it("r7 refuses a job taken from a merge key or an alias as unreadable", () => {
    const defaults = `on: pull_request
jobs:
  setup: &defaults
    runs-on: ${runsOn("GATE")}
    steps:
      - run: echo ok
`;
    expect(check(`${defaults}  render:\n    <<: *defaults\n`)).toEqual(listed("unreadable"));
    expect(check(`${defaults}  render: *defaults\n`)).toEqual(listed("unreadable"));
  });

  // twin: r7 unchanged: an unresolved index, an alias and a merge key refuse as unreadable; a longer name is no read
  it("r7 refuses an if taken from an alias as unreadable", () => {
    expect(
      check(`on: pull_request
jobs:
  setup:
    if: &guard \${{ ${C} }}
    runs-on: ${runsOn("GATE")}
  render:
    if: *guard
    runs-on: ${runsOn("EXAMPLE")}
`),
    ).toEqual(listed("unreadable"));
  });

  // twin: only the whole name is a read, and the context and the name match without regard to case
  it("reads a longer name as its own class, never the shorter one", () => {
    expect(check(workflow({ runsOnValue: runsOn("GATE_X") }))).toEqual(listed("GATE_X"));
  });

  // twin: only the whole name is a read, and the context and the name match without regard to case
  it("reads VARS.CI_RUNNER_EXAMPLE as a read of the class EXAMPLE", () => {
    expect(withRunsOn(`fromJSON(VARS.CI_RUNNER_EXAMPLE || '"ubuntu-latest"')`)).toEqual(listed("EXAMPLE"));
  });

  // twin: only the whole name is a read, and the context and the name match without regard to case
  it("reads vars.ci_runner_gate as the excepted class GATE", () => {
    expect(withRunsOn(`fromJSON(vars.ci_runner_gate || '"ubuntu-latest"')`)).toEqual([]);
  });

  it("never reads a job of a pull_request_target workflow as guarded", () => {
    expect(
      check(workflow({ on: "on:\n  pull_request_target:", ifValue: guarded(null) })),
    ).toEqual(listed("EXAMPLE"));
  });

  it("reads a workflow_call workflow as a pull request workflow: listed without the condition", () => {
    expect(check(workflow({ on: "on:\n  workflow_call:" }))).toEqual(listed("EXAMPLE"));
  });

  it("reads a workflow_call workflow as a pull request workflow: not listed with the condition", () => {
    expect(check(workflow({ on: "on:\n  workflow_call:", ifValue: guarded(null) }))).toEqual([]);
  });

  it("checks a workflow whose triggers are a flow mapping or are missing", () => {
    expect(check(workflow({ on: "on: {pull_request: {}}" }))).toEqual(listed("EXAMPLE"));
    expect(check(workflow({ on: "on: {pull_request_target: {}}", ifValue: guarded(null) }))).toEqual(listed("EXAMPLE"));
    expect(check(workflow({ on: "name: example" }))).toEqual(listed("EXAMPLE"));
  });

  it("refuses a job whose keys are not at four spaces, or a quoted runs-on key, as unreadable", () => {
    expect(
      check(`on: pull_request
jobs:
  render:
      runs-on: \${{ vars.CI_RUNNER_EXAMPLE }}
`),
    ).toEqual(listed("unreadable"));
    expect(
      check(`on: pull_request
jobs:
  render:
    "runs-on": \${{ vars.CI_RUNNER_EXAMPLE }}
`),
    ).toEqual(listed("unreadable"));
  });

  it("reads a quoted runs-on value holding a # whole", () => {
    expect(
      check(workflow({ runsOnValue: `"\${{ contains(' # ', 'x') && 'ubuntu-latest' || vars.CI_RUNNER_EXAMPLE }}"` })),
    ).toEqual(listed("EXAMPLE"));
    expect(check(workflow({ runsOnValue: `"\${{ vars.CI_RUNNER_EXAMPLE }} # x` }))).toEqual(listed("unreadable"));
  });

  // twin: r7 unchanged: an unresolved index, an alias and a merge key refuse as unreadable; a longer name is no read
  it("r7 refuses an if taken from an alias as unreadable, also beside a guarded runs-on", () => {
    expect(
      check(`on: pull_request
jobs:
  setup:
    if: &guard \${{ ${C} }}
    runs-on: ${runsOn("GATE")}
  render:
    if: *guard
    runs-on: \${{ ${C} && vars.CI_RUNNER_EXAMPLE || 'ubuntu-latest' }}
`),
    ).toEqual(listed("unreadable"));
  });
});
