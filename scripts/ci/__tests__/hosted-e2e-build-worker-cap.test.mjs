// Hosted e2e production builds run ONE page-data worker.
//
// Every hosted job that runs `pnpm build` NEXT TO its postgres/redis service
// containers must set CINATRA_BUILD_CPUS: "1" on that build step. The knob maps
// to experimental.cpus in next.config.ts and bounds the page-data worker
// fan-out; each worker is a whole extra Node process with its own heap.
//
// Why: the hosted runner has about 15.6 GiB of RAM, and the measured whole-tree
// peak of this build with 3 page-data workers is about 15.5 GiB (see
// docs/internals/workflows/constrained-host-builds.md). The service containers
// and the runner's own processes come on top. The e2e build jobs that kept the
// default fan-out (3 workers on the 4-vCPU runner) hung in "Build app
// (production)" until the job timeout, with the runner no longer responding:
// the step's own timeout never fired and the job log was never uploaded. The
// hosted /agents smoke build, which already runs 1 worker next to the same
// services, did not hang in the same window.
//
// Read from the real workflow files.
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

const read = (file) =>
  fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", file), "utf8");

/** The text of one job, from its key line to the next job key (or the end). */
function jobText(workflowText, jobKey) {
  const from = workflowText.indexOf(`\n  ${jobKey}:\n`);
  expect(from, `no job "${jobKey}"`).toBeGreaterThan(-1);
  const rest = workflowText.slice(from + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Every step of a job, as { name, text }. */
function steps(job) {
  const marks = [...job.matchAll(/^ {6}- name: (.+)$/gm)];
  return marks.map((m, i) => ({
    name: m[1].trim(),
    text: job.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : job.length),
  }));
}

// [workflow file, job key, build step name]
const HOSTED_BUILDS_WITH_SERVICES = [
  ["build-image.yml", "e2e-rbac", "Build app (production)"],
  ["e2e-app-suites.yml", "render-smoke-e2e", "Build app (production)"],
  ["e2e-app-suites.yml", "notifications-e2e", "Build app (production)"],
  ["dashboard-live-verify.yml", "smoke", "Build app (production)"],
];

describe("hosted e2e builds next to service containers run one page-data worker", () => {
  for (const [file, jobKey, stepName] of HOSTED_BUILDS_WITH_SERVICES) {
    describe(`${file} / ${jobKey}`, () => {
      const job = () => jobText(read(file), jobKey);

      it("has job-level service containers (the reason for the cap)", () => {
        expect(job()).toMatch(/^ {4}services:\n/m);
      });

      it(`sets CINATRA_BUILD_CPUS: "1" on "${stepName}"`, () => {
        const found = steps(job()).filter((s) => s.name === stepName);
        expect(found, `no "${stepName}" step`).toHaveLength(1);
        const [build] = found;
        expect(build.text).toMatch(/pnpm build/);
        expect(build.text).toMatch(/^ {8}env:\n/m);
        expect(build.text).toMatch(/^ {10}CINATRA_BUILD_CPUS: "1"$/m);
      });
    });
  }
});
