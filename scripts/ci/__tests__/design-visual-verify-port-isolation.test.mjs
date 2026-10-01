// THE DESIGN SERVER'S PORT BELONGS TO ONE RUNNER, NEVER TO THE WHOLE BOX
// (cinatra#3416).
//
// design-visual-verify boots a standalone PRODUCTION server and then drives it
// for half an hour: the browser navigates it, and the conformance suite
// provisions its run-namespaced fixture rows through that server's own seed
// route under a per-run minted capability. Both halves address the server by
// PORT and by nothing else.
//
// While the port was a single literal shared by every run of the workflow, a
// self-hosted BOX carrying several runners handed that one port around between
// concurrent jobs: each job's "free the design port" step killed whatever held
// it — by design a stale server of an earlier job on the same runner, in
// practice the LIVE server of a job running beside it — and then bound its own.
// The robbed job kept testing, now against a stranger's server: a different
// ephemeral Postgres (so its seeded rows read as ZERO) and a different minted
// capability (so its next seed POST is refused by the fence, which answers a
// bare 404 to every refusal). Measured on 2026-09-13 on one such box: the job
// of one pull request launched its server as pid 1061078 at 19:50:57, and at
// 20:01:12
// the job of another pull request on a sibling runner printed exactly
// "3101/tcp: 1061078" as it freed the port — the robbed suite then failed
// toHaveCount(2) with 0 cards and its retry's seed POST answered 404.
//
// A port derived from the RUNNER is not taken that way: a runner runs one job
// at a time, so a job running BESIDE this one addresses a different port. The
// derivation alone still does not make the listener this job's — a box can
// also carry development processes, and two runner names can reduce to one
// number — so the port-freeing step identifies the holder (a listening socket,
// a `node ... server.js` command line, this runner's own work root) and fails
// loudly instead of killing anything it cannot claim. Both halves are pinned
// below.
//
// Dependency-free by construction (this repo carries no YAML parser): the
// scanner below reads the file as indented text, like its sibling
// design-select-workflow.test.mjs and the workflow-shape guards under
// scripts/audit/__tests__.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../design-select.mjs";

const WORKFLOW = ".github/workflows/design-visual-verify.yml";
const LINES = readFileSync(join(REPO_ROOT, WORKFLOW), "utf8").split("\n");

const JOBS_LINE = LINES.findIndex((line) => line === "jobs:");
const JOB_HEADER = /^ {2}([A-Za-z0-9_-]+):\s*$/;

/** A whole-line YAML comment. The scanner is blind to these on purpose: prose
 *  about a port is not a port, and a commented-out step binds nothing. */
const isComment = (line) => /^\s*#/.test(line);

/** One job's own block, from its header to the next job header, comments out. */
function jobBlock(id) {
  const start = LINES.findIndex(
    (line, index) => index > JOBS_LINE && JOB_HEADER.exec(line)?.[1] === id,
  );
  if (start === -1) return null;
  let end = start + 1;
  while (end < LINES.length && !JOB_HEADER.test(LINES[end])) end += 1;
  return LINES.slice(start, end)
    .filter((line) => !isComment(line))
    .join("\n");
}

const PIXEL_DIFF = jobBlock("pixel-diff");

