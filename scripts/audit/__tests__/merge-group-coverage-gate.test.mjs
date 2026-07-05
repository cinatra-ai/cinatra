import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONTEXT_WORKFLOW,
  REPO_ROOT,
  computeDefects,
  extractOnBlock,
  onDeclaresMergeGroup,
} from "../merge-group-coverage-gate.mjs";

describe("onDeclaresMergeGroup", () => {
  it("detects a block-mapping merge_group event key (bare)", () => {
    const yaml = ["on:", "  pull_request:", "  push:", "    branches: [main]", "  merge_group:", "", "jobs:"].join("\n");
    expect(onDeclaresMergeGroup(yaml)).toBe(true);
  });

  it("is false when merge_group is absent", () => {
    const yaml = ["on:", "  pull_request:", "  push:", "    branches: [main]", "", "jobs:"].join("\n");
    expect(onDeclaresMergeGroup(yaml)).toBe(false);
  });

  it("does not match a comment that merely mentions merge_group", () => {
    const yaml = ["on:", "  # merge_group is intentionally omitted here", "  pull_request:", "", "jobs:"].join("\n");
    expect(onDeclaresMergeGroup(yaml)).toBe(false);
  });

  it("stops at the next top-level key (does not leak into permissions)", () => {
    const yaml = ["on:", "  pull_request:", "", "permissions:", "  merge_group: read", "", "jobs:"].join("\n");
    // `merge_group:` under permissions is NOT an event trigger.
    expect(onDeclaresMergeGroup(yaml)).toBe(false);
    expect(extractOnBlock(yaml).body.some((l) => l.includes("permissions"))).toBe(false);
  });

  it("handles the inline flow-sequence form", () => {
    expect(onDeclaresMergeGroup("on: [push, merge_group]\njobs:")).toBe(true);
    expect(onDeclaresMergeGroup("on: [push, pull_request]\njobs:")).toBe(false);
  });

  it("handles the inline scalar form", () => {
    expect(onDeclaresMergeGroup("on: merge_group\njobs:")).toBe(true);
    expect(onDeclaresMergeGroup("on: push\njobs:")).toBe(false);
  });

  it("does NOT match a merge_group key nested under another event (fail-open guard)", () => {
    // `merge_group:` here configures the `push` event, it is NOT a top-level
    // trigger — the workflow would never run on a merge_group event.
    const yaml = ["on:", "  push:", "    merge_group: bogus", "", "jobs:"].join("\n");
    expect(onDeclaresMergeGroup(yaml)).toBe(false);
  });

  it("still matches a top-level merge_group alongside deeper nested config", () => {
    const yaml = ["on:", "  push:", "    branches: [main]", "  merge_group:", "", "jobs:"].join("\n");
    expect(onDeclaresMergeGroup(yaml)).toBe(true);
  });

  it("tolerates a trailing YAML comment on the inline forms", () => {
    expect(onDeclaresMergeGroup("on: merge_group # queue only\njobs:")).toBe(true);
    expect(onDeclaresMergeGroup("on: [push, merge_group] # + queue\njobs:")).toBe(true);
    expect(onDeclaresMergeGroup("on: push # not queued\njobs:")).toBe(false);
  });

  it("handles the YAML block-sequence form", () => {
    expect(onDeclaresMergeGroup(["on:", "  - push", "  - merge_group", "", "jobs:"].join("\n"))).toBe(true);
    expect(onDeclaresMergeGroup(["on:", "  - push", "  - pull_request", "", "jobs:"].join("\n"))).toBe(false);
  });
});

