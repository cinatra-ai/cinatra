// THE RUNNER CLASS OF THE IMAGE SMOKE JOB (cinatra#3267, the grounding leg).
//
// Routing on this repo is variable-driven: a job names a CLASS and the class is
// pointed at a machine by a repository variable, so moving work between the
// GitHub-hosted runners and the self-hosted pool never needs a workflow edit.
// That is exactly why a class assignment needs a pin — nothing else in the tree
// records WHICH class a job belongs to, and a one-word edit moves a job to a
// machine that cannot run it.
//
// The class this suite exists for is SMOKE. Its job builds a container image,
// LOADS it into the runner's own docker daemon and runs it out of that daemon in
// a LATER step. On a machine whose docker engine is shared between concurrently
// running jobs that tag did not survive the gap: the build named
// `docker.io/library/cinatra-exec-worker:ci` in its own metadata and the next
// step's `docker run` answered "Unable to find image ... locally" 71 seconds
// later. So the class defaults to the hosted runner, where the daemon belongs to
// one job, and this suite refuses a silent move back.
//
// Dependency-free by construction (this repo carries no YAML parser): the
// scanner below reads each workflow as indented text, the way the sibling
// workflow-shape guards under scripts/ci/__tests__ already do.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const EXEC_WORKFLOW = ".github/workflows/build-exec-images.yml";
const IMAGE_WORKFLOW = ".github/workflows/build-image.yml";

const EXEC_TEXT = readFileSync(join(REPO_ROOT, EXEC_WORKFLOW), "utf8");
const IMAGE_TEXT = readFileSync(join(REPO_ROOT, IMAGE_WORKFLOW), "utf8");

const JOB_HEADER = /^ {2}([A-Za-z0-9_-]+):\s*$/;

/**
 * A whole-line YAML comment. Every assertion below is blind to these: a change
 * that comments the real `runs-on` out and leaves the expected text in a comment
 * would otherwise satisfy the substring assertions while the job ran nowhere.
 */
const isComment = (line) => /^\s*#/.test(line);

/** One job's own block, from its header to the next job header, comments out. */
function jobBlock(text, id) {
  const lines = text.split("\n");
  const jobsLine = lines.findIndex((line) => line === "jobs:");
  const start = lines.findIndex(
    (line, index) => index > jobsLine && JOB_HEADER.exec(line)?.[1] === id,
  );
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !JOB_HEADER.test(lines[end])) end += 1;
  return lines
    .slice(start, end)
    .filter((line) => !isComment(line))
    .join("\n");
}

/** Every real `runs-on:` line of a workflow, comments out. */
function runsOnLines(text) {
  return text.split("\n").filter((line) => !isComment(line) && /^\s*runs-on:/.test(line));
}

const routesTo = (klass) =>
  `runs-on: \${{ fromJSON(vars.CI_RUNNER_${klass} || '"ubuntu-latest"') }}`;

describe("the exec image workflow routes every job by class", () => {
  it("gives the worker build-and-smoke job the SMOKE class of its own", () => {
    // The load-then-run-later contract above. Not E2E: that class is pointed at
    // the shared pool, where the loaded tag was gone by the next step.
    expect(jobBlock(EXEC_TEXT, "build-and-smoke-worker")).toContain(routesTo("SMOKE"));
  });

  it("leaves every other job of that workflow on the class it already had", () => {
    // A pin of what is true today, not an endorsement of it. `build-and-smoke`
    // has the same load-then-run-later shape as the worker job above and is
    // therefore open to the same loss; it has not been seen to lose the tag, so
    // this leg does not move it, and this arm makes moving it a deliberate edit
    // here rather than a silent one there.
    expect(jobBlock(EXEC_TEXT, "changes")).toContain(routesTo("GATE"));
    expect(jobBlock(EXEC_TEXT, "build-and-smoke")).toContain(routesTo("E2E"));
    expect(jobBlock(EXEC_TEXT, "publish-l0-release")).toContain(routesTo("E2E"));
    expect(jobBlock(EXEC_TEXT, "publish-worker-release")).toContain(routesTo("E2E"));
  });

  it("hard-codes no runner label anywhere in that workflow", () => {
    const lines = runsOnLines(EXEC_TEXT);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.trim()).toMatch(
        /^runs-on: \$\{\{ fromJSON\(vars\.CI_RUNNER_[A-Z0-9_]+ \|\| '"ubuntu-latest"'\) \}\}$/,
      );
    }
  });
});

describe("the routing header names the class it routes by", () => {
  it("enumerates SMOKE among the classes", () => {
    // The header of the image workflow is where a reader learns the classes; a
    // class that routes a job but is absent there is a class nobody can find.
    expect(IMAGE_TEXT).toContain("six classes");
    expect(IMAGE_TEXT).toContain("SMOKE");
    expect(IMAGE_TEXT).toContain("`build-and-smoke-worker`");
  });
});

