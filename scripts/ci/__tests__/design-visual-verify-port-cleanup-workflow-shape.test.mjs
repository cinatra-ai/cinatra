// Pixel job port lifecycle (cinatra#3383, cinatra#3416): the SHAPE of the
// shipped design-visual-verify workflow, read from the real file in this repo.
//
// The job starts a standalone server on ONE port. A previous job that ended
// without stopping its server leaves the process on a self-hosted runner, and
// the next job that binds the port dies at start (EADDRINUSE). The steps below
// are the fix, and this file is what keeps them: the port is freed BEFORE the
// server starts, the server's own pid is recorded so an always() step can stop
// exactly that process (never a pattern kill), and every step reads the port
// from the one place that sets it.
//
// cinatra#3416 moved that place. The port used to be a job-level LITERAL, one
// value for every runner — and a self-hosted BOX carries several runners, so
// the freeing step took a CONCURRENT job's live server away and bound its port.
// The port is now DERIVED FROM THE RUNNER and exported through $GITHUB_ENV, so
// the only process that can hold it is this runner's own stale server, which is
// the case the freeing step was written for.
//
// ONE port per runner slot is also ONE port per LIVE JOB — a runner process
// runs at most one job at a time — and the derivation therefore runs ahead of
// the BUILD as well as ahead of the free and start steps: the NEXT_PUBLIC_*
// base URLs are baked into the client bundle at build time, so they must
// already name the port this job will actually bind.
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

const DERIVE = /deriv.*port/i;
const FREE = /free.*port/i;
const START = /^Start standalone server$/;
const STOP = /stop.*(standalone )?server/i;

describe("design-visual-verify.yml pixel-diff: one port per runner slot (cinatra#3416)", () => {
  it("sets the port ONCE, derived from the runner rather than pinned literally", () => {
    const block = PIXEL_JOB();
    // cinatra#3416: a job-level literal is ONE port for every runner of the
    // box, and the freeing step below then takes a concurrent job's server.
    expect(block).not.toMatch(new RegExp(`^ {6}${PORT_ENV}:`, "m"));
    const exported = block.match(new RegExp(`echo "${PORT_ENV}=`, "g")) ?? [];
    expect(exported.length).toBe(1);
    const derive = stepMatching(block, DERIVE);
    expect(derive).toBeDefined();
    expect(derive.text).toContain("RUNNER_NAME");
    expect(derive.text).toMatch(/>> "\$GITHUB_ENV"/);
  });

  it("derives the port before the step that frees it", () => {
    const block = PIXEL_JOB();
    const derive = indexOfStep(block, DERIVE);
    const free = indexOfStep(block, FREE);
    expect(derive).toBeGreaterThan(-1);
    expect(free).toBeGreaterThan(-1);
    expect(derive).toBeLessThan(free);
  });

  it("derives it BEFORE the build, so the URLs baked in name the port that is bound", () => {
    const block = PIXEL_JOB();
    const derive = indexOfStep(block, DERIVE);
    const build = indexOfStep(block, /^Build \(/i);
    expect(derive).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(derive).toBeLessThan(build);
    expect(derive).toBeLessThan(indexOfStep(block, FREE));
    expect(derive).toBeLessThan(indexOfStep(block, START));
  });

  it("leaves no public URL pinned to a port literal at job level", () => {
    const block = PIXEL_JOB();
    for (const name of [
      "BETTER_AUTH_URL",
      "NEXT_PUBLIC_BETTER_AUTH_URL",
      "NEXT_PUBLIC_APP_URL",
      "NEXT_PUBLIC_SITE_URL",
    ]) {
      expect(block).not.toMatch(new RegExp(`^ {6}${name}: \\S*:\\d+`, "m"));
    }
    expect(stepMatching(block, DERIVE).text).toMatch(/NEXT_PUBLIC_APP_URL=/);
  });
});

describe("design-visual-verify.yml pixel-diff: the port is free before the server starts", () => {
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

  it("no one of the three names a port number of its own", () => {
    const block = PIXEL_JOB();
    // Only the derivation step may name a number; the three lifecycle steps
    // must read whatever it exported, or they would drift apart from it.
    //
    // Read in PORT POSITION, not as "any four digits": a number is a port when
    // it is bound, probed, freed or addressed as one. A blanket digit ban would
    // reject an unrelated timeout and would still miss a five-digit port.
    // Whole-line comments are stripped first — an issue number in prose is not
    // a port, and a step that only TALKS about one binds nothing.
    const code = (text) =>
      text
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
    const PORT_POSITION =
      /(?:PORT=|tcp:|localhost:|127\.0\.0\.1:|:)\s*"?\d{2,5}(?:\/tcp)?\b|\b\d{2,5}\/tcp\b/;
    for (const matcher of [FREE, START, STOP]) {
      const step = stepMatching(block, matcher);
      expect(step).toBeDefined();
      expect(code(step.text)).not.toMatch(PORT_POSITION);
    }
  });
});
