import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_VERSION, CLASSES, WORKFLOW, identity, jobSource, renderWorkflow, sourceFiles,
  summarizeSamples, trialComparison, trialJob, verifyWorkflow, collectComparison, stopSampler,
} from "../hosted-build-size-trial.mjs";

import { checkWorkflow } from "../build-push-cache-branching.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HEAD = "a".repeat(40);
const folders = [];
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
const temporary = () => { const folder = fs.mkdtempSync(path.join(os.tmpdir(), "runner-trial-")); folders.push(folder); return folder; };
function environment(cohort = "large") {
  return { TRIAL_WORKLOAD: "design", TRIAL_COHORT: cohort, GITHUB_EVENT_NAME: "workflow_dispatch",
    TRIAL_ATTEMPT: "1", TRIAL_SOURCE_SHA: HEAD, GITHUB_SHA: HEAD, TRIAL_RUN_ID: "100",
    TRIAL_RUNNER_ENVIRONMENT: "github-hosted" };
}
function machine(cohort = "large") {
  return { os: "ubuntu", version: "24.04", arch: "x64", cpus: cohort === "large" ? 8 : 4,
    memoryMiB: cohort === "large" ? 32768 : 16384 };
}
function records() {
  let id = 100;
  return ["standard", "large"].flatMap((cohort) => Object.keys(CLASSES).map((workload) => {
    id++;
    const run = { id, status: "completed", event: "workflow_dispatch", run_attempt: 1, head_sha: HEAD,
      path: WORKFLOW, display_title: "hosted-build-size-trial / " + cohort + " / " + workload,
      repository: { full_name: "example/project" }, conclusion: "success", updated_at: "2026-09-20T00:10:00Z" };
    const jobs = { total_count: 3, jobs: Object.keys(CLASSES).map((name, index) => ({
      id: id * 10 + index, run_id: id, head_sha: HEAD, status: "completed",
      // The actual documented jobs schema need not carry a run_attempt field:
      // the caller reads /attempts/1/jobs and checks the run before and after.
      name: "trial / " + name + " / " + cohort,
      conclusion: name === workload ? "success" : "skipped",
      runner_group_id: cohort === "large" ? 9 : 0,
      started_at: "2026-09-20T00:00:00Z", completed_at: "2026-09-20T00:10:00Z",
      steps: name === workload ? [
        { name: CLASSES[name].build, conclusion: "success", started_at: "2026-09-20T00:01:00Z", completed_at: "2026-09-20T00:05:00Z" },
        { name: CLASSES[name].suite, conclusion: "success" },
      ] : [],
    })) };
    const terminal = { version: 1, runId: id, sourceSha: HEAD, attempt: 1, workload, cohort,
      samplerStopped: true, machine: machine(cohort), build: "success", suite: "success",
      startedAt: "2026-09-20T00:00:00Z", finishedAt: "2026-09-20T00:10:00Z",
      memory: { samples: 120, minimumAvailableMiB: 1000, maximumSwapUsedMiB: 500, complete: true,
        largestGapMs: 5000, sampleStart: "2026-09-20T00:00:00Z", sampleEnd: "2026-09-20T00:10:00Z" } };
    const initial = identity({ ...environment(cohort), TRIAL_WORKLOAD: workload, TRIAL_RUN_ID: String(id) }, machine(cohort));
    return { run, jobs, log: "2026-09-20T00:00:00Z HOSTED_BUILD_TRIAL_IDENTITY " + JSON.stringify(initial) +
      "\n2026-09-20T00:10:00Z HOSTED_BUILD_TRIAL_RESULT " + JSON.stringify(terminal) + "\n" };
  }));
}

