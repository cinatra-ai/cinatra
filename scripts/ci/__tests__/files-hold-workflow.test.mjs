// The files-hold workflow, tested as the other workflow files are.
//
// It runs on pull_request_target, so it runs with a token that can write and
// for pull requests from forks too. What keeps that safe is pinned here: it
// runs on exactly the seven pull request events, by hand and on an hourly
// schedule, with exactly three permissions and each job with the least of
// them; it checks out the default branch only and runs the script from there,
// never a pull request's head or merge ref; no value of the event reaches a
// shell; every action is pinned by commit. The order is pinned too: a first
// job takes the label off a pushed pull request, in a group of its own for
// each pull request, and the evaluation runs after it, one at a time for the
// whole repository. The workflow is read LINE-BASED with the repository's own
// parsers rather than through a yaml dependency, as the other workflow tests
// read theirs.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanWorkflowText } from "../../audit/actions-pinned-gate.mjs";
import { parseJobs, parseTriggers } from "../merge-group-coverage-guard.mjs";
import { parseJobAttrs } from "../merge-readiness-inventory.mjs";
import { CONTEXT } from "../files-hold.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = ".github/workflows/files-hold.yml";
const read = () => readFileSync(resolve(REPO_ROOT, WORKFLOW), "utf8");

const END_HOLD = "files-hold-end-hold";
const EVALUATION = "files-hold-evaluation";
const RUNNER = "${{ fromJSON(vars.CI_RUNNER_GATE || '\"ubuntu-latest\"') }}";

/** Whole-line comments are invisible: a commented-out key is not one. */
const uncommented = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** The lines of the mapping under `key:` at `indent` spaces, blank lines dropped. */
function block(lines, key, indent) {
  const pad = " ".repeat(indent);
  const start = lines.findIndex((line) => line === `${pad}${key}:`);
  if (start === -1) return null;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (!line.startsWith(`${pad}  `)) break;
    out.push(line);
  }
  return out;
}

/** A mapping of scalar values under `key:` at `indent` spaces, as an object. */
function mapping(lines, key, indent) {
  const found = block(lines, key, indent);
  if (found === null) return null;
  const out = {};
  for (const line of found) {
    const pair = new RegExp(`^ {${indent + 2}}([A-Za-z-]+):\\s*(.+?)\\s*$`).exec(line);
    if (!pair) throw new Error(`${WORKFLOW}: ${key}: unexpected line ${JSON.stringify(line)}`);
    out[pair[1]] = pair[2];
  }
  return out;
}

const lines = () => uncommented(read()).split("\n");
const job = (key) => block(lines(), key, 2);

/** The `types:` list of the pull_request_target trigger. */
function targetTypes() {
  const trigger = block(lines(), "on", 0);
  const types = trigger?.map((line) => /^ {4}types:\s*\[(.*)\]\s*$/.exec(line)).find(Boolean);
  return types ? types[1].split(",").map((s) => s.trim()).filter(Boolean) : null;
}

/** The steps of one job, each as its lines. */
function steps(key) {
  const out = [];
  for (const line of block(job(key), "steps", 4) ?? []) {
    if (/^ {6}- /.test(line)) out.push([]);
    out.at(-1)?.push(line);
  }
  return out;
}

const PULL_REQUEST_REFS = [
  "github.event.pull_request.head",
  "github.event.pull_request.merge_commit_sha",
  "github.head_ref",
  "refs/pull/",
  "allow-unsafe-pr-checkout",
];

