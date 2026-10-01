// Changed-path detection for a merge-queue candidate (engineering#658 item 1).
//
// GitHub does not apply a workflow's `paths:` filter to a `merge_group` event:
// the queue fires every workflow that declares the trigger. A path-filtered
// suite therefore has to answer the path question itself, over the group's own
// base..head range, and it must answer it from the SAME list the pull-request
// filter uses — a second, hand-copied list is a list that drifts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  matchesAnyPattern,
  parseTriggerPaths,
  selectApplies,
} from "../merge-group-path-select.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const WORKFLOW = ".github/workflows/execution-plane-e2e.yml";
const TEXT = fs.readFileSync(path.join(REPO_ROOT, WORKFLOW), "utf8");

describe("parseTriggerPaths", () => {
  it("reads the pull_request paths list of the live execution-plane workflow", () => {
    const patterns = parseTriggerPaths(TEXT, "pull_request");
    expect(patterns).toContain("packages/execution-plane/**");
    expect(patterns).toContain(WORKFLOW);
    expect(patterns.length).toBeGreaterThan(5);
  });

  it("reads single-quoted, double-quoted and bare entries, comments out", () => {
    const text = `on:
  pull_request:
    branches: [main]
    paths:
      - 'a/**'
      # a comment inside the list
      - "b/c.ts"
      - d/**
  merge_group:
jobs:
  x:
`;
    expect(parseTriggerPaths(text, "pull_request")).toEqual(["a/**", "b/c.ts", "d/**"]);
  });

  it("returns null when the trigger declares no paths (caller fails closed)", () => {
    expect(parseTriggerPaths("on:\n  pull_request:\n  merge_group:\n", "pull_request")).toBeNull();
  });
});

describe("matchesAnyPattern", () => {
  it("treats ** as any depth and * as one segment", () => {
    expect(matchesAnyPattern("packages/execution-plane/src/a.ts", ["packages/execution-plane/**"])).toBe(true);
    expect(matchesAnyPattern("packages/llm/src/a.ts", ["packages/execution-plane/**"])).toBe(false);
    expect(matchesAnyPattern("docker/sandbox/Dockerfile", ["docker/*/Dockerfile"])).toBe(true);
    expect(matchesAnyPattern("docker/sandbox/nested/Dockerfile", ["docker/*/Dockerfile"])).toBe(false);
    expect(matchesAnyPattern("docker-compose.exec.yml", ["docker-compose.exec.yml"])).toBe(true);
  });
});

describe("selectApplies — the queue's own base..head range", () => {
  const patterns = parseTriggerPaths(TEXT, "pull_request");

  it("selects the suite when the group touches a plane path", () => {
    const decision = selectApplies({
      changedFiles: ["README.md", "packages/execution-plane/src/runner.ts"],
      patterns,
    });
    expect(decision.applies).toBe(true);
    expect(decision.matched).toContain("packages/execution-plane/src/runner.ts");
  });

  it("produces the green stub when the group touches only docs", () => {
    const decision = selectApplies({
      changedFiles: ["docs/a.md", "docs/b.md"],
      patterns,
    });
    expect(decision.applies).toBe(false);
    expect(decision.matched).toEqual([]);
  });

  it("fails closed — an unusable pattern list or file list runs the suite", () => {
    expect(selectApplies({ changedFiles: ["docs/a.md"], patterns: null }).applies).toBe(true);
    expect(selectApplies({ changedFiles: null, patterns }).applies).toBe(true);
  });
});
