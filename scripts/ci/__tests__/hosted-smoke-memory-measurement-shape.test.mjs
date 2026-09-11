// Hosted "/agents Playwright smoke" memory measurement (cinatra#3382): the
// SHAPE of the measurement shipped into the real workflow file in this repo.
//
// The job died three times at each of two candidate heads with "The runner has
// received a shutdown signal", each time after a green run of the SAME head —
// so the job's demand on the hosted VM is what has to be measured before
// anything is capped or moved.
//
// The first measured run proved WHERE the samples have to be written: the
// sampler was started as a background process in a step of its own, and a
// background process's stdout belongs to the step that started it and is
// closed when that step ends — so the job log of the run that died carried
// exactly ONE sample line (mem_used_mb=1623 mem_available_mb=14366 at
// 00:47:19Z) although the job ran on for minutes, and the file the always()
// step would have uploaded died with the VM. These assertions therefore pin
// the sampler INSIDE the step that boots the app and runs the smoke: the loop
// backgrounded at the top of that step's script, the smoke run in the
// foreground, the loop killed by pid in the same script (also on error,
// through a trap) — so every sample up to the moment of death is in the job
// log of a step that is still running. The always() report and the artifact
// are kept for the runs that complete.
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

// The shell script of a step, without its YAML key lines.
const runBlock = (s) => {
  const m = /^ {8}run: \|\s*\n([\s\S]*)$/m.exec(s.text);
  expect(m, `step "${s.name}" has no run block`).not.toBeNull();
  return m[1];
};

const SAMPLE_LOOP = (s) =>
  /while true; do/.test(s.text) &&
  /free -m/.test(s.text) &&
  !/Stop the memory sampler/i.test(s.name);
const SMOKE_CMD = "pnpm test:e2e:dashboards";

// The ONE step that carries the sampler loop — the same step that boots the
// app and runs the smoke.
const SAMPLED_SMOKE = () => step(SAMPLE_LOOP, "sampler-carrying");
const REPORT = () =>
  step((s) => /Stop the memory sampler/i.test(s.name), "sampler-stop/report");
const UPLOAD = () =>
  step(
    (s) => /Upload the memory samples/i.test(s.name),
    "memory-artifact upload",
  );
const BUILD = () => step((s) => s.name === "Build app (production)", "build");

const PID_VAR = "AGENTS_SMOKE_MEMORY_SAMPLER_PID";
const FILE_VAR = "AGENTS_SMOKE_MEMORY_FILE";

