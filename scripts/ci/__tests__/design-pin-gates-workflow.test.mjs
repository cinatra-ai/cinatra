// THE THREE DESIGN-PIN GATES MUST ACTUALLY RUN (cinatra#3144 G3, G4).
//
// scripts/ci/lib/design-pin.mjs names three checkers that read the one pin:
// design-pin-freshness (is the pin still the current one), the anchor
// resolution gate (do the anchors the contract records resolve in the drawings
// the pin governs) and the record-grammar gate (does a graded record name the
// pin it was graded against). A checker that exists and is never invoked is a
// gate only on paper: it decides nothing, it turns nothing red, and the state
// it was built to make visible stays exactly as silent as before it was
// written. Both G3 and G4 are landed WARN-FIRST, which means the job runs and
// the context is not required — so the job running is the whole of what
// "visible" is, and it is pinned here.
//
// The workflow is read LINE-BASED rather than through a yaml dependency: these
// gate jobs are pure-node and install nothing, the convention
// scripts/audit/archive-acceptance-gate.mjs states for this file class.
//
// What each gate is held to:
//
//   1. exactly ONE job across .github/workflows/ invokes the checker, in the
//      gate's own workflow file — its own job, not a step folded into a
//      neighbour whose red would be read as somebody else's. The freshness
//      and anchor gates run in gates.yml; the record-grammar gate runs in a
//      file of its own, so that it can also run when the pull request is
//      edited (cinatra#3727);
//   2. that job invokes it with `node` directly, and installs nothing, so it
//      costs a runner slot and nothing else;
//   3. the three jobs are three DIFFERENT jobs.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTriggers } from "../merge-group-coverage-guard.mjs";
import { INVENTORY_PATH } from "../merge-readiness.mjs";
import {
  ANCHOR_RESOLUTION_CHECKER_PATH,
  FRESHNESS_CHECKER_PATH,
  GLOBAL_PATHS,
  RECORD_GRAMMAR_CHECKER_PATH,
  RECORD_GRAMMAR_WORKFLOW_PATH,
  WORKFLOW_PATH,
} from "../lib/design-pin.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const read = (relPath) => readFileSync(resolve(REPO_ROOT, relPath), "utf8");

/** gates.yml, where the freshness and anchor gates run. */
const workflow = () => read(WORKFLOW_PATH);

const WORKFLOWS_DIR = ".github/workflows";

/**
 * The workflow's top-level job blocks, as `name -> body`. A job header is a
 * two-space-indented key under a column-0 `jobs:`; everything indented deeper
 * belongs to it, up to the next such header or the end of the mapping.
 *
 * A run of comment and blank lines sitting immediately BEFORE a job header
 * belongs to the job it documents, not to the one above it: these jobs carry
 * their reasoning in a comment block over the header, and reading that block as
 * the previous job's would let a neighbour's prose satisfy this suite instead of
 * a real invocation.
 */
function jobBlocks(text) {
  const blocks = new Map();
  let inJobs = false;
  let name = null;
  let body = [];
  let pending = [];
  const flush = () => {
    if (name !== null) blocks.set(name, body.join("\n"));
    name = null;
    body = [];
  };
  for (const line of text.split("\n")) {
    if (!inJobs) {
      if (/^jobs:\s*$/.test(line)) inJobs = true;
      continue;
    }
    if (line.trim() !== "" && /^\S/.test(line)) {
      // A column-0 key ends the `jobs:` mapping.
      body.push(...pending);
      pending = [];
      flush();
      inJobs = false;
      continue;
    }
    const header = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (header) {
      flush();
      name = header[1];
      body = pending;
      pending = [];
      continue;
    }
    if (line.trim() === "" || /^\s*#/.test(line)) {
      pending.push(line);
      continue;
    }
    if (name !== null) {
      body.push(...pending);
      body.push(line);
    }
    pending = [];
  }
  body.push(...pending);
  flush();
  return blocks;
}

/** Anything that would turn one of these jobs into an installing job. */
const INSTALLS = [
  "pnpm install",
  "npm install",
  "npm ci",
  "yarn install",
  "pnpm/action-setup",
];

// Every job in this workflow routes through the repository's runner-class
// variable rather than a hardcoded runner label, so a routing change stays one
// edit for the whole file. A job that keeps the literal label silently opts out
// of that routing.
const RUNNER_CLASS = "${{ fromJSON(vars.CI_RUNNER_GATE || '\"ubuntu-latest\"') }}";

