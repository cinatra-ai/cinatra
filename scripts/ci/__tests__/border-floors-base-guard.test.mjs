// THE BORDER FLOORS ARE GUARDED AGAINST THE BASE BRANCH IN THE GATES WORKFLOW
// (cinatra#3827, cinatra#3831).
//
// The four border gates keep their floors as files in the repository, so a pull
// request could raise a floor in its own change and pass. Each gate compares
// its committed floor with the copy on a base reference when a variable names
// one. This suite holds the job `gates-pnpm` of .github/workflows/gates.yml to
// the wiring that makes that comparison happen on every pull request:
//
//   1. a full checkout (the base branch must be in the checkout to be read);
//   2. the clone of the companion extension tree before the install (the
//      application gate derives its vocabulary from that tree);
//   3. ONE step that derives the base, fails closed when it does not resolve,
//      and runs the application, connector and host display gates with their
//      base variables, each to its end;
//   4. a step that runs the core/extension border gate with the same base;
//   5. the job's path filter names the inputs of that gate, so a pull request
//      that changes only its ledger does not skip the job.
//
// The workflow is read LINE-BASED rather than through a yaml dependency, as
// scripts/ci/__tests__/design-pin-gates-workflow.test.mjs reads it. The step's
// own shell text is also RUN, with bash as the runner runs it, in a temporary
// git repository.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { makeFloorRepo } from "../../audit/__tests__/floor-base-fixture.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = readFileSync(join(REPO_ROOT, ".github", "workflows", "gates.yml"), "utf8");

const GATE_SCRIPTS = [
  "scripts/audit/application-border-gate.mjs",
  "scripts/audit/connector-artifact-road-gate.mjs",
  "scripts/audit/host-display-floor-gate.mjs",
];
const BASE_VARIABLES = ["APPLICATION_BORDER_BASE", "CONNECTOR_ARTIFACT_ROAD_BASE", "HOST_DISPLAY_FLOOR_BASE"];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The workflow's top-level job blocks, as `name -> body` (the reader of
 * design-pin-gates-workflow.test.mjs): a job header is a two-space-indented key
 * under a column-0 `jobs:`, and a comment block right above a header belongs to
 * the job it documents.
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

/**
 * The steps of one job body, in order, each as its own lines. A step starts at
 * a six-space `- `; the YAML comment lines between steps (indented at most
 * eight spaces) are dropped, so one step's prose never counts for another.
 */
