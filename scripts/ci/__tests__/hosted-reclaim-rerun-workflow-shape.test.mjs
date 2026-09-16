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

  it("also runs on a weekly schedule, so the count posts on a fixed cadence", () => {
    expect(workflow).toMatch(/^ {2}schedule:\s*$/m);
    expect(workflow).toMatch(/^ {4}- cron: "\d+ \d+ \* \* 1"\s*$/m);
  });

  it("never watches itself (a re-run would otherwise feed the watcher its own runs)", () => {
    const nameLine = workflow.match(/^name: (.+)$/m);
    expect(nameLine).not.toBeNull();
    expect(WATCHED).not.toContain(nameLine[1].trim());
  });
});

const jobBlock = (id) => {
  const from = workflow.indexOf(`\n  ${id}:\n`);
  expect(from).toBeGreaterThan(-1);
  const rest = workflow.slice(from + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

// Resolved LAZILY, inside each test. A job that is missing must fail the one
// assertion that asks for it, not the whole file at collection time — that is
// what makes each criterion below red on its own before the job exists.
const RERUN_JOB = () => jobBlock("reclaim-rerun");
const WEEKLY_JOB = () => jobBlock("weekly-count");

describe("hosted-reclaim-rerun.yml: what it is permitted to do", () => {
  it("grants nothing but contents: read at the top, so each job asks for its own", () => {
    const block = workflow.slice(
      workflow.indexOf("\npermissions:"),
      workflow.indexOf("\nconcurrency:"),
    );
    const scopes = block
      .split("\n")
      .filter((l) => /^ {2}\S+: \S+$/.test(l))
      .map((l) => l.trim().split(":")[0]);
    expect(scopes).toEqual(["contents"]);
    expect(block).toMatch(/^ {2}contents: read$/m);
  });

  it("gives the re-run job actions: write and contents: read, and nothing else", () => {
    const scopes = RERUN_JOB().split("\n")
      .filter((l) => /^ {6}\S+: \S+$/.test(l))
      .map((l) => l.trim().split(":")[0]);
    expect(scopes.sort()).toEqual(["actions", "contents"]);
    expect(RERUN_JOB()).not.toMatch(/issues:\s*write/);
  });

  it("gives the weekly count issues: write and never actions: write", () => {
    const scopes = WEEKLY_JOB().split("\n")
      .filter((l) => /^ {6}\S+: \S+$/.test(l))
      .map((l) => l.trim().split(":")[0]);
    expect(scopes.sort()).toEqual(["actions", "contents", "issues"]);
    expect(WEEKLY_JOB()).toMatch(/^ {6}issues: write$/m);
    expect(WEEKLY_JOB()).toMatch(/^ {6}actions: read$/m);
    expect(WEEKLY_JOB()).not.toMatch(/actions:\s*write/);
  });

  it("never asks for pull-requests: write, and the watcher module writes nothing on an issue", () => {
    expect(workflow).not.toMatch(/pull-requests:\s*write/);
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

// ---------------------------------------------------------------------------
// The weekly count (item 3) is a JOB OF THIS WORKFLOW, not a workflow of its
// own, and it can neither re-run anything nor open an issue.
// ---------------------------------------------------------------------------

const WEEKLY_MODULE_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "ci",
  "reclaim-weekly-count.mjs",
);
// Read LAZILY, for the same reason as the job blocks above: a missing module
// must redden the assertion that asks for it, not the whole file.
const weeklyModuleText = () => fs.readFileSync(WEEKLY_MODULE_PATH, "utf8");

describe("hosted-reclaim-rerun.yml: the weekly reclaim count", () => {
  it("is a scheduled job of THIS workflow", () => {
    expect(workflow).toContain("\n  weekly-count:\n");
    expect(WEEKLY_JOB()).toContain("github.event_name == 'schedule'");
    expect(WEEKLY_JOB()).toContain("node scripts/ci/reclaim-weekly-count.mjs");
  });

  it("runs only for this repository and is bounded", () => {
    expect(WEEKLY_JOB()).toContain("github.repository == 'cinatra-ai/cinatra'");
    expect(WEEKLY_JOB()).toMatch(/^ {4}timeout-minutes: 5$/m);
  });

  it("never re-runs a job from the scheduled side", () => {
    expect(WEEKLY_JOB()).not.toContain("hosted-reclaim-rerun.mjs");
    expect(weeklyModuleText()).not.toContain("/rerun");
    expect(weeklyModuleText()).not.toContain("rerun-failed-jobs");
  });

  it("appends a comment to the tracking issue and opens none", () => {
    expect(weeklyModuleText()).toContain("/issues/${TRACKING_ISSUE}/comments");
    expect(weeklyModuleText()).not.toMatch(/POST \$\{API\}\/repos\/\$\{REPOSITORY\}\/issues"/);
    const posts = [...weeklyModuleText().matchAll(/method: "POST"/g)];
    expect(posts).toHaveLength(1);
  });

  it("imports node builtins and its own siblings only (it runs before any install)", () => {
    const imports = [
      ...weeklyModuleText().matchAll(/from "([^"]+)";/g),
    ].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec.startsWith("node:") || spec.startsWith("./")).toBe(true);
    }
  });
});

describe("the re-run job keeps the record the count is computed from", () => {
  it("uploads exactly one ledger artifact, sha-pinned, and only when a re-run happened", () => {
    expect(RERUN_JOB()).toMatch(
      /uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+/,
    );
    expect(RERUN_JOB()).toContain("steps.decide.outputs.ledger_name != ''");
    expect(RERUN_JOB()).toContain("name: ${{ steps.decide.outputs.ledger_name }}");
    expect(RERUN_JOB()).toContain("if-no-files-found: error");
  });

  it("the watcher writes that name as a step output", () => {
    expect(moduleText).toContain("ledger_name=");
    expect(moduleText).toContain("GITHUB_OUTPUT");
  });
});
