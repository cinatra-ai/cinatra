// merge-group coverage guard (engineering#484): unit tests over the pure core
// + the LIVE enforcement test. The live test at the bottom is the actual
// guard: it runs the coverage check against THIS repo's .github/workflows and
// gate-suite.json inside the root Vitest suite (gate of record), so removing a
// merge_group trigger from a required-context workflow — or adding a required
// context without coverage — reds a required check.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_CONTEXTS,
  checkMergeGroupCoverage,
  contextJobName,
  displayNameOf,
  parseJobs,
  parseTriggers,
  runGuard,
} from "../merge-group-coverage-guard.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

const CALLER = (triggers) => `name: some-gate

on:
${triggers}

jobs:
  some-gate:
    uses: cinatra-ai/ci/.github/workflows/some-gate.yml@0000000000000000000000000000000000000000 # v0
    with:
      ref: 0000000000000000000000000000000000000000
`;

const COVERED = CALLER("  pull_request:\n  merge_group:\n  push:\n    branches: [main]");
const UNCOVERED = CALLER("  pull_request:\n  push:\n    branches: [main]");

describe("parseTriggers", () => {
  it("reads a block-mapping on: (nested trigger config and comments ignored)", () => {
    const text = `name: x
on:
  push:
    branches: [main]
    # a comment inside the block
    paths-ignore:
      - 'docs/**'
  pull_request:
    types: [opened, synchronize]
  merge_group:
  workflow_dispatch:

permissions:
  contents: read
`;
    expect(parseTriggers(text)).toEqual(["push", "pull_request", "merge_group", "workflow_dispatch"]);
  });

  it("reads flow-list and scalar forms", () => {
    expect(parseTriggers("on: [push, pull_request]\n")).toEqual(["push", "pull_request"]);
    expect(parseTriggers("on: push\n")).toEqual(["push"]);
  });

  it("returns null when there is no top-level on: (fail closed upstream)", () => {
    expect(parseTriggers("name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n")).toBeNull();
  });

  it("does not mistake an indented or commented 'on:' for the trigger block", () => {
    const text = `name: x
# on: this comment is not a trigger
jobs:
  a:
    steps:
      - run: echo on
on:
  merge_group:
`;
    expect(parseTriggers(text)).toEqual(["merge_group"]);
  });
});

describe("parseJobs / displayNameOf / contextJobName", () => {
  it("extracts job keys and first-level names (check-run name = name ?? key)", () => {
    const text = `name: x
on:
  push:
jobs:
  detect:
    name: Detect things
    runs-on: ubuntu-latest
  build:
    runs-on: ubuntu-latest
    steps:
      - name: not a job name
        run: echo hi
`;
    const jobs = parseJobs(text);
    expect(jobs.map(displayNameOf)).toEqual(["Detect things", "build"]);
  });

  it("maps a reusable-caller context to its caller job", () => {
    expect(contextJobName("skills-drift-gate / skills-drift-gate")).toBe("skills-drift-gate");
    expect(contextJobName("build")).toBe("build");
  });
});

