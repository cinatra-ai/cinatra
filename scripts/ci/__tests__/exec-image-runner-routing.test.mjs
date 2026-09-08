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

import { readFileSync } from "node:fs";
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