// ---------------------------------------------------------------------------
// THE HOST-MUTATION STEPS, AND THE JOBS THAT MUST STAY ON THE HOSTED RUNNERS
// (cinatra#3267, the correction leg).
//
// Two separate pins live below, both learned from a measured red.
//
// 1. THE HOST-MUTATION GUARD. A handful of steps across the build-carrying
//    workflows delete shared toolchains, prune the whole docker state and write
//    a multi-gigabyte swapfile. On a GitHub-hosted runner the machine is thrown
//    away after the job, so that is free; on a self-hosted machine it is
//    vandalism against every other job on the box. The guard is therefore the
//    RUNNER'S OWN ENVIRONMENT and nothing else. It was briefly ALSO gated on a
//    repository variable that was never created, which turned the steps off on
//    the hosted runners too — the production build then ran with the stock 3G
//    swap on a 16G machine and the runner died mid-build (reported as a
//    shutdown signal). A guard that names a variable is what this arm refuses.
//
// 2. THE JOBS THAT DO NOT SURVIVE THE POOL. Three jobs were routed to the
//    shared self-hosted class and failed there for reasons that belong to the
//    pool, not to the change under test. Each is pinned back to the hosted
//    label with its measured reason written beside it in the workflow.
//
// Both pins are text reads, dependency-free, exactly like the arms above.

const SCALE_WORKFLOW = ".github/workflows/trusted-read-scale-smoke.yml";
const SCALE_TEXT = readFileSync(join(REPO_ROOT, SCALE_WORKFLOW), "utf8");

const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

/**
 * The workflows carrying a guarded host-mutation step, and HOW MANY each
 * carries. The count is the half of this pin that a variable removal cannot
 * satisfy by deleting the steps instead of the clause.
 */
const HOST_MUTATION_SITES = {
  ".github/workflows/build-image.yml": 6,
  ".github/workflows/e2e-app-suites.yml": 2,
  ".github/workflows/design-visual-verify.yml": 1,
  ".github/workflows/wp-drupal-uat.yml": 4,
  ".github/workflows/dashboard-live-verify.yml": 1,
};

const HOST_MUTATION_STEP =
  /^- name: (Add CI build swap|Reclaim runner disk|Enlarge swap|Free runner disk)/;

/** Every host-mutation step of one workflow, with the `if:` line guarding it. */
function hostMutationSteps(text) {
  const lines = text.split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!HOST_MUTATION_STEP.test(lines[i].trim())) continue;
    let guard = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const trimmed = lines[j].trim();
      if (isComment(lines[j])) continue;
      if (trimmed.startsWith("- ")) break; // the next step — this one has no `if:`
      if (trimmed.startsWith("run:") || trimmed.startsWith("uses:")) break;
      if (trimmed.startsWith("if:")) {
        guard = trimmed;
        break;
      }
    }
    found.push({ name: lines[i].trim(), guard });
  }
  return found;
}

/** One job's own block WITH its comments — the reasons are what this reads. */
function rawJobBlock(text, id) {
  const lines = text.split("\n");
  const jobsLine = lines.findIndex((line) => line === "jobs:");
  const start = lines.findIndex(
    (line, index) => index > jobsLine && JOB_HEADER.exec(line)?.[1] === id,
  );
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !JOB_HEADER.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

describe("the host-mutation steps are guarded by the runner's environment alone", () => {
  it("names no build-swap repository variable in any workflow", () => {
    const offenders = readdirSync(WORKFLOW_DIR)
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      .filter((file) => readFileSync(join(WORKFLOW_DIR, file), "utf8").includes("CI_BUILD_SWAP"));
    // A guard nobody ever set is a guard that is always OFF. The hosted runners
    // must get this behaviour with no repository variable in the way.
    expect(offenders).toEqual([]);
  });

  it("guards every host-mutation step on `github-hosted`, with no variable in the condition", () => {
    for (const [workflow, count] of Object.entries(HOST_MUTATION_SITES)) {
      const steps = hostMutationSteps(readFileSync(join(REPO_ROOT, workflow), "utf8"));
      expect(steps.length, workflow).toBe(count);
      for (const step of steps) {
        expect(step.guard, `${workflow} — ${step.name}`).toBeTruthy();
        expect(step.guard, `${workflow} — ${step.name}`).toContain(
          "runner.environment == 'github-hosted'",
        );
        expect(step.guard, `${workflow} — ${step.name}`).not.toContain("vars.");
      }
    }
  });
});

describe("the jobs measured red on the self-hosted pool stay on the hosted runners", () => {
  it("pins the image job and the held-turn e2e to the hosted label", () => {
    // `image` builds the prod-boot e2e image and RUNS it a step later; on the
    // pool's docker-container buildx driver that image never reaches the daemon.
    expect(jobBlock(IMAGE_TEXT, "image")).toContain("runs-on: ubuntu-latest");
    // The held-turn e2e's web server does not boot on the pool.
    expect(jobBlock(IMAGE_TEXT, "chat-hitl-held-turn-e2e")).toContain("runs-on: ubuntu-latest");
  });

  it("pins the live provider-scale proof to the hosted label", () => {
    // The proof shares the pool's WordPress MCP stack and loses its session.
    expect(jobBlock(SCALE_TEXT, "scale-smoke")).toContain("runs-on: ubuntu-latest");
  });

  it("records beside each of them why it is not on the pool", () => {
    // A hard-coded label with no reason next to it is the edit this whole file
    // exists to prevent; the reason IS the pin's other half.
    expect(rawJobBlock(IMAGE_TEXT, "image")).toContain("not the E2E class");
    expect(rawJobBlock(IMAGE_TEXT, "chat-hitl-held-turn-e2e")).toContain("not the E2E class");
    expect(rawJobBlock(SCALE_TEXT, "scale-smoke")).toContain("not the E2E class");
  });
});
