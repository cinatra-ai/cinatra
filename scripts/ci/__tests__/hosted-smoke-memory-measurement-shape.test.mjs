// Hosted "/agents Playwright smoke" memory measurement (cinatra#3382): the
// SHAPE of the two steps shipped into the real workflow file in this repo.
//
// The job died three times at each of two candidate heads with "The runner has
// received a shutdown signal", each time after a green run of the SAME head —
// so the job's demand on the 7 GB hosted VM is what has to be measured before
// anything is capped or moved. These assertions guard the measurement itself:
// the sampler starts BEFORE the build/boot, the report runs even when the job
// dies, both halves read ONE pid variable, and the samples leave the VM as a
// named artifact.
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
  "dashboard-live-verify.yml",
);

const workflow = fs.readFileSync(WORKFLOW_PATH, "utf8");

// The `smoke` job, from its key to the end of the file / the next job key.
const smokeJob = () => {
  const from = workflow.indexOf("\n  smoke:\n");
  expect(from).toBeGreaterThan(-1);
  const rest = workflow.slice(from + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

// Every step of the job, in order, as { name, text, index }.
const steps = () => {
  const job = smokeJob();
  const marks = [...job.matchAll(/^ {6}- name: (.+)$/gm)];
  return marks.map((m, i) => ({
    name: m[1].trim(),
    index: i,
    text: job.slice(
      m.index,
      i + 1 < marks.length ? marks[i + 1].index : job.length,
    ),
  }));
};

// Resolved LAZILY inside each test: a step that does not exist yet must redden
// the one assertion that asks for it, not the whole file at collection time.
const step = (predicate, what) => {
  const found = steps().filter(predicate);
  expect(found, `no ${what} step in the smoke job`).toHaveLength(1);
  return found[0];
};

const SAMPLER = () =>
  step((s) => /memory sampler/i.test(s.name) && /^\s*run: \|/m.test(s.text) && !/Stop/i.test(s.name), "sampler");
const REPORT = () => step((s) => /Stop the memory sampler/i.test(s.name), "sampler-stop/report");
const UPLOAD = () => step((s) => /Upload the memory samples/i.test(s.name), "memory-artifact upload");
const BUILD = () => step((s) => s.name === "Build app (production)", "build");
const BOOT = () => step((s) => /Start standalone server/i.test(s.name), "standalone-server boot");

const PID_VAR = "AGENTS_SMOKE_MEMORY_SAMPLER_PID";
const FILE_VAR = "AGENTS_SMOKE_MEMORY_FILE";

describe("the sampler starts before the boot", () => {
  it("precedes the production build step", () => {
    expect(SAMPLER().index).toBeLessThan(BUILD().index);
  });

  it("precedes the standalone-server boot step", () => {
    expect(SAMPLER().index).toBeLessThan(BOOT().index);
  });

  it("writes its samples under $RUNNER_TEMP", () => {
    expect(SAMPLER().text).toContain("${RUNNER_TEMP}/");
  });

  it("samples the clock, the free -m available column and the top three by RSS, every 5 seconds", () => {
    const text = SAMPLER().text;
    expect(text).toContain("date -u +%T");
    expect(text).toContain("free -m");
    expect(text).toMatch(/mem_available_mb=" \$7/);
    expect(text).toContain("ps -eo rss=,comm= --sort=-rss | head -3");
    expect(text).toMatch(/^\s*sleep 5$/m);
    expect(text).toMatch(/while true; do/);
  });

  it("records the loop's pid to $GITHUB_ENV", () => {
    expect(SAMPLER().text).toMatch(
      new RegExp(`echo "${PID_VAR}=\\$!" >> "\\$GITHUB_ENV"`),
    );
  });

  it("stays on the real-smoke path, gated exactly like the other real steps", () => {
    expect(SAMPLER().text).toContain(
      "if: ${{ needs.detect.outputs.run_real == 'true' }}",
    );
  });
});

describe("the report runs even when the job dies", () => {
  it("carries if: always()", () => {
    expect(REPORT().text).toMatch(/^ {8}if: \$\{\{ always\(\) \}\}$/m);
  });

  it("comes after the sampler and after the smoke assert", () => {
    expect(REPORT().index).toBeGreaterThan(SAMPLER().index);
    expect(REPORT().index).toBeGreaterThan(
      step((s) => s.name === "Assert smoke passed", "assert").index,
    );
  });

  it("prints the peak used memory, the minimum available and the last 40 lines", () => {
    const text = REPORT().text;
    expect(text).toContain("peak used memory");
    expect(text).toContain("minimum available memory");
    expect(text).toContain("tail -40");
  });
});

describe("both halves read the same pid variable", () => {
  it("the sampler writes it and the report kills by it", () => {
    expect(SAMPLER().text).toContain(`${PID_VAR}=`);
    expect(REPORT().text).toMatch(
      new RegExp(`pid="\\$\\{${PID_VAR}:-\\}"`),
    );
    expect(REPORT().text).toMatch(/^\s*kill "\$pid"/m);
  });

  it("carries the sample path across on one variable too", () => {
    expect(SAMPLER().text).toContain(`${FILE_VAR}=`);
    expect(REPORT().text).toContain(`${FILE_VAR}:-`);
  });
});

describe("the samples leave the VM", () => {
  it("uploads them as the artifact named agents-smoke-memory, always, sha-pinned", () => {
    const text = UPLOAD().text;
    expect(text).toMatch(/^ {8}if: \$\{\{ always\(\) \}\}$/m);
    expect(text).toMatch(
      /uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+/,
    );
    expect(text).toMatch(/^ {10}name: agents-smoke-memory$/m);
    expect(text).toContain(`env.${FILE_VAR}`);
    // never an empty path input on the stub path, where the sampler never ran
    expect(text).toContain("runner.temp");
    expect(text).toContain("if-no-files-found: ignore");
  });

  it("uploads after the report step", () => {
    expect(UPLOAD().index).toBeGreaterThan(REPORT().index);
  });
});

describe("nothing else in the job changed", () => {
  it("keeps the job's runner, cap and the boot it measures", () => {
    const job = smokeJob();
    expect(job).toContain(
      "runs-on: ${{ fromJSON(vars.CI_RUNNER_E2E || '\"ubuntu-latest\"') }}",
    );
    expect(job).toMatch(/^ {4}timeout-minutes: 45$/m);
    expect(BUILD().text).toContain("CINATRA_BUILD_CPUS: \"1\"");
    expect(BUILD().text).toContain("NODE_OPTIONS: --max-old-space-size=4096");
  });
});
