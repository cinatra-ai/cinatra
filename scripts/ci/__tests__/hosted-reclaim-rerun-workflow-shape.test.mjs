// Hosted-runner reclaim re-run watcher (cinatra#3316): the SHAPE of the
// shipped workflow and module, read from the real files in this repo.
//
// The decision core is unit-tested next door. This file guards the parts a
// unit test cannot reach: which workflows the watcher listens to, what it is
// permitted to do with the repository token, that it never checks out the head
// under test, and that the module can never reach the run-level
// re-run-all-failed-jobs endpoint.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ALLOWLIST } from "../hosted-reclaim-rerun.mjs";

const REPO_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
);
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github",
  "workflows",
  "hosted-reclaim-rerun.yml",
);
const MODULE_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "ci",
  "hosted-reclaim-rerun.mjs",
);

const workflow = fs.readFileSync(WORKFLOW_PATH, "utf8");
const moduleText = fs.readFileSync(MODULE_PATH, "utf8");

const WATCHED = [
  "design-visual-verify",
  "dashboard-live-verify",
  "Build and publish image",
];

describe("hosted-reclaim-rerun.yml: what it listens to", () => {
  it("triggers on workflow_run completion", () => {
    expect(workflow).toMatch(/^on:\s*$/m);
    expect(workflow).toMatch(/^ {2}workflow_run:\s*$/m);
    expect(workflow).toMatch(/^ {4}types: \[completed\]\s*$/m);
  });

  it("watches exactly the three build-carrying workflows, by their exact names", () => {
    const block = workflow.slice(
      workflow.indexOf("workflows:"),
      workflow.indexOf("types: [completed]"),
    );
    for (const name of WATCHED) {
      expect(block).toContain(`"${name}"`);
    }
    const listed = block
      .split("\n")
      .filter((l) => /^\s*- /.test(l))
      .map((l) => l.replace(/^\s*- /, "").trim().replace(/^"|"$/g, ""));
    expect(listed).toEqual(WATCHED);
  });

  it("watches exactly the workflows the allowlist covers — no more, no less", () => {
    expect([...new Set(ALLOWLIST.map((e) => e.workflow))].sort()).toEqual(
      [...WATCHED].sort(),
    );
  });

  it("never watches itself (a re-run would otherwise feed the watcher its own runs)", () => {
    const nameLine = workflow.match(/^name: (.+)$/m);
    expect(nameLine).not.toBeNull();
    expect(WATCHED).not.toContain(nameLine[1].trim());
  });
});

describe("hosted-reclaim-rerun.yml: what it is permitted to do", () => {
  it("takes actions: write and contents: read, and nothing else", () => {
    const block = workflow.slice(
      workflow.indexOf("\npermissions:"),
      workflow.indexOf("\nconcurrency:"),
    );
    expect(block).toMatch(/^ {2}actions: write$/m);
    expect(block).toMatch(/^ {2}contents: read$/m);
    const scopes = block
      .split("\n")
      .filter((l) => /^ {2}\S+: \S+$/.test(l))
      .map((l) => l.trim().split(":")[0]);
    expect(scopes.sort()).toEqual(["actions", "contents"]);
  });

  it("never asks for pull-requests: write or issues: write (it posts nothing on the pull request and opens no issue)", () => {
    expect(workflow).not.toMatch(/pull-requests:\s*write/);
    expect(workflow).not.toMatch(/issues:\s*write/);
    expect(moduleText).not.toMatch(/\/issues/);
    expect(moduleText).not.toMatch(/\/comments/);
  });

  it("never reaches the run-level re-run-all-failed-jobs endpoint", () => {
    expect(moduleText).not.toContain("rerun-failed-jobs");
    expect(workflow).not.toContain("rerun-failed-jobs");
    expect(moduleText).toContain("/actions/jobs/");
  });
});

describe("hosted-reclaim-rerun.yml: it never runs the head under test", () => {
  it("checks out the DEFAULT branch, sha-pinned, credentials not persisted", () => {
    expect(workflow).toMatch(
      /uses: actions\/checkout@[0-9a-f]{40} # v\d+\.\d+\.\d+/,
    );
    expect(workflow).toContain(
      "ref: ${{ github.event.repository.default_branch }}",
    );
    expect(workflow).toMatch(/^ {10}persist-credentials: false$/m);
  });

  it("never checks out the triggering run's head sha or branch", () => {
    expect(workflow).not.toContain("workflow_run.head_sha }}\n");
    expect(workflow).not.toMatch(/ref: \$\{\{ github\.event\.workflow_run\./);
  });

  it("serializes per source run and is bounded to five minutes", () => {
    expect(workflow).toContain(
      "group: hosted-reclaim-rerun-${{ github.event.workflow_run.id }}",
    );
    expect(workflow).toMatch(/^ {4}timeout-minutes: 5$/m);
  });

  it("runs only for this repository", () => {
    expect(workflow).toContain("github.repository == 'cinatra-ai/cinatra'");
  });
});

describe("hosted-reclaim-rerun.mjs: dependency-free", () => {
  it("imports node builtins only (it runs before any install)", () => {
    const imports = [...moduleText.matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (m) => m[1],
    );
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec.startsWith("node:")).toBe(true);
  });
});
