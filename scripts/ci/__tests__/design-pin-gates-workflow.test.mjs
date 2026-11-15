// THE THREE DESIGN-PIN GATES MUST ACTUALLY RUN (cinatra#3144 G3, G4).
//
// scripts/ci/lib/design-pin.mjs names three checkers that read the one pin:
// design-pin-freshness (is the pin still the current one), the anchor
// resolution gate (do the anchors the contract records resolve in the drawings
// the pin governs) and the record-grammar gate (does a graded record name the
// pin it was graded against). A checker that exists and is never invoked is a
// gate only on paper: it decides nothing, it turns nothing red, and the state
// it was built to make visible stays exactly as silent as before it was
// written. The freshness gate (G3) is landed WARN-FIRST, which means the job
// runs and the context is not required — so the job running is the whole of
// what "visible" is, and it is pinned here. The anchor gate (G4) was landed
// the same way and is now blocking (cinatra#3555), pinned below.
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

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTriggers } from "../merge-group-coverage-guard.mjs";
import { INVENTORY_PATH } from "../merge-readiness.mjs";
import {
  ANCHOR_RESOLUTION_CHECKER_PATH,
  COMMIT_BEARING_PINS,
  FRESHNESS_CHECKER_PATH,
  GLOBAL_PATHS,
  MAP_PATH,
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

  // THE ANCHOR GATE BLOCKS (cinatra#3555 item 4, cinatra#3144 G4).
  // It landed WARN-FIRST: a JOB-LEVEL `continue-on-error: true`, which kept the
  // workflow RUN green while the job's own check run still carried the finding,
  // with the context in the readiness inventory's `excluded` list as
  // report-only. The follow-up the checker's header promised makes it blocking,
  // and three records say so together; the first two are asserted here, the
  // third (the branch-protection declaration) below.
  //
  //   1. the job declares no `continue-on-error` of its own. The STEP-level key
  //      on the token-mint step is a different thing: it exists so a refused
  //      credential cannot abort the job silently, and the checker still fails
  //      CLOSED behind it (exit 2) - so the INDENT is the assertion here: the
  //      job's own indent + 2, never a step's;
  //   2. the readiness inventory lists the context as `expected`, so a merge
  //      waits on it, and no longer as `excluded` as report-only. Its
  //      generator reads the same declaration, so a context still sitting in
  //      `excluded` is one the workflow key no longer justifies.
  it("blocks a merge on the anchor-resolution gate", () => {
    const running = [...jobBlocks(workflow())].filter(([, block]) =>
      block.includes(ANCHOR_RESOLUTION_CHECKER_PATH),
    );
    expect(running).toHaveLength(1);
    const [job, block] = running[0];

    expect(block, `${job} - job-level continue-on-error`).not.toMatch(/^ {4}continue-on-error:/m);

    const readiness = JSON.parse(readFileSync(resolve(REPO_ROOT, INVENTORY_PATH), "utf8"));
    expect(readiness.expected.map((row) => row.context), `${job} - expected`).toContain(job);
    expect(
      readiness.excluded.find((row) => row.context === job),
      `${job} - excluded row`,
    ).toBeUndefined();
  });

  it("lists the anchor-resolution gate as a required branch-protection context", () => {
    const protections = JSON.parse(
      readFileSync(resolve(REPO_ROOT, ".github/branch-protections.json"), "utf8"),
    );
    expect(protections.required_status_checks.contexts).toContain("design-anchor-resolution");
  });

  // A REQUIRED GATE THAT NEEDS A SECRET MUST NOT BLOCK A RUN THAT HAS NONE
  // (cinatra#3555). The job reads the drawings through a credential minted in
  // its own mint step. A fork pull request has no Actions secrets, a
  // Dependabot-triggered run gets its own secret store instead, and the design
  // source or the App installation can be down: in each the token is empty. The
  // checker then exits 0 with a notice when the pull request changes no path it
  // reads, and 2 when it does. The unit suite drives the checker; these tests
  // drive the JOB'S OWN step text (the shell the runner runs) against the real
  // checker in a throwaway git repository, so the base the step computes, the
  // environment it passes and the checker's verdict are read together.
  //
  //   1. the checkout has the history the diff base needs (fetch-depth: 0);
  //   2. the mint step keeps its STEP-level continue-on-error (an empty token
  //      reaches the checker instead of aborting the job), and the job itself
  //      sets no DESIGN_DRAWINGS_DIR (a pull request cannot point the checker
  //      at its own drawings);
  //   3. the step run with no credential and an untouched diff exits 0 with a
  //      notice, and with a touched mapped path exits 2.
  describe("the anchor-resolution job with no credential", () => {
    const jobBlock = () => {
      const running = [...jobBlocks(workflow())].filter(([, block]) =>
        block.includes(ANCHOR_RESOLUTION_CHECKER_PATH),
      );
      expect(running).toHaveLength(1);
      return running[0][1];
    };

    /** The `run:` text of the step named `name`, with its indentation removed. */
    function stepRun(block, name) {
      const lines = block.split("\n");
      const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
      expect(at, `${name} - step`).toBeGreaterThan(-1);
      const run = lines.findIndex((l, i) => i > at && /^ {8}run: \|\s*$/.test(l));
      expect(run, `${name} - run`).toBeGreaterThan(at);
      const out = [];
      for (let i = run + 1; i < lines.length; i++) {
        if (lines[i].trim() !== "" && !/^ {10}/.test(lines[i])) break;
        out.push(lines[i].replace(/^ {10}/, ""));
      }
      return out.join("\n");
    }

    it("has the history its diff base needs and keeps the mint step non-fatal", () => {
      const block = jobBlock();
      expect(block).toMatch(/^ {10}fetch-depth: 0$/m);
      const mint = /- name: Mint the design-source read token\n((?: {8,}.*\n?)+)/.exec(block);
      expect(mint, "mint step").not.toBeNull();
      expect(mint[1]).toMatch(/^ {8}continue-on-error: true$/m);
      expect(block).not.toContain("DESIGN_DRAWINGS_DIR:");
    });

    // `event` is the GitHub event the runner would run the step under:
    //   pull_request: the baseline is `origin/<base.ref>`, a remote-tracking ref;
    //   merge_group:  the baseline is the event's own `merge_group.base_sha`;
    //   push:         the baseline is the event's `before` (gates.yml receives a
    //                 push on main only, which exits 2 on its own; a push to a
    //                 feature branch is run here for the `before` road).
    // `renameFrom` commits that file in the base and MOVES it to `touchedPath`
    // in the change, so the diff carries a rename.
    function runStep({ touchedPath, event = "push", renameFrom = null }) {
      const root = mkdtempSync(join(tmpdir(), "anchor-job-"));
      const git = (...args) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], {
          cwd: root,
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
        });
      // The checker, its imports taken transitively, and the files it reads as data.
      const files = new Set([ANCHOR_RESOLUTION_CHECKER_PATH, MAP_PATH]);
      const todo = [ANCHOR_RESOLUTION_CHECKER_PATH];
      while (todo.length) {
        const rel = todo.pop();
        const text = read(rel);
        for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
          const dep = normalize(join(dirname(rel), m[1])).split("\\").join("/");
          if (!files.has(dep)) {
            files.add(dep);
            todo.push(dep);
          }
        }
      }
      for (const p of COMMIT_BEARING_PINS) {
        files.add(p.authority);
        files.add(p.mirror);
      }
      for (const rel of files) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), read(rel));
      }
      if (renameFrom) {
        mkdirSync(dirname(join(root, renameFrom)), { recursive: true });
        writeFileSync(join(root, renameFrom), "a file the checker reads, with enough text to count as the same file\n".repeat(8));
      }
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      const before = git("rev-parse", "HEAD").trim();
      if (event === "pull_request") git("update-ref", "refs/remotes/origin/main", before);
      mkdirSync(dirname(join(root, touchedPath)), { recursive: true });
      if (renameFrom) git("mv", renameFrom, touchedPath);
      else writeFileSync(join(root, touchedPath), "changed\n");
      git("add", "-A");
      git("commit", "-q", "-m", "change");
      // The expressions the runner would substitute for the event.
      const script = stepRun(jobBlock(), "Design Anchor Resolution")
        .replaceAll("${{ github.event.pull_request.base.ref }}", event === "pull_request" ? "main" : "")
        .replaceAll("${{ github.event.merge_group.base_sha }}", event === "merge_group" ? before : "")
        .replaceAll("${{ github.event.before }}", event === "push" ? before : "");
      expect(script).not.toContain("${{");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GITHUB_EVENT_NAME: event,
          ...(event === "push" ? { GITHUB_REF_NAME: "feature/x" } : {}),
          DESIGN_SOURCE_TOKEN: "",
        },
      });
      rmSync(root, { recursive: true, force: true });
      return { code: result.status, out: `${result.stdout}\n${result.stderr}` };
    }

    for (const event of ["pull_request", "merge_group", "push"]) {
      it(`${event}: exits 0 with a notice for a diff that changes no path the checker reads`, () => {
        const r = runStep({ touchedPath: "README.md", event });
        expect(r.out).toContain("::notice");
        expect(r.code).toBe(0);
      });

      it(`${event}: exits 2 for a diff that changes a path the checker reads`, () => {
        const r = runStep({ touchedPath: "src/lib/lifecycle/__tests__/anchor-contract-binding.test.ts", event });
        expect(r.out).toContain("could not run honestly");
        expect(r.code).toBe(2);
      });
    }

    it("pull_request: exits 2 for a diff that MOVES a path the checker reads (a rename lists its source)", () => {
      const r = runStep({
        event: "pull_request",
        renameFrom: "src/lib/lifecycle/__tests__/anchor-contract-binding.test.ts",
        touchedPath: "docs/moved-binding.test.ts",
      });
      expect(r.out).toContain("could not run honestly");
      expect(r.code).toBe(2);
    });
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