describe("the files-hold workflow", () => {
  it("parses, with two jobs: the label first, then the evaluation", () => {
    const text = read();
    expect(parseTriggers(text)).not.toBeNull();
    expect(parseJobs(text).map((j) => j.key)).toEqual([END_HOLD, EVALUATION]);
  });

  it("runs on pull_request_target, on exactly the seven pull request events, by hand and on a schedule", () => {
    expect(parseTriggers(read())).toEqual(["pull_request_target", "schedule", "workflow_dispatch"]);
    expect([...targetTypes()].sort()).toEqual(
      ["closed", "labeled", "opened", "ready_for_review", "reopened", "synchronize", "unlabeled"],
    );
  });

  it("runs on an hourly schedule of exactly one cron line, so that an expiry takes effect without an event", () => {
    expect(block(lines(), "schedule", 2)).toEqual(['    - cron: "17 * * * *"']);
  });

  it("holds exactly three permissions, and each job only the ones it needs", () => {
    expect(mapping(lines(), "permissions", 0)).toEqual({ contents: "read", "pull-requests": "write", statuses: "write" });
    expect(mapping(job(END_HOLD), "permissions", 4)).toEqual({ contents: "read", "pull-requests": "write" });
    expect(mapping(job(EVALUATION), "permissions", 4)).toEqual({
      contents: "read",
      "pull-requests": "read",
      statuses: "write",
    });
  });

  it("takes the label off in a group of its own for each pull request, never cancelled", () => {
    expect(block(lines(), "concurrency", 0)).toBeNull();
    expect(parseJobAttrs(read()).get(END_HOLD).if).toBe(
      "github.event_name == 'pull_request_target' && github.event.action == 'synchronize'",
    );
    expect(mapping(job(END_HOLD), "concurrency", 4)).toEqual({
      group: "${{ github.workflow }}-end-hold-${{ github.event.pull_request.number || github.run_id }}",
      "cancel-in-progress": "false",
    });
  });

  it("evaluates after that job, whatever it did, one evaluation at a time for the whole repository", () => {
    expect(job(EVALUATION)).toContain(`    needs: ${END_HOLD}`);
    expect(parseJobAttrs(read()).get(EVALUATION).if).toBe("${{ !cancelled() }}");
    expect(mapping(job(EVALUATION), "concurrency", 4)).toEqual({
      group: "${{ github.workflow }}-evaluation",
      "cancel-in-progress": "false",
    });
  });

  it("runs both jobs on the gate runner, within a time budget", () => {
    const attrs = parseJobAttrs(read());
    for (const key of [END_HOLD, EVALUATION]) {
      expect(attrs.get(key).timeoutMinutes, key).toBeGreaterThan(0);
      expect(job(key), key).toContain(`    runs-on: ${RUNNER}`);
    }
  });

  it("names its jobs apart from the status, so a required check of that name is the status alone", () => {
    for (const j of parseJobs(read())) expect(j.name ?? j.key).not.toBe(CONTEXT);
  });

  it("checks out the default branch only, without keeping the token", () => {
    for (const key of [END_HOLD, EVALUATION]) {
      const checkouts = steps(key).filter((step) => /uses: actions\/checkout@/.test(step[0]));
      expect(checkouts, key).toHaveLength(1);
      const body = checkouts[0].join("\n");
      expect(body, key).toMatch(/^ {10}ref: \$\{\{ github\.event\.repository\.default_branch \}\}$/m);
      expect(body, key).toMatch(/^ {10}persist-credentials: false$/m);
      expect(body, key).not.toMatch(/^ {10}repository:/m);
    }
    for (const ref of PULL_REQUEST_REFS) expect(uncommented(read()), ref).not.toContain(ref);
  });

  it("runs the script with node from that checkout, and no value of the event reaches the shell", () => {
    for (const [key, command] of [[END_HOLD, "end-hold"], [EVALUATION, "evaluate"]]) {
      const runs = steps(key).filter((step) => step.some((line) => /^ {8}run:/.test(line)));
      expect(runs, key).toHaveLength(1);
      const body = runs[0].join("\n");
      expect(body, key).toContain(`        run: node scripts/ci/files-hold.mjs ${command}`);
      expect(body, key).toMatch(/^ {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}$/m);
      expect(runs[0].filter((line) => /^ {8}run:/.test(line)).join("\n"), key).not.toContain("${{");
    }
  });

  it("installs nothing and restores no cache", () => {
    const text = uncommented(read());
    for (const install of ["pnpm install", "npm install", "npm ci", "yarn install", "pnpm/action-setup", "actions/cache@"]) {
      expect(text, install).not.toContain(install);
    }
    expect(text).not.toMatch(/^\s+cache:/m);
  });

  it("pins every action by commit, with its version as a comment", () => {
    const text = read();
    expect(scanWorkflowText(text)).toEqual([]);
    expect(text.match(/^\s+- uses: /gm)).toHaveLength(4);
  });
});