describe("computeDefects", () => {
  const COVERED = "on:\n  pull_request:\n  merge_group:\n";
  const UNCOVERED = "on:\n  pull_request:\n";

  function fixtureWorkflowText(map) {
    return (base) => (base in map ? map[base] : null);
  }

  it("passes a fully covered configuration", () => {
    const defects = computeDefects({
      requiredContexts: ["ctx-a", "gate / gate"],
      contextWorkflow: { "ctx-a": "a.yml", "gate / gate": "gate.yml" },
      workflowText: fixtureWorkflowText({ "a.yml": COVERED, "gate.yml": COVERED }),
      suiteRequiredContexts: [
        { context: "gate / gate", callerPath: ".github/workflows/gate.yml", allowedEvents: ["pull_request", "push", "merge_group"] },
      ],
    });
    expect(defects).toEqual([]);
  });

  it("flags a required context with no mapping (fail-closed)", () => {
    const defects = computeDefects({
      requiredContexts: ["ctx-a", "ctx-new"],
      contextWorkflow: { "ctx-a": "a.yml" },
      workflowText: fixtureWorkflowText({ "a.yml": COVERED }),
      suiteRequiredContexts: [],
    });
    expect(defects.some((d) => d.includes("ctx-new") && d.includes("no CONTEXT_WORKFLOW mapping"))).toBe(true);
  });

  it("flags a stale mapping entry", () => {
    const defects = computeDefects({
      requiredContexts: ["ctx-a"],
      contextWorkflow: { "ctx-a": "a.yml", "ctx-gone": "gone.yml" },
      workflowText: fixtureWorkflowText({ "a.yml": COVERED, "gone.yml": COVERED }),
      suiteRequiredContexts: [],
    });
    expect(defects.some((d) => d.includes("ctx-gone") && d.includes("stale mapping"))).toBe(true);
  });

  it("flags a mapped workflow that lacks merge_group", () => {
    const defects = computeDefects({
      requiredContexts: ["ctx-a"],
      contextWorkflow: { "ctx-a": "a.yml" },
      workflowText: fixtureWorkflowText({ "a.yml": UNCOVERED }),
      suiteRequiredContexts: [],
    });
    expect(defects.some((d) => d.includes("ctx-a") && d.includes("does not trigger on"))).toBe(true);
  });

  it("flags a mapped workflow file that is missing", () => {
    const defects = computeDefects({
      requiredContexts: ["ctx-a"],
      contextWorkflow: { "ctx-a": "missing.yml" },
      workflowText: fixtureWorkflowText({}),
      suiteRequiredContexts: [],
    });
    expect(defects.some((d) => d.includes("missing.yml") && d.includes("does not exist"))).toBe(true);
  });

  it("flags a gate-suite allowedEvents that omits merge_group", () => {
    const defects = computeDefects({
      requiredContexts: ["gate / gate"],
      contextWorkflow: { "gate / gate": "gate.yml" },
      workflowText: fixtureWorkflowText({ "gate.yml": COVERED }),
      suiteRequiredContexts: [
        { context: "gate / gate", allowedEvents: ["pull_request", "push"] },
      ],
    });
    expect(defects.some((d) => d.includes("allowedEvents omits"))).toBe(true);
  });

  it("flags a gate-suite callerPath that is not merge_group-aware", () => {
    const defects = computeDefects({
      requiredContexts: ["gate / gate"],
      contextWorkflow: { "gate / gate": "gate.yml" },
      workflowText: fixtureWorkflowText({ "gate.yml": UNCOVERED }),
      suiteRequiredContexts: [
        { context: "gate / gate", callerPath: ".github/workflows/gate.yml", allowedEvents: ["pull_request", "push", "merge_group"] },
      ],
    });
    expect(defects.some((d) => d.includes("callerPath") && d.includes("does not trigger on"))).toBe(true);
  });
});

describe("live repository coverage", () => {
  const branchProtections = JSON.parse(
    readFileSync(join(REPO_ROOT, ".github", "branch-protections.json"), "utf8"),
  );
  const gateSuite = JSON.parse(
    readFileSync(join(REPO_ROOT, ".github", "gate-suite.json"), "utf8"),
  );

  it("has zero coverage defects on the committed tree", () => {
    const workflowText = (base) => {
      const p = join(REPO_ROOT, ".github", "workflows", base);
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    };
    const defects = computeDefects({
      requiredContexts: branchProtections.required_status_checks.contexts,
      contextWorkflow: CONTEXT_WORKFLOW,
      workflowText,
      suiteRequiredContexts: gateSuite.requiredContexts,
    });
    expect(defects).toEqual([]);
  });

  it("maps exactly the branch-protection required-context set", () => {
    const required = new Set(branchProtections.required_status_checks.contexts);
    const mapped = new Set(Object.keys(CONTEXT_WORKFLOW));
    expect([...mapped].sort()).toEqual([...required].sort());
  });
});