function stepsOf(jobBody) {
  const steps = [];
  let current = null;
  let inSteps = false;
  for (const line of jobBody.split("\n")) {
    if (/^ {4}steps:\s*$/.test(line)) {
      inSteps = true;
      continue;
    }
    if (!inSteps) continue;
    if (/^ {0,8}#/.test(line)) continue;
    if (/^ {6}- /.test(line)) {
      current = [line.replace(/^ {6}- /, "        ")];
      steps.push(current);
      continue;
    }
    if (current) current.push(line);
  }
  return steps.map((lines) => lines.join("\n"));
}

/** A step's scalar field (`name`, `id`, `uses`, `if`), or null. */
function field(step, key) {
  const m = new RegExp(`^ {8}${key}:[ \\t]*(.*)$`, "m").exec(step);
  return m ? m[1].trim() : null;
}

/** A step's `run:` text: the block scalar dedented, or the one-line value. */
function runText(step) {
  const lines = step.split("\n");
  const at = lines.findIndex((l) => /^ {8}run:/.test(l));
  if (at < 0) return null;
  const inline = lines[at].replace(/^ {8}run:[ \t]*/, "");
  if (inline !== "|" && inline !== ">-") return inline;
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== "" && !/^ {10}/.test(l)) break;
    out.push(l.slice(10));
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/** A step's `env:` mapping, as written. */
function envOf(step) {
  const lines = step.split("\n");
  const at = lines.findIndex((l) => /^ {8}env:\s*$/.test(l));
  const env = {};
  if (at < 0) return env;
  for (const l of lines.slice(at + 1)) {
    const m = /^ {10}([A-Z0-9_]+):[ \t]*(.*)$/.exec(l);
    if (!m) break;
    env[m[1]] = m[2].trim();
  }
  return env;
}

const JOBS = jobBlocks(WORKFLOW);
const STEPS = stepsOf(JOBS.get("gates-pnpm") ?? "");
const stepNamed = (name) => STEPS.findIndex((s) => field(s, "name") === name);
const BORDER_STEP = STEPS.find((s) => field(s, "id") === "border-base") ?? "";
const CORE_STEP = STEPS.find((s) => (runText(s) ?? "").includes("scripts/ci/core-extension-border-gate.mjs")) ?? "";

describe("gates-pnpm — the border floors are compared with the base branch", () => {
  it("checks out the full history without persisting the credential", () => {
    const checkout = STEPS.find((s) => (field(s, "uses") ?? "").startsWith("actions/checkout@"));
    expect(checkout, "gates-pnpm has no checkout step").toBeTruthy();
    expect(checkout).toMatch(/^ {10}fetch-depth: 0[ \t]*$/m);
    expect(checkout).toMatch(/^ {10}persist-credentials: false[ \t]*$/m);
  });

  it("clones the companion extension tree after the Node setup and before the install", () => {
    const clone = STEPS.findIndex((s) => field(s, "uses") === "./.github/actions/clone-extensions");
    expect(clone, "gates-pnpm has no clone step").toBeGreaterThan(-1);
    expect(field(STEPS[clone], "name")).toBe("Clone companion extension repos");
    expect(clone).toBeGreaterThan(stepNamed("Set up Node.js"));
    expect(stepNamed("Set up Node.js")).toBeGreaterThan(-1);
    expect(clone).toBeLessThan(stepNamed("Install workspace"));
  });

  it("runs the three floor gates with one derived base, and the older gate with the same base, after every suite step", () => {
    expect(field(BORDER_STEP, "name")).toBe("Border floors — base guard");
    expect(envOf(BORDER_STEP)).toEqual({
      PR_BASE_REF: "${{ github.event.pull_request.base.ref }}",
      MERGE_GROUP_BASE_SHA: "${{ github.event.merge_group.base_sha }}",
      PUSH_BEFORE: "${{ github.event.before }}",
    });
    const run = runText(BORDER_STEP) ?? "";
    // Values reach the shell through env only, never through an expression.
    expect(run).not.toContain("${{");
    expect(run).toContain('echo "base=$base" >> "$GITHUB_OUTPUT"');
    for (const variable of BASE_VARIABLES) expect(run).toContain(`export ${variable}="$base"`);
    for (const script of GATE_SCRIPTS) expect(run).toContain(`node ${script}`);

    expect(field(CORE_STEP, "name")).toBe("Core/extension border — base guard");
    expect(field(CORE_STEP, "if")).toBe("${{ !cancelled() && steps.border-base.outputs.base != '' }}");
    expect(envOf(CORE_STEP)).toEqual({ CORE_EXTENSION_BORDER_BASE: "${{ steps.border-base.outputs.base }}" });
    expect((runText(CORE_STEP) ?? "").trim()).toBe("node scripts/ci/core-extension-border-gate.mjs");

    const border = STEPS.indexOf(BORDER_STEP);
    const lastSuite = stepNamed("Vendor-byline — resolver + §III/§IV byline + parser tests (root)");
    expect(lastSuite).toBeGreaterThan(-1);
    expect(border).toBe(lastSuite + 1);
    expect(STEPS.indexOf(CORE_STEP)).toBe(border + 1);
  });

  it("names the older gate's inputs in the job's path filter", () => {
    const changes = JOBS.get("changes") ?? "";
    const filter = changes.slice(changes.indexOf("pnpm_suites:"));
    for (const input of [
      "config/core-extension-border-baseline.json",
      "config/skill-packaging-legacy-exceptions.json",
      "scripts/ci/core-extension-border-gate.mjs",
      "cinatra-required-extensions.lock.json",
      "cinatra-dev-extensions.lock.json",
      "scripts/audit/**",
    ]) {
      expect(filter).toContain(`- '${input}'`);
    }
  });

  it("adds no job to the workflow", () => {
    expect([...JOBS.keys()]).toEqual([
      "changes",
      "gates",
      "gates-pnpm",
      "design-pin-drift",
      "design-pin-freshness",
      "design-anchor-resolution",
    ]);
  });
});

// The step's shell text, run by bash as the runner runs a `run:` block
// (`bash --noprofile --norc -eo pipefail`), in a temporary git repository that
// holds none of the gate scripts. The environment is passed explicitly, so the
// CI run's own variables never reach a case.
describe("gates-pnpm — the base step's shell text, run", () => {
  const cleanups = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()();
  });

  function runStep(env) {
    const fixture = makeFloorRepo({ base: { "README.md": "base\n" }, head: { "README.md": "head\n" } });
    cleanups.push(fixture.cleanup);
    const scratch = mkdtempSync(join(tmpdir(), "border-step-"));
    cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
    const script = join(scratch, "step.sh");
    const output = join(scratch, "github-output");
    writeFileSync(script, runText(BORDER_STEP) ?? "exit 97\n");
    writeFileSync(output, "");
    const baseSha = execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], {
      cwd: fixture.root,
      encoding: "utf8",
    }).trim();
    const res = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: output, ...env(baseSha) },
    });
    return { ...res, written: readFileSync(output, "utf8"), baseSha };
  }

  it("a base that does not resolve fails closed with an error line and writes no base", () => {
    const res = runStep(() => ({ PR_BASE_REF: "example-org-no-such-branch" }));
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^::error::.*origin\/example-org-no-such-branch.*cannot be compared/m);
    expect(res.written).toBe("");
  });

  it("a resolved base is written, and each of the three gates runs to its end", () => {
    const res = runStep((sha) => ({ MERGE_GROUP_BASE_SHA: sha }));
    expect(res.written).toBe(`base=${res.baseSha}\n`);
    expect(res.status).not.toBe(0);
    for (const script of GATE_SCRIPTS) {
      const name = script.split("/").pop();
      expect(res.stderr).toMatch(new RegExp(`Cannot find module '[^']*${escapeRegExp(name)}'`));
    }
  });
});
