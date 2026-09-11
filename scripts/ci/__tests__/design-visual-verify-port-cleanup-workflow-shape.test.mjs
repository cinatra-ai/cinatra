// Pixel job port lifecycle (cinatra#3383): the SHAPE of the shipped
// design-visual-verify workflow, read from the real file in this repo.
//
// The job starts a standalone server on ONE fixed port. A previous job that
// ended without stopping its server leaves the process on a self-hosted
// runner, and the next job that binds the port dies at start (EADDRINUSE).
// The three steps below are the fix, and this file is what keeps them: the
// port is freed BEFORE the server starts, the server's own pid is recorded so
// an always() step can stop exactly that process (never a pattern kill), and
// all three steps read the port from the one job-level env that declares it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
  "design-visual-verify.yml",
);

const workflow = fs.readFileSync(WORKFLOW_PATH, "utf8");

const PORT_ENV = "E2E_DESIGN_PORT";

const jobBlock = (id) => {
  const from = workflow.indexOf(`\n  ${id}:\n`);
  expect(from).toBeGreaterThan(-1);
  const rest = workflow.slice(from + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

// Resolved LAZILY, inside each test: a step that is missing must fail the one
// assertion that asks for it, not the whole file at collection time.
const PIXEL_JOB = () => jobBlock("pixel-diff");

/** The steps of a job block, in file order, as {name, text}. */
const steps = (block) => {
  const out = [];
  const lines = block.split("\n");
  let current = null;
  for (const line of lines) {
    const head = line.match(/^ {6}- name: (.+)$/);
    if (head) {
      if (current) out.push(current);
      current = { name: head[1].trim(), text: line + "\n" };
      continue;
    }
    if (current) current.text += line + "\n";
  }
  if (current) out.push(current);
  return out;
};

const indexOfStep = (block, matcher) =>
  steps(block).findIndex((s) => matcher.test(s.name));

const stepMatching = (block, matcher) =>
  steps(block).find((s) => matcher.test(s.name));

const FREE = /free.*port/i;
const START = /^Start standalone server$/;
const STOP = /stop.*(standalone )?server/i;

describe("design-visual-verify.yml pixel-diff: the port is free before the server starts", () => {
  it("declares the port ONCE, as a job-level env", () => {
    const block = PIXEL_JOB();
    expect(block).toMatch(new RegExp(`^ {6}${PORT_ENV}: "\\d+"$`, "m"));
    expect(block.match(new RegExp(`^ {6}${PORT_ENV}:`, "gm")).length).toBe(1);
  });

  it("has a step that frees the port, BEFORE the step that starts the server", () => {
    const block = PIXEL_JOB();
    const free = indexOfStep(block, FREE);
    const start = indexOfStep(block, START);
    expect(free).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    expect(free).toBeLessThan(start);
  });

  it("frees the port with the runner's own port tooling, never a pattern kill", () => {
    const free = stepMatching(PIXEL_JOB(), FREE);
    expect(free).toBeDefined();
    expect(free.text).toMatch(/lsof -ti|fuser -k/);
    expect(free.text).not.toMatch(/pkill|killall/);
  });
});

describe("design-visual-verify.yml pixel-diff: the server it starts is stopped", () => {
  it("records the started server's pid for a later step", () => {
    const start = stepMatching(PIXEL_JOB(), START);
    expect(start).toBeDefined();
    expect(start.text).toMatch(/DESIGN_SERVER_PID=/);
    expect(start.text).toMatch(/>> "\$GITHUB_ENV"/);
  });

  it("stops it in an `if: always()` step that runs after the start step", () => {
    const block = PIXEL_JOB();
    const stop = indexOfStep(block, STOP);
    const start = indexOfStep(block, START);
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(start);
    expect(steps(block)[stop].text).toMatch(/^ {8}if: always\(\)$/m);
  });

  it("stops it by the recorded pid, never by a pattern kill", () => {
    const stop = stepMatching(PIXEL_JOB(), STOP);
    expect(stop).toBeDefined();
    expect(stop.text).toMatch(/DESIGN_SERVER_PID/);
    expect(stop.text).toMatch(/kill /);
    expect(stop.text).not.toMatch(/pkill|killall|kill -f/);
  });
});

describe("design-visual-verify.yml pixel-diff: one port, named by all three steps", () => {
  it("the free, start and stop steps all read the port from the single env", () => {
    const block = PIXEL_JOB();
    for (const matcher of [FREE, START, STOP]) {
      const step = stepMatching(block, matcher);
      expect(step).toBeDefined();
      expect(step.text).toContain(PORT_ENV);
    }
  });

  it("no one of the three re-declares the port number as a literal", () => {
    const block = PIXEL_JOB();
    const declared = block.match(new RegExp(`^ {6}${PORT_ENV}: "(\\d+)"$`, "m"));
    expect(declared).not.toBeNull();
    for (const matcher of [FREE, START, STOP]) {
      const step = stepMatching(block, matcher);
      expect(step).toBeDefined();
      expect(step.text).not.toContain(declared[1]);
    }
  });
});