describe("checkMergeGroupCoverage — failure modes (all fail closed)", () => {
  it("passes for a covered caller", () => {
    const r = checkMergeGroupCoverage({
      requiredContexts: ["some-gate / some-gate"],
      workflows: [{ file: "some-gate.yml", text: COVERED }],
      gateSuite: null,
    });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("flags a required context whose workflow lacks merge_group", () => {
    const r = checkMergeGroupCoverage({
      requiredContexts: ["some-gate / some-gate"],
      workflows: [{ file: "some-gate.yml", text: UNCOVERED }],
      gateSuite: null,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/does not trigger on 'merge_group'/);
  });

  it("flags an unresolvable and an ambiguous context", () => {
    const none = checkMergeGroupCoverage({ requiredContexts: ["ghost"], workflows: [{ file: "a.yml", text: COVERED }], gateSuite: null });
    expect(none.ok).toBe(false);
    expect(none.problems.join("\n")).toMatch(/no workflow .* defines a job named 'ghost'/);

    const dup = checkMergeGroupCoverage({
      requiredContexts: ["some-gate / some-gate"],
      workflows: [
        { file: "a.yml", text: COVERED },
        { file: "b.yml", text: COVERED },
      ],
      gateSuite: null,
    });
    expect(dup.ok).toBe(false);
    expect(dup.problems.join("\n")).toMatch(/ambiguous across a\.yml, b\.yml/);
  });

  it("flags a workflow with an unparseable on: block", () => {
    const r = checkMergeGroupCoverage({
      requiredContexts: ["some-gate / some-gate"],
      workflows: [{ file: "some-gate.yml", text: COVERED.replace(/^on:$/m, "onn:") }],
      gateSuite: null,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/could not parse a top-level 'on:'/);
  });

  const suiteWith = (entry) => ({ requiredContexts: [{ context: "some-gate / some-gate", ...entry }] });

  it("gate-suite: allowedEvents must include merge_group; malformed fails closed (WF-id F1 semantics)", () => {
    const wf = [{ file: "some-gate.yml", text: COVERED }];
    const rc = ["some-gate / some-gate"];

    const missing = checkMergeGroupCoverage({ requiredContexts: rc, workflows: wf, gateSuite: suiteWith({ allowedEvents: ["pull_request", "push"] }) });
    expect(missing.ok).toBe(false);
    expect(missing.problems.join("\n")).toMatch(/excludes 'merge_group'/);

    for (const bad of ["pull_request", [], [123], ["push", ""], {}]) {
      const r = checkMergeGroupCoverage({ requiredContexts: rc, workflows: wf, gateSuite: suiteWith({ allowedEvents: bad }) });
      expect(r.ok, `allowedEvents=${JSON.stringify(bad)}`).toBe(false);
      expect(r.problems.join("\n")).toMatch(/malformed 'allowedEvents'/);
    }

    const ok = checkMergeGroupCoverage({ requiredContexts: rc, workflows: wf, gateSuite: suiteWith({ allowedEvents: ["pull_request", "push", "merge_group"] }) });
    expect(ok.problems).toEqual([]);
  });

  it("gate-suite: a declared callerPath must match the resolved workflow; malformed fails closed", () => {
    const wf = [{ file: "some-gate.yml", text: COVERED }];
    const rc = ["some-gate / some-gate"];

    const ok = checkMergeGroupCoverage({ requiredContexts: rc, workflows: wf, gateSuite: suiteWith({ callerPath: ".github/workflows/some-gate.yml" }) });
    expect(ok.problems).toEqual([]);

    const mismatch = checkMergeGroupCoverage({ requiredContexts: rc, workflows: wf, gateSuite: suiteWith({ callerPath: ".github/workflows/other.yml" }) });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.problems.join("\n")).toMatch(/disagree/);

    const malformed = checkMergeGroupCoverage({ requiredContexts: rc, workflows: wf, gateSuite: suiteWith({ callerPath: "" }) });
    expect(malformed.ok).toBe(false);
    expect(malformed.problems.join("\n")).toMatch(/malformed 'callerPath'/);
  });

  it("gate-suite: a suite context outside the REQUIRED_CONTEXTS mirror is flagged (no silent drift)", () => {
    const r = checkMergeGroupCoverage({
      requiredContexts: [],
      workflows: [{ file: "some-gate.yml", text: COVERED }],
      gateSuite: suiteWith({}),
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/not in the guard's REQUIRED_CONTEXTS mirror/);
  });
});

describe("LIVE enforcement (the guard itself, engineering#484)", () => {
  it("every mirrored required context and gate-suite entry in THIS repo is merge_group-covered", () => {
    const r = runGuard(REPO_ROOT);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("the mirror still lists all 5 org gates + the repo-local required contexts", () => {
    for (const gate of ["truthful-attribution-gate", "source-leak-gate", "ui-design-system-gate", "skills-drift-gate", "secrets-required-gate"]) {
      expect(REQUIRED_CONTEXTS).toContain(`${gate} / ${gate}`);
    }
    expect(REQUIRED_CONTEXTS).toContain("CRM migration gates");
    expect(REQUIRED_CONTEXTS).toContain("build");
    expect(REQUIRED_CONTEXTS).toContain("proof");
  });
});