// Each gate with the workflow file its one job belongs in.
const GATES = [
  ["the spec-freshness gate", FRESHNESS_CHECKER_PATH, WORKFLOW_PATH],
  ["the anchor-resolution gate", ANCHOR_RESOLUTION_CHECKER_PATH, WORKFLOW_PATH],
  ["the record-grammar gate", RECORD_GRAMMAR_CHECKER_PATH, RECORD_GRAMMAR_WORKFLOW_PATH],
];

/**
 * Every job, in every workflow file, whose block names the checker, as
 * [workflow path, job, block]. All the files are read, not only the gate's
 * own: a second job naming the checker anywhere would report the same context
 * from two workflows.
 */
function jobsInvoking(checker) {
  const hits = [];
  const files = readdirSync(resolve(REPO_ROOT, WORKFLOWS_DIR)).filter((f) => /\.ya?ml$/.test(f));
  for (const file of files.sort()) {
    const relPath = `${WORKFLOWS_DIR}/${file}`;
    for (const [job, block] of jobBlocks(read(relPath))) {
      if (block.includes(checker)) hits.push([relPath, job, block]);
    }
  }
  return hits;
}

describe("every design-pin gate runs as its own job in the workflow", () => {
  for (const [label, checker, workflowPath] of GATES) {
    it(`${label} is invoked by exactly one job, in ${workflowPath}`, () => {
      const running = jobsInvoking(checker);
      expect(running.map(([file, job]) => `${file}: ${job}`), label).toHaveLength(1);
      expect(running[0][0], label).toBe(workflowPath);
    });

    it(`${label} is run with node directly, with no install step`, () => {
      const running = jobsInvoking(checker);
      expect(running, label).toHaveLength(1);
      const [, , block] = running[0];
      expect(block, label).toContain(`node ${checker}`);
      for (const install of INSTALLS) {
        expect(block, `${label} — ${install}`).not.toContain(install);
      }
    });
  it(`${label} routes to the runner class its siblings route to`, () => {
      const running = jobsInvoking(checker);
      expect(running, label).toHaveLength(1);
      const [, , block] = running[0];
      const runsOn = /^ {4}runs-on: (.+)$/m.exec(block);
      expect(runsOn, `${label} - runs-on`).not.toBeNull();
      expect(runsOn[1].trim(), label).toBe(RUNNER_CLASS);
    });
  }

  it("gives each of the three its own job", () => {
    const jobs = GATES.map(([, checker]) => {
      const running = jobsInvoking(checker);
      expect(running).toHaveLength(1);
      return `${running[0][0]}: ${running[0][1]}`;
    });
    expect(new Set(jobs).size).toBe(GATES.length);
  });

  // THE ANCHOR GATE REPORTS, IT DOES NOT BLOCK (cinatra#3144 G1 item 6, G4).
  // Its checker's own header says it is landed WARN-FIRST "so the state is
  // visible without blocking anything", and this repository offers exactly one
  // mechanism that makes that sentence true: a JOB-LEVEL `continue-on-error:
  // true`, which keeps the workflow RUN green while the job's own check run
  // still carries the finding. The STEP-level key on the token-mint step is a
  // different thing entirely — it exists so a refused credential cannot abort
  // the job silently, and the checker still fails CLOSED behind it — so the
  // INDENT is the assertion here: the job's own indent + 2, never a step's.
  //
  // The readiness inventory is the other half and cannot be left out: its
  // generator reads that same declaration and drops the context into
  // `excluded` as report-only. A context still sitting in `expected` is one a
  // merge waits on, so the disposition would be undone while the workflow key
  // still looked right.
  it("reports the anchor-resolution gate without blocking a merge", () => {
    const running = [...jobBlocks(workflow())].filter(([, block]) =>
      block.includes(ANCHOR_RESOLUTION_CHECKER_PATH),
    );
    expect(running).toHaveLength(1);
    const [job, block] = running[0];

    expect(block, `${job} - job-level continue-on-error`).toMatch(/^ {4}continue-on-error: true$/m);

    const readiness = JSON.parse(readFileSync(resolve(REPO_ROOT, INVENTORY_PATH), "utf8"));
    expect(readiness.expected.map((row) => row.context), `${job} - expected`).not.toContain(job);
    const dropped = readiness.excluded.find((row) => row.context === job);
    expect(dropped, `${job} - excluded row`).toBeDefined();
    expect(dropped.reason, `${job} - exclusion reason`).toMatch(/^report-only:/);
  });
});