describe("the sampler runs inside the step that boots the app and runs the smoke", () => {
  it("starts the loop and invokes the smoke in ONE run block", () => {
    const block = runBlock(SAMPLED_SMOKE());
    expect(block).toMatch(/while true; do/);
    expect(block).toContain(SMOKE_CMD);
    // the smoke runs in the foreground, after the loop is backgrounded
    expect(block.indexOf("while true; do")).toBeLessThan(
      block.indexOf(SMOKE_CMD),
    );
  });

  it("boots the app in that same block", () => {
    const block = runBlock(SAMPLED_SMOKE());
    expect(block).toContain("node server.js");
    expect(block).toContain("http://localhost:3100/api/auth/get-session");
  });

  it("leaves NO separate sampler-only step behind", () => {
    const carriers = steps().filter(SAMPLE_LOOP);
    expect(carriers).toHaveLength(1);
    for (const s of carriers) {
      expect(
        s.text,
        `sampler step "${s.name}" does not run the smoke`,
      ).toContain(SMOKE_CMD);
    }
    expect(
      steps().map((s) => s.name),
      "the sampler no longer has a step of its own",
    ).not.toContain("Start the hosted-VM memory sampler");
  });

  it("kills the loop by pid in the same script, and on error through a trap", () => {
    const block = runBlock(SAMPLED_SMOKE());
    expect(block).toMatch(/SAMPLER_PID=\$!/);
    expect(block).toMatch(/trap '.*kill "\$SAMPLER_PID".*' EXIT/);
    expect(block).toMatch(/^\s*kill "\$SAMPLER_PID"/m);
  });

  it("writes its samples under the runner temp directory", () => {
    expect(runBlock(SAMPLED_SMOKE())).toContain("${RUNNER_TEMP}/");
  });

  it("samples the clock, the free -m available column and the top three by RSS, every 5 seconds", () => {
    const text = runBlock(SAMPLED_SMOKE());
    expect(text).toContain("date -u +%T");
    expect(text).toContain("free -m");
    expect(text).toMatch(/mem_available_mb=" \$7/);
    expect(text).toContain("ps -eo rss=,comm= --sort=-rss | head -3");
    expect(text).toMatch(/^\s*sleep 5$/m);
  });

  it("writes every sample to the job log as well as the file, unbuffered", () => {
    const text = runBlock(SAMPLED_SMOKE());
    // Each sample block goes through tee: the file AND the stdout of the step
    // that is still running, so the samples taken up to the moment the runner
    // kills the VM survive in the job log even when the always() report and
    // the artifact upload never run.
    expect(text).toMatch(/\}\s*\|\s*stdbuf -oL tee -a "\$SAMPLE_FILE"/);
    // never the file-only redirect, whose samples die with the VM
    expect(text).not.toMatch(/\}\s*>>\s*"\$SAMPLE_FILE"/);
    // and the log half is not thrown away
    expect(text).not.toMatch(/tee -a "\$SAMPLE_FILE"\s*>\s*\/dev\/null/);
  });

  it("records the loop's pid and the sample path to the job env file", () => {
    const text = runBlock(SAMPLED_SMOKE());
    expect(text).toMatch(
      new RegExp(`echo "${PID_VAR}=\\$\\{SAMPLER_PID\\}" >> "\\$GITHUB_ENV"`),
    );
    expect(text).toMatch(
      new RegExp(`echo "${FILE_VAR}=\\$\\{SAMPLE_FILE\\}" >> "\\$GITHUB_ENV"`),
    );
  });

  it("keeps the smoke exit code on the e2e step id the assert step reads", () => {
    const s = SAMPLED_SMOKE();
    expect(s.text).toMatch(/^ {8}id: e2e$/m);
    expect(runBlock(s)).toMatch(/echo "code=\$\{code\}" >> "\$GITHUB_OUTPUT"/);
  });

  it("stays on the real-smoke path, gated exactly like the other real steps", () => {
    expect(SAMPLED_SMOKE().text).toContain(
      "if: ${{ needs.detect.outputs.run_real == 'true' }}",
    );
  });

  it("runs after the production build whose boot it measures", () => {
    expect(SAMPLED_SMOKE().index).toBeGreaterThan(BUILD().index);
  });
});

describe("the report runs even when the job dies", () => {
  it("carries if: always()", () => {
    expect(REPORT().text).toMatch(/^ {8}if: \$\{\{ always\(\) \}\}$/m);
  });

  it("comes after the sampled smoke and after the smoke assert", () => {
    expect(REPORT().index).toBeGreaterThan(SAMPLED_SMOKE().index);
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
  it("the sampled smoke writes it and the report kills by it", () => {
    expect(runBlock(SAMPLED_SMOKE())).toContain(`${PID_VAR}=`);
    expect(REPORT().text).toMatch(new RegExp(`pid="\\$\\{${PID_VAR}:-\\}"`));
    expect(REPORT().text).toMatch(/^\s*kill "\$pid"/m);
  });

  it("carries the sample path across on one variable too", () => {
    expect(runBlock(SAMPLED_SMOKE())).toContain(`${FILE_VAR}=`);
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
    expect(BUILD().text).toContain('CINATRA_BUILD_CPUS: "1"');
    expect(BUILD().text).toContain("NODE_OPTIONS: --max-old-space-size=4096");
  });
});