describe("the design server's port belongs to one runner, never to the whole box", () => {
  it("has a pixel-diff job to read", () => {
    expect(PIXEL_DIFF).toBeTypeOf("string");
  });

  it("pins no single literal port that every runner of every run would share", () => {
    expect(PIXEL_DIFF).not.toMatch(/^\s*E2E_DESIGN_PORT:\s*"?\d+"?\s*$/m);
  });

  it("derives the port from the runner that is about to bind it", () => {
    expect(PIXEL_DIFF).toContain("RUNNER_NAME");
    expect(PIXEL_DIFF).toMatch(/echo "E2E_DESIGN_PORT=/);
  });

  it("lets every base URL handed to the build follow that derived port", () => {
    // A base URL baked at a literal port survives into the CLIENT bundle, so a
    // robbed job's browser would keep addressing the stranger that now holds it.
    expect(PIXEL_DIFF).not.toContain("http://localhost:3101");
    for (const name of [
      "BETTER_AUTH_URL",
      "NEXT_PUBLIC_BETTER_AUTH_URL",
      "NEXT_PUBLIC_APP_URL",
      "NEXT_PUBLIC_SITE_URL",
    ]) {
      expect(PIXEL_DIFF).toMatch(
        new RegExp(`echo "${name}=http://localhost:\\$\\{port\\}"`),
      );
    }
  });

  it("derives it before the build that bakes those URLs in", () => {
    const derivation = PIXEL_DIFF.indexOf("E2E_DESIGN_PORT=");
    const build = PIXEL_DIFF.indexOf("run: pnpm build");
    expect(derivation).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(derivation).toBeLessThan(build);
  });

  it("still binds the server and the readiness probe to that one port", () => {
    expect(PIXEL_DIFF).toContain('PORT="$E2E_DESIGN_PORT"');
    expect(PIXEL_DIFF).toContain('"http://localhost:${E2E_DESIGN_PORT}/design-fixtures/conformance"');
  });
});

// THE DERIVATION IS RUN, NOT ONLY READ.
//
// Every assertion above is textual, and text can be satisfied without isolating
// anything: a step that kept the RUNNER_NAME mention and the $GITHUB_ENV export
// but wrote a constant `port=3101` would pass all of them and would reproduce
// the very defect. So the shipped step's own script is extracted from the
// workflow and EXECUTED for the runner names this organisation actually
// registers, and the ports it hands out are read back out of $GITHUB_ENV.

/** The `run:` script of the step whose name matches, dedented to column 0. */
function stepScript(block, nameMatcher) {
  const lines = block.split("\n");
  const head = lines.findIndex((line) => nameMatcher.test(line));
  if (head === -1) return null;
  const runAt = lines.findIndex(
    (line, index) => index > head && /^ {8}run: \|\s*$/.test(line),
  );
  if (runAt === -1) return null;
  const body = [];
  for (let index = runAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (!/^ {10}/.test(line)) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

/** Runs the shipped derivation as that runner and returns what it exported. */
function deriveAs(script, runnerName) {
  const dir = mkdtempSync(join(tmpdir(), "design-port-"));
  const envFile = join(dir, "github-env");
  writeFileSync(envFile, "");
  execFileSync("bash", ["-c", script], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_NAME: runnerName,
      GITHUB_ENV: envFile,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exported = new Map();
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) exported.set(line.slice(0, at), line.slice(at + 1));
  }
  return exported;
}

// The runners this organisation registers, read from the live org runner list
// on 2026-09-13: box3-runner-1 .. box3-runner-6, all on ONE self-hosted box —
// which is exactly the population that must not share a port.
const REGISTERED = [
  "box3-runner-1",
  "box3-runner-2",
  "box3-runner-3",
  "box3-runner-4",
  "box3-runner-5",
  "box3-runner-6",
];

describe("the derivation, executed", () => {
  const script = () => {
    const found = stepScript(PIXEL_DIFF ?? "", /- name: .*[Dd]eriv.*port/);
    expect(found, "the derivation step's run: script").toBeTypeOf("string");
    return found;
  };

  it("gives every registered runner of the box a port of its own", () => {
    const run = script();
    const ports = REGISTERED.map((name) =>
      Number(deriveAs(run, name).get("E2E_DESIGN_PORT")),
    );
    for (const port of ports) {
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThanOrEqual(3101);
      expect(port).toBeLessThanOrEqual(3999);
    }
    expect(new Set(ports).size).toBe(REGISTERED.length);
  });

  it("points all four base URLs at the port it just derived", () => {
    const run = script();
    const exported = deriveAs(run, REGISTERED[0]);
    const port = exported.get("E2E_DESIGN_PORT");
    expect(port).toMatch(/^\d+$/);
    for (const name of [
      "BETTER_AUTH_URL",
      "NEXT_PUBLIC_BETTER_AUTH_URL",
      "NEXT_PUBLIC_APP_URL",
      "NEXT_PUBLIC_SITE_URL",
    ]) {
      expect(exported.get(name)).toBe(`http://localhost:${port}`);
    }
  });

  it("survives a nameless runner and a name whose digits are zero-padded", () => {
    const run = script();
    for (const name of ["", "runner-000008", "no-digits-at-all"]) {
      const port = Number(deriveAs(run, name).get("E2E_DESIGN_PORT"));
      expect(Number.isInteger(port), `runner name ${JSON.stringify(name)}`).toBe(
        true,
      );
      expect(port).toBeGreaterThanOrEqual(3101);
      expect(port).toBeLessThanOrEqual(3999);
    }
  });
});

describe("the port-freeing step kills only a holder it can claim", () => {
  it("looks at listening sockets and identifies the process before killing", () => {
    const free = stepScript(PIXEL_DIFF ?? "", /- name: .*[Ff]ree.*port/);
    expect(free).toBeTypeOf("string");
    // A listening socket, not any connected client of that port.
    expect(free).toContain("-sTCP:LISTEN");
    // The holder is identified: the design server's own command line, and the
    // runner's own work root when the runner exposes it.
    expect(free).toContain("server.js");
    expect(free).toContain("RUNNER_WORKSPACE");
  });

  it("refuses — loudly — to free a port held by anything else", () => {
    const free = stepScript(PIXEL_DIFF ?? "", /- name: .*[Ff]ree.*port/);
    expect(free).toBeTypeOf("string");
    expect(free).toMatch(/::error::/);
    expect(free).toMatch(/exit 1/);
    // The refusal must come BEFORE the first kill, or it is decoration. The
    // kill is matched as its actual invocation, not as the word in prose.
    const firstKill = free.search(/\bkill (?:-9 )?"\$\{pid\}"/);
    expect(firstKill).toBeGreaterThan(-1);
    expect(free.indexOf("exit 1")).toBeLessThan(firstKill);
  });
});