// THE RECORD-GRAMMAR GATE RUNS IN A WORKFLOW OF ITS OWN, ON EDITS TOO
// (cinatra#3727). The gate reads the body from the event payload, and a re-run
// replays the payload of the run it belongs to, so a graded section added to
// the body after the last push stays unread until the next push. The `edited`
// action carries the body as it is now, so the gate's workflow runs on it too.
// It is a workflow of its own because a run of gates.yml on an edit would
// report every other job there as skipped: a newer result at the same head,
// read in place of the real one. Pinned here:
//
//   1. the grammar workflow runs on the three default pull_request types and
//      on `edited`, and on every other event gates.yml runs on;
//   2. gates.yml does not run on `edited`;
//   3. the grammar workflow holds that one job, so an edit runs nothing else;
//   4. it has one concurrency group per pull request and never cancels a run
//      in progress, so an edit does not cancel the run a push started;
//   5. a change to the grammar workflow touches every pin, as a change to
//      gates.yml does.

/**
 * The `types:` list of the top-level `pull_request` trigger, or null when the
 * trigger names none (GitHub then runs it on its three default types). Read
 * line-based like the job blocks above: a trigger is a two-space key under a
 * column-0 `on:`, and its `types:` a four-space key in either list form.
 */
function pullRequestTypes(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start === -1) return null;
  const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, "");
  let inTrigger = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // A column-0 key ends the `on:` mapping.
    if (/^\S/.test(line)) break;
    const trigger = /^ {2}([A-Za-z_]+):/.exec(line);
    if (trigger) {
      inTrigger = trigger[1] === "pull_request";
      continue;
    }
    if (!inTrigger) continue;
    const types = /^ {4}types:\s*(.*)$/.exec(line);
    if (!types) continue;
    const inline = types[1].replace(/\s+#.*$/, "").trim();
    if (inline.startsWith("[")) {
      return inline.slice(1, inline.lastIndexOf("]")).split(",").map(unquote).filter(Boolean);
    }
    const items = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "" || /^\s*#/.test(lines[j])) continue;
      const item = /^ {6}-\s*(.+?)\s*$/.exec(lines[j]);
      if (!item) break;
      items.push(unquote(item[1]));
    }
    return items;
  }
  return null;
}

/** One key of the column-0 `concurrency:` mapping, or null. */
function concurrencyValue(text, key) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^concurrency:\s*$/.test(line));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "" && /^\S/.test(lines[i])) break;
    const entry = /^ {2}([A-Za-z-]+):\s*(.+?)\s*$/.exec(lines[i]);
    if (entry && entry[1] === key) return entry[2];
  }
  return null;
}

describe("the record-grammar gate runs in a workflow of its own, on edits too", () => {
  it("runs the grammar workflow on the three default pull_request types and on edited", () => {
    const types = pullRequestTypes(read(RECORD_GRAMMAR_WORKFLOW_PATH));
    expect(types, "pull_request names no types, so an edit never runs the gate").not.toBeNull();
    expect([...types].sort()).toEqual(["edited", "opened", "reopened", "synchronize"]);
  });

  it("runs the grammar workflow on every event gates.yml runs on", () => {
    const gates = parseTriggers(workflow());
    expect(gates, "gates.yml - no parseable on:").not.toBeNull();
    expect([...parseTriggers(read(RECORD_GRAMMAR_WORKFLOW_PATH))].sort()).toEqual([...gates].sort());
  });

  it("leaves the edited type out of gates.yml", () => {
    expect(pullRequestTypes(workflow()) ?? [], "gates.yml - pull_request types").not.toContain("edited");
  });

  it("holds the record-grammar job alone, so an edit runs nothing else", () => {
    expect([...jobBlocks(read(RECORD_GRAMMAR_WORKFLOW_PATH)).keys()]).toEqual(["design-record-grammar"]);
  });

  it("gives each pull request one concurrency group and never cancels a run in progress", () => {
    const text = read(RECORD_GRAMMAR_WORKFLOW_PATH);
    expect(concurrencyValue(text, "group")).toBe(
      "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
    );
    expect(concurrencyValue(text, "cancel-in-progress")).toBe("false");
  });

  it("counts a change to the grammar workflow as touching every pin, as a change to gates.yml does", () => {
    expect(GLOBAL_PATHS).toContain(WORKFLOW_PATH);
    expect(GLOBAL_PATHS).toContain(RECORD_GRAMMAR_WORKFLOW_PATH);
  });
});