describe("isolated generated job cut", () => {
  it("matches the checked-in workflow and the actual three maintained job bodies", () => {
    expect(() => verifyWorkflow(ROOT)).not.toThrow();
    expect(renderWorkflow(sourceFiles(ROOT))).toBe(fs.readFileSync(path.join(ROOT, WORKFLOW), "utf8"));
  });
  it("runs full real workloads, preserving caps/builds/smoke and omitting publication/media", () => {
    const yaml = renderWorkflow(sourceFiles(ROOT));
    expect(yaml).toContain("options: [standard, large]");
    expect(yaml).toContain("options: [design, dashboard, image]");
    expect(yaml.match(/^  (?:design|dashboard|image):$/gm)).toHaveLength(3);
    expect(yaml.match(/github.run_attempt == 1/g)).toHaveLength(3);
    expect(yaml).toContain("DESIGN_SELECT=all node scripts/ci/design-select.mjs --out design-select.json");
    expect(yaml).toContain("node scripts/ci/design-select.mjs --run --plan design-select.json");
    expect(yaml).toContain("timeout --kill-after=60 1200 pnpm test:e2e:dashboards");
    expect(yaml).toContain("run: bash scripts/ci/prod-boot-e2e.sh");
    expect(yaml).toContain("load: true");
    expect(yaml).toContain('DOCKER_BUILD_RECORD_UPLOAD: "false"');
    expect(yaml).not.toMatch(/uses: actions\/(?:upload-artifact|download-artifact|cache)@/);
    expect(yaml).not.toMatch(/^\s+push:\s*true|actions:\s*write|packages:\s*write/m);
    expect(yaml).not.toContain("vars.CI_RUNNER");
    expect(yaml).not.toContain("publish-nonrelease-image:");
    expect(yaml).not.toMatch(/\$\{\{[^}]*needs\./);
    expect(yaml.match(/timeout-minutes: (90|45)\n/g)).toHaveLength(3);
  });
  it("removes cache consumers and their preparer while preserving the live cache guard", () => {
    const yaml = renderWorkflow(sourceFiles(ROOT));
    expect(yaml).not.toMatch(/LOCAL_BUILDX_CACHE_DIR|cache-(?:from|to):/);
    expect(checkWorkflow({ file: WORKFLOW, text: yaml })).toEqual([]);
    const source = sourceFiles(ROOT).image.replace(
      "Prepare the runner-local buildx cache directory (self-hosted only)", "Changed cache preparer",
    );
    expect(() => trialJob("image", source)).toThrow(/unadapted trial buildx cache state/);
  });
  it("binds the source body, so changed production commands cannot silently keep a stale trial", () => {
    const root = temporary();
    fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    for (const rule of Object.values(CLASSES)) fs.copyFileSync(path.join(ROOT, ".github/workflows", rule.file), path.join(root, ".github/workflows", rule.file));
    fs.copyFileSync(path.join(ROOT, WORKFLOW), path.join(root, WORKFLOW));
    const file = path.join(root, ".github/workflows/dashboard-live-verify.yml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("pnpm build", "pnpm build --different"));
    expect(() => verifyWorkflow(root)).toThrow(/parity/);
  });
  it("refuses missing or duplicated workload steps and changed time budgets", () => {
    const source = jobSource(sourceFiles(ROOT).image, "image");
    expect(() => trialJob("image", source.replace("timeout-minutes: 45", "timeout-minutes: 90"))).toThrow(/timeout/);
    expect(() => trialJob("image", source.replace("Build image (load for prod-boot e2e)", "Different build"))).toThrow(/workload/);
    expect(() => trialJob("image", source + "      - name: Build image (load for prod-boot e2e)\n        run: true\n")).toThrow(/workload/);
  });
});

describe("first-attempt immutable hosted identity", () => {
  it.each(["standard", "large"])("accepts the exact %s class", (cohort) => {
    expect(identity(environment(cohort), machine(cohort)).cohort).toBe(cohort);
  });
  it.each([
    { TRIAL_ATTEMPT: "2" }, { GITHUB_EVENT_NAME: "pull_request" }, { TRIAL_COHORT: "unknown" },
    { TRIAL_WORKLOAD: "publish" }, { GITHUB_SHA: "b".repeat(40) }, { TRIAL_RUNNER_ENVIRONMENT: "self-hosted" },
    { TRIAL_RUN_ID: "0" },
  ])("refuses the changed run binding %j before work", (change) => {
    expect(() => identity({ ...environment(), ...change }, machine())).toThrow();
  });
  it.each([{ cpus: 4 }, { memoryMiB: 16384 }, { version: "22.04" }, { arch: "arm64" }])("refuses a wrong machine %j", (change) => {
    expect(() => identity(environment(), { ...machine(), ...change })).toThrow(/runner/);
  });
  it("refuses missing or malformed samples instead of reporting zero usage", () => {
    expect(() => summarizeSamples("")).toThrow(/incomplete/);
    expect(() => summarizeSamples('{"at":"nonsense","availableMiB":1,"swapUsedMiB":0}\n')).toThrow(/timestamp/);
    expect(summarizeSamples('{"at":"2026-09-20T00:00:00Z","availableMiB":123,"swapUsedMiB":7}\n', "2026-09-20T00:00:00Z", "2026-09-20T00:00:05Z").minimumAvailableMiB).toBe(123);
  });
});

describe("bounded real sampler lifecycle", () => {
  const code = path.join(ROOT, "scripts/ci/hosted-build-size-trial.mjs");
  it("stops only its matching live process and waits for exit", async () => {
    const file = path.join(temporary(), "memory.jsonl");
    const child = spawn(process.execPath, [code, "sample", file, "30"], { stdio: "ignore" });
    const exited = once(child, "exit");
    try {
      for (let pass = 0; pass < 100 && !fs.existsSync(file); pass++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fs.existsSync(file)).toBe(true);
      await expect(stopSampler(child.pid, file + ".different")).rejects.toThrow(/identity differs/);
      expect(child.exitCode).toBeNull();
      await stopSampler(child.pid, file);
      await exited;
      expect(fs.readFileSync(file, "utf8")).toContain("availableMiB");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      await stopSampler(child.pid, file);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    }
  });
  it("self-terminates at its own duration without a cleanup step", async () => {
    const file = path.join(temporary(), "memory.jsonl"), start = Date.now();
    const child = spawn(process.execPath, [code, "sample", file, "1"], { stdio: "ignore" });
    const [status] = await once(child, "exit");
    expect(status).toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
  });
  it.each([
    [{ at: "2026-02-30T00:00:00Z", availableMiB: 1, swapUsedMiB: 0 }],
    [{ at: "2026-09-20T00:00:00Z", availableMiB: -1, swapUsedMiB: 0 }],
    [{ at: "2026-09-20T00:00:00Z", availableMiB: 1, swapUsedMiB: 0 }],
    [{ at: "2026-09-20T00:00:20Z", availableMiB: 1, swapUsedMiB: 0 },
      { at: "2026-09-20T00:00:00Z", availableMiB: 1, swapUsedMiB: 0 }],
  ])("refuses invalid, negative, stale or reversed samples %#", (...rows) => {
    expect(() => summarizeSamples(rows.map((row) => JSON.stringify(row)).join("\n"),
      "2026-09-20T00:00:00Z", "2026-09-20T00:01:00Z")).toThrow();
  });
});

describe("direct run denominators", () => {
  it("counts all three real job classes in each cohort without watcher artifacts", () => {
    const report = trialComparison(records(), HEAD, 9);
    expect(report.cohorts.map((row) => [row.jobs, row.successful, row.shutdownSignatures])).toEqual([[3, 3, 0], [3, 3, 0]]);
    expect(report.observationsPerWorkload).toBe(1);
    expect(report.rows[0].buildSeconds).toBe(240);
  });
  it("keeps a terminated workload in its denominator and marks lost memory unknown", () => {
    const rows = records(); const row = rows[5];
    row.run.conclusion = "failure";
    const active = row.jobs.jobs.find((job) => job.conclusion !== "skipped");
    active.conclusion = "failure"; active.steps[0].conclusion = "cancelled";
    row.log = row.log.split("\n")[0] + "\nThe runner has received a shutdown signal\n";
    const report = trialComparison(rows, HEAD, 9);
    expect(report.cohorts[1]).toMatchObject({ jobs: 3, successful: 2, shutdownSignatures: 1, unknownMeasurements: 1 });
    expect(report.rows[5].memory).toBeNull();
    expect(report.rows[5].measurement).toBe("unknown-after-shutdown");
  });
  it.each([
    (rows) => rows.pop(),
    (rows) => { rows[1] = rows[0]; },
    (rows) => { rows[0].run.run_attempt = 2; },
    (rows) => { rows[0].run.head_sha = "b".repeat(40); },
    (rows) => { rows[0].jobs.total_count = 4; },
    (rows) => { rows[3].jobs.jobs.find((job) => job.conclusion !== "skipped").runner_group_id = 8; },
    (rows) => { rows[0].jobs.jobs[1].conclusion = "success"; },
    (rows) => { rows[0].log = ""; },
    (rows) => { rows[0].log = rows[0].log.split("\n")[0] + "\ngreen but missing trial result"; },
    (rows) => { rows[0].log += rows[0].log; },
    (rows) => { rows[0].log = rows[0].log.replace('"complete":true', '"complete":false'); },
    (rows) => { rows[0].jobs.jobs[0].steps = []; },
    (rows) => { rows[0].jobs.jobs[0].completed_at = "2026-02-30T00:10:00Z"; },
  ])("refuses incomplete, duplicate, retargeted or falsely green evidence %#", (change) => {
    const rows = records(); change(rows);
    expect(() => trialComparison(rows, HEAD, 9)).toThrow();
  });
  it.each(["parity failed before work", "runner class refused", ""])( "refuses pre-admission failures: %s", (log) => {
    const rows = records(); const row = rows[0];
    row.run.conclusion = "failure"; row.jobs.jobs[0].conclusion = "failure"; row.log = log || "no initial record";
    expect(() => trialComparison(rows, HEAD, 9)).toThrow(/initial trial identity/);
  });
  it.each([
    (initial) => { initial.machine.cpus = 2; },
    (initial) => { initial.sourceSha = "b".repeat(40); },
    (initial) => { initial.runId = 999; },
    (initial) => { initial.attempt = 2; },
    (initial) => { initial.cohort = "large"; },
    (initial) => { initial.workload = "image"; },
  ])("refuses a malformed initial binding even when no terminal receipt exists %#", (change) => {
    const rows = records(); const row = rows[0];
    row.run.conclusion = "failure"; row.jobs.jobs[0].conclusion = "failure";
    const initial = JSON.parse(row.log.split("HOSTED_BUILD_TRIAL_IDENTITY ")[1].split("\n")[0]);
    change(initial);
    row.log = "HOSTED_BUILD_TRIAL_IDENTITY " + JSON.stringify(initial) + "\n";
    expect(() => trialComparison(rows, HEAD, 9)).toThrow();
  });
  it("keeps admitted failure without terminal evidence factual, without inventing a shutdown", () => {
    const rows = records(); const row = rows[0];
    row.run.conclusion = "failure"; row.jobs.jobs[0].conclusion = "failure";
    row.log = row.log.split("\n")[0] + "\nordinary command failed";
    const actual = trialComparison(rows, HEAD, 9);
    expect(actual.rows[0]).toMatchObject({ shutdownSignature: false, measurement: "unknown-missing-terminal", memory: null });
    expect(actual.cohorts[0].jobs).toBe(3);
  });
  it("accepts the documented offset form for actual API build timestamps", () => {
    const rows = records();
    rows[0].jobs.jobs[0].steps[0].started_at = "2026-09-19T16:01:00.000-08:00";
    expect(trialComparison(rows, HEAD, 9).rows[0].buildSeconds).toBe(240);
  });
  it("collects only bounded GET reads bound to attempt1, then rereads each run", async () => {
    const rows = records(), calls = [];
    const fetcher = async (url, options) => {
      calls.push([url, options]);
      const job = /\/actions\/jobs\/(\d+)\/logs$/.exec(url);
      if (job) return new Response(rows.find((row) => row.jobs.jobs.some((entry) => entry.id === Number(job[1]))).log);
      const match = /\/actions\/runs\/(\d+)(.*)$/.exec(url);
      const row = rows.find((entry) => entry.run.id === Number(match[1]));
      return Response.json(match[2] ? row.jobs : row.run);
    };
    const result = await collectComparison({ repository: "example/project", runIds: rows.map((row) => row.run.id), head: HEAD, groupId: 9, token: "fixture", fetcher });
    expect(result.rows).toHaveLength(6);
    expect(calls).toHaveLength(24);
    expect(calls.every(([url, options]) => url.startsWith("https://api.github.com/repos/example/project/") && options.method === "GET")).toBe(true);
    expect(calls.filter(([url]) => url.includes("/attempts/1/jobs?"))).toHaveLength(6);
    expect(calls.every(([, options]) => options.headers["X-GitHub-Api-Version"] === API_VERSION)).toBe(true);
  });
  it("stops on API failure or an inventory that changes during collection", async () => {
    const rows = records(); let reads = 0;
    await expect(collectComparison({ repository: "example/project", runIds: rows.map((row) => row.run.id), head: HEAD, groupId: 9, token: "fixture",
      fetcher: async () => new Response("unavailable", { status: 503 }) })).rejects.toThrow(/HTTP 503/);
    await expect(collectComparison({ repository: "example/project", runIds: rows.map((row) => row.run.id), head: HEAD, groupId: 9, token: "fixture",
      fetcher: async (url) => {
        if (url.includes("/logs")) return new Response(rows[0].log);
        if (url.includes("/jobs?")) return Response.json(rows[0].jobs);
        return Response.json({ ...rows[0].run, run_attempt: ++reads === 1 ? 1 : 2 });
      } })).rejects.toThrow(/changed during/);
  });
});
