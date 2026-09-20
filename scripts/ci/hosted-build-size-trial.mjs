#!/usr/bin/env node
// A manual, bounded runner-size comparison. This helper never dispatches,
// retries, provisions a runner, changes routing, or publishes an image.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

export const WORKFLOW = ".github/workflows/hosted-build-size-trial.yml";
export const GROUP = "ci-build-trial-3316";
export const LABEL = "ci-build-trial-3316-8core";
export const API_VERSION = "2026-03-10";
export const CLASSES = Object.freeze({
  design: { file: "design-visual-verify.yml", job: "pixel-diff", cap: 70,
    build: "Build (standalone production server)", suite: "run functional acceptance + pixel-diff + axe" },
  dashboard: { file: "dashboard-live-verify.yml", job: "smoke", cap: 45,
    build: "Build app (production)", suite: "Assert smoke passed" },
  image: { file: "build-image.yml", job: "image", cap: 45,
    build: "Build image (load for prod-boot e2e)", suite: "Prod-boot e2e — boot the core without private extensions" },
});
const CODE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(CODE), "../..");
const exp = (value) => "$" + "{{ " + value + " }}";
const require = (ok, message) => { if (!ok) throw new Error(message); };
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sha = (value) => /^[0-9a-f]{40}$/.test(value || "");

export function jobSource(text, job) {
  const lines = text.split("\n");
  const start = lines.indexOf("  " + job + ":");
  require(start >= 0, "source job absent: " + job);
  let end = start + 1;
  while (end < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end])) end++;
  // Trailing comments describe the following source job, not this one.
  while (end > start && (!lines[end - 1].trim() || /^\s*#/.test(lines[end - 1]))) end--;
  return lines.slice(start, end).join("\n") + "\n";
}

function stepBlocks(text) {
  const at = text.indexOf("    steps:\n");
  require(at >= 0, "source steps absent");
  const header = text.slice(0, at + "    steps:\n".length);
  const steps = text.slice(at + "    steps:\n".length).split(/(?=^      - )/m);
  const prefix = steps.shift();
  return { header: header + prefix, steps };
}

function named(step) { return /^      - name: (.*)$/m.exec(step)?.[1]; }
function addId(step, id) {
  require(!/^        id:/m.test(step), "source target already has an id; review trial adaptation");
  return step.replace(/^(      - .*\n)/, "$1        id: " + id + "\n");
}

export function trialJob(workload, text) {
  const rule = CLASSES[workload];
  require(rule, "unknown workload");
  let source = jobSource(text, rule.job);
  const sourceDigest = hash(source);
  let { header, steps } = stepBlocks(source);
  header = header.replace("  " + rule.job + ":", "  " + workload + ":");
  header = header.replace(/^    name:.*\n/m, "");
  header = header.replace(/^    needs:.*\n/m, "");
  header = header.replace(/^    if:.*\n/m, "");
  header = header.replace(/^    runs-on:.*\n/m, "");
  const condition = "github.event_name == 'workflow_dispatch' && github.run_attempt == 1 && inputs.workload == '" + workload + "' && (inputs.cohort == 'standard' || inputs.cohort == 'large')";
  const runner = "inputs.cohort == 'large' && fromJSON('" + JSON.stringify({ group: GROUP, labels: LABEL }) + "') || 'ubuntu-24.04'";
  header = header.replace("  " + workload + ":\n", "  " + workload + ":\n" +
    "    name: trial / " + workload + " / " + exp("inputs.cohort") + "\n" +
    "    if: " + exp(condition) + "\n" +
    "    runs-on: " + exp(runner) + "\n");
  header = header.replaceAll(exp("needs.detect.outputs.run_real == 'true' && 'postgres:18' || ''"), "postgres:18")
    .replaceAll(exp("needs.detect.outputs.run_real == 'true' && 'redis:8' || ''"), "redis:8");
  let checkout = 0, build = 0, suite = 0, plan = 0;
  const output = [];
  for (let step of steps) {
    const name = named(step);
    if (/uses: actions\/(?:upload-artifact|download-artifact|cache)@/.test(step)) continue;
    if (name === "Guard — detect must have succeeded" || name === "Skip stub (no dashboard-surface changes)") continue;
    // Both cohorts intentionally run without buildx caches. Drop the matching
    // local-only preparer as well; retaining its export leaves an orphan cache.
    if (name === "Prepare the runner-local buildx cache directory (self-hosted only)") continue;
    // Source selectors only choose whether a real workload is necessary. The
    // trial explicitly requests it and never substitutes a skipped green job.
    step = step.replaceAll("needs.detect.outputs.run_real == 'true' && ", "")
      .replaceAll(" && needs.detect.outputs.run_real == 'true'", "")
      .replace(/^        if: \$\{\{ needs\.detect\.outputs\.run_real == 'true' \}\}\n/gm, "");
    step = step.replace(/^          cache: ["']?pnpm["']?\n/gm, "")
      .replace(/^          cache-(?:from|to):.*\n/gm, "");
    if (name === rule.build) { step = addId(step, "trial_build"); build++; }
    if (name === rule.suite) { step = addId(step, "trial_suite"); suite++; }
    output.push(step);
    if (/uses: actions\/checkout@/.test(step)) {
      checkout++;
      output.push([
        "      - name: Verify immutable trial workload and runner",
        "        id: trial_identity",
        "        env:",
        "          TRIAL_RUNNER_ENVIRONMENT: " + exp("runner.environment"),
        "        run: node scripts/ci/hosted-build-size-trial.mjs begin",
        "",
      ].join("\n"));
    }
    if (workload === "design" && name === "Clone companion extension repos") {
      plan++;
      output.push([
        "      - name: Select the full design workload for both cohorts",
        "        run: DESIGN_SELECT=all node scripts/ci/design-select.mjs --out design-select.json",
        "",
      ].join("\n"));
    }
  }
  require(checkout === 1 && build === 1 && suite === 1 && (workload !== "design" || plan === 1),
    "source workload no longer matches the reviewed trial cut");
  output.push([
    "      - name: Record bounded trial outcome and stop owned sampler",
    "        if: " + exp("always() && steps.trial_identity.outcome == 'success'"),
    "        env:",
    "          TRIAL_BUILD_OUTCOME: " + exp("steps.trial_build.outcome"),
    "          TRIAL_SUITE_OUTCOME: " + exp("steps.trial_suite.outcome"),
    "          TRIAL_JOB_STATUS: " + exp("job.status"),
    "        run: node scripts/ci/hosted-build-size-trial.mjs finish",
    "",
  ].join("\n"));
  const result = header + output.join("");
  require(!/\$\{\{[^}]*needs\./.test(result), "unadapted source dependency in " + workload);
  require(!/uses: actions\/(?:upload-artifact|download-artifact|cache)@/.test(result), "trial artifact/cache transfer forbidden");
  require(!/^\s+push:\s*true/m.test(result), "trial publication forbidden");
  require(!/LOCAL_BUILDX_CACHE_DIR|^\s+cache-(?:from|to):/m.test(result), "unadapted trial buildx cache state");
  require(result.includes("timeout-minutes: " + rule.cap), "source timeout changed");
  return "  # Source job SHA256: " + sourceDigest + "\n" + result;
}

export function renderWorkflow(sources) {
  return [
    "# Generated by scripts/ci/hosted-build-size-trial.mjs render.",
    "# Only manual, individually selected workloads. No routing variables are changed.",
    "name: hosted-build-size-trial",
    "run-name: hosted-build-size-trial / " + exp("inputs.cohort") + " / " + exp("inputs.workload"),
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      cohort:",
    "        type: choice",
    "        required: true",
    "        options: [standard, large]",
    "      workload:",
    "        type: choice",
    "        required: true",
    "        options: [design, dashboard, image]",
    "permissions:",
    "  contents: read",
    "concurrency:",
    "  group: hosted-build-size-trial-3316",
    "  cancel-in-progress: false",
    "env:",
    "  TRIAL_COHORT: " + exp("inputs.cohort"),
    "  TRIAL_WORKLOAD: " + exp("inputs.workload"),
    "  TRIAL_SOURCE_SHA: " + exp("github.sha"),
    "  TRIAL_ATTEMPT: " + exp("github.run_attempt"),
    "  TRIAL_RUN_ID: " + exp("github.run_id"),
    '  DOCKER_BUILD_RECORD_UPLOAD: "false"',
    "jobs:",
    ...Object.keys(CLASSES).map((name) => trialJob(name, sources[name])),
    "",
  ].join("\n").trimEnd() + "\n";
}

export function sourceFiles(root = ROOT) {
  return Object.fromEntries(Object.entries(CLASSES).map(([name, spec]) =>
    [name, fs.readFileSync(path.join(root, ".github/workflows", spec.file), "utf8")]));
}
export function verifyWorkflow(root = ROOT) {
  require(fs.readFileSync(path.join(root, WORKFLOW), "utf8") === renderWorkflow(sourceFiles(root)),
    "trial workload/source parity changed; regenerate and review before running");
}

export function identity(env, machine) {
  require(Object.hasOwn(CLASSES, env.TRIAL_WORKLOAD), "unknown workload");
  require(["standard", "large"].includes(env.TRIAL_COHORT), "unknown cohort");
  require(env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.TRIAL_ATTEMPT === "1", "trial requires first manual attempt");
  require(sha(env.TRIAL_SOURCE_SHA) && env.GITHUB_SHA === env.TRIAL_SOURCE_SHA, "source identity differs");
  require(/^[1-9][0-9]*$/.test(env.TRIAL_RUN_ID || ""), "run identity absent");
  require(env.TRIAL_RUNNER_ENVIRONMENT === "github-hosted", "only disposable GitHub-hosted runners are admitted");
  const large = env.TRIAL_COHORT === "large";
  require(machine.os === "ubuntu" && machine.version === "24.04" && machine.arch === "x64", "runner platform differs");
  require(machine.cpus === (large ? 8 : 4), "runner CPU class differs");
  require(machine.memoryMiB >= (large ? 28 : 14) * 1024 && machine.memoryMiB <= (large ? 36 : 18) * 1024, "runner memory class differs");
  return { version: 1, cohort: env.TRIAL_COHORT, workload: env.TRIAL_WORKLOAD,
    sourceSha: env.TRIAL_SOURCE_SHA, runId: Number(env.TRIAL_RUN_ID), attempt: 1, machine };
}
function machine() {
  const release = Object.fromEntries(fs.readFileSync("/etc/os-release", "utf8").split("\n")
    .filter((line) => line.includes("=")).map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, "")]; }));
  return { os: release.ID, version: release.VERSION_ID, arch: os.arch(), cpus: os.cpus().length,
    memoryMiB: Math.round(os.totalmem() / 1048576), runnerName: process.env.RUNNER_NAME || "unknown" };
}
function privateDir(env = process.env) {
  require(path.isAbsolute(env.RUNNER_TEMP || ""), "runner temporary directory absent");
  const folder = path.join(env.RUNNER_TEMP, "hosted-build-size-trial-" + env.TRIAL_RUN_ID);
  fs.mkdirSync(folder, { mode: 0o700 });
  return folder;
}
function readMemory() {
  const mem = fs.readFileSync("/proc/meminfo", "utf8");
  const number = (key) => Number(new RegExp("^" + key + ":\\s+(\\d+)", "m").exec(mem)?.[1]);
  const sample = { at: new Date().toISOString(), availableMiB: Math.floor(number("MemAvailable") / 1024),
    swapUsedMiB: Math.floor((number("SwapTotal") - number("SwapFree")) / 1024) };
  require(Number.isFinite(sample.availableMiB) && Number.isFinite(sample.swapUsedMiB), "memory observation unavailable");
  return sample;
}
async function sample(file, duration) {
  require(path.isAbsolute(file) && Number.isSafeInteger(duration) && duration > 0 && duration <= 4300, "invalid bounded sampler");
  const end = Date.now() + duration * 1000;
  while (Date.now() < end) {
    fs.appendFileSync(file, JSON.stringify(readMemory()) + "\n", { mode: 0o600 });
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, end - Date.now()))));
  }
}
function timestamp(value) {
  require(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value),
    "timestamp must be an exact UTC calendar time");
  const parsed = Date.parse(value);
  require(Number.isFinite(parsed) && new Date(parsed).toISOString() === value.replace(/(?<!\.\d{3})Z$/, ".000Z"),
    "timestamp must be an exact UTC calendar time");
  return parsed;
}
function apiTimestamp(value) {
  // GitHub documents job step timestamps with explicit UTC offsets as well as Z.
  require(typeof value === "string", "API timestamp missing");
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?)(Z|[+-]\d{2}:\d{2})$/.exec(value);
  require(parts, "API timestamp malformed");
  timestamp(parts[1] + "Z"); // Reject calendar normalization before offset parsing.
  if (parts[2] !== "Z") require(Number(parts[2].slice(1, 3)) <= 23 &&
    Number(parts[2].slice(4)) <= 59, "API timezone offset malformed");
  const parsed = Date.parse(value);
  require(Number.isFinite(parsed), "API timestamp invalid");
  return parsed;
}
export function summarizeSamples(text, startedAt, finishedAt) {
  const rows = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  require(rows.length > 0 && rows.every((row) => Number.isSafeInteger(row.availableMiB) && row.availableMiB >= 0 &&
    Number.isSafeInteger(row.swapUsedMiB) && row.swapUsedMiB >= 0), "memory sample inventory incomplete");
  const times = rows.map((row) => timestamp(row.at));
  const start = timestamp(startedAt), end = timestamp(finishedAt);
  require(end >= start && times.every((time, index) => time >= start - 1000 && time <= end &&
    (index === 0 || time >= times[index - 1])), "memory sample times differ");
  const largestGapMs = Math.max(times[0] - start, end - times.at(-1),
    ...times.slice(1).map((time, index) => time - times[index]));
  // A dead sampler must not turn one early observation into a full-run claim.
  require(largestGapMs <= 15000, "memory sample coverage incomplete");
  return { samples: rows.length, sampleStart: rows[0].at, sampleEnd: rows.at(-1).at,
    largestGapMs, complete: true,
    minimumAvailableMiB: Math.min(...rows.map((row) => row.availableMiB)),
    maximumSwapUsedMiB: Math.max(...rows.map((row) => row.swapUsedMiB)) };
}

export async function stopSampler(pid, file) {
  require(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && path.isAbsolute(file),
    "sampler identity invalid");
  const alive = () => {
    try {
      const command = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0");
      // A zombie has stopped executing and cannot append further observations.
      if (command.length === 1 && command[0] === "") {
        const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return false;
      }
      require(command[1] === CODE && command[2] === "sample" && command[3] === file,
        "sampler process identity differs");
      return true;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return false;
      throw error;
    }
  };
  if (!alive()) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (alive()) {
    require(Date.now() < deadline, "owned sampler did not stop");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function begin(env = process.env) {
  verifyWorkflow();
  const checked = identity(env, machine());
  const current = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 10000 });
  require(current.status === 0 && current.stdout.trim() === checked.sourceSha, "checkout differs from workflow source");
  const folder = privateDir(env);
  const file = path.join(folder, "memory.jsonl");
  fs.writeFileSync(file, JSON.stringify(readMemory()) + "\n", { mode: 0o600 });
  const child = spawn(process.execPath, [CODE, "sample", file, String(CLASSES[checked.workload].cap * 60 + 60)],
    { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(path.join(folder, "identity.json"), JSON.stringify({ ...checked, startedAt: new Date().toISOString(), samplerPid: child.pid }), { mode: 0o600 });
  console.log("HOSTED_BUILD_TRIAL_IDENTITY " + JSON.stringify(checked));
}
export async function finish(env = process.env) {
  require(/^[1-9][0-9]*$/.test(env.TRIAL_RUN_ID || ""), "run identity absent");
  const folder = path.join(env.RUNNER_TEMP, "hosted-build-size-trial-" + env.TRIAL_RUN_ID);
  const saved = JSON.parse(fs.readFileSync(path.join(folder, "identity.json"), "utf8"));
  require(saved.sourceSha === env.TRIAL_SOURCE_SHA && saved.runId === Number(env.TRIAL_RUN_ID) && saved.workload === env.TRIAL_WORKLOAD && saved.cohort === env.TRIAL_COHORT, "saved trial identity differs");
  const file = path.join(folder, "memory.jsonl");
  await stopSampler(saved.samplerPid, file);
  const finishedAt = new Date().toISOString();
  const memory = summarizeSamples(fs.readFileSync(file, "utf8"), saved.startedAt, finishedAt);
  const row = { ...saved, samplerPid: undefined, finishedAt, memory, samplerStopped: true,
    build: env.TRIAL_BUILD_OUTCOME, suite: env.TRIAL_SUITE_OUTCOME, job: env.TRIAL_JOB_STATUS };
  require(["success", "failure", "cancelled", "skipped"].includes(row.build) && ["success", "failure", "cancelled", "skipped"].includes(row.suite), "step outcomes absent");
  console.log("HOSTED_BUILD_TRIAL_RESULT " + JSON.stringify(row));
  // A missing final record after VM termination is UNKNOWN, not zero usage.
  return row;
}


export function trialComparison(records, expectedHead, expectedGroupId) {
  require(sha(expectedHead) && Number.isSafeInteger(expectedGroupId) && expectedGroupId > 0, "comparison binding absent");
  require(Array.isArray(records) && records.length === 6, "comparison requires six complete direct run inventories");
  const seen = new Set(), runIds = new Set(), jobIds = new Set(), rows = [];
  for (const { run, jobs, log } of records) {
    require(run && run.status === "completed" && run.event === "workflow_dispatch" && run.run_attempt === 1 &&
      run.head_sha === expectedHead && run.path === WORKFLOW && Number.isSafeInteger(run.id) && run.id > 0, "run binding differs");
    require(!runIds.has(run.id), "duplicate run"); runIds.add(run.id);
    const title = /^hosted-build-size-trial \/ (standard|large) \/ (design|dashboard|image)$/.exec(run.display_title || "");
    require(title, "run selection is not explicit");
    const [, cohort, workload] = title, key = cohort + "/" + workload;
    require(!seen.has(key), "duplicate cohort workload"); seen.add(key);
    require(jobs && jobs.total_count === 3 && Array.isArray(jobs.jobs) && jobs.jobs.length === 3, "job inventory incomplete");
    const names = new Set();
    let active;
    for (const job of jobs.jobs) {
      require(Number.isSafeInteger(job.id) && job.id > 0 && !jobIds.has(job.id), "duplicate or invalid job identity"); jobIds.add(job.id);
      require(job.run_id === run.id && (job.run_attempt === undefined || job.run_attempt === 1) && job.head_sha === expectedHead && job.status === "completed", "job binding differs");
      const name = /^trial \/ (design|dashboard|image) \/ (standard|large)$/.exec(job.name || "");
      require(name && name[2] === cohort && !names.has(name[1]), "job family differs"); names.add(name[1]);
      if (name[1] === workload) active = job;
      else require(job.conclusion === "skipped", "unselected workload ran");
    }
    require(active && ["success", "failure", "cancelled", "timed_out"].includes(active.conclusion), "requested workload did not execute");
    if (cohort === "large") require(active.runner_group_id === expectedGroupId, "paid job used a different runner group");
    require(typeof log === "string" && log.length > 0, "job logs unavailable");
    const admitted = [...log.matchAll(/HOSTED_BUILD_TRIAL_IDENTITY (\{[^\r\n]*\})/g)];
    require(admitted.length === 1, "owned job lacks one valid initial trial identity");
    const initial = JSON.parse(admitted[0][1]);
    require(initial.version === 1 && initial.runId === run.id && initial.sourceSha === expectedHead &&
      initial.attempt === 1 && initial.workload === workload && initial.cohort === cohort,
      "initial trial identity binding differs");
    identity({ TRIAL_WORKLOAD: workload, TRIAL_COHORT: cohort, GITHUB_EVENT_NAME: "workflow_dispatch",
      TRIAL_ATTEMPT: "1", TRIAL_SOURCE_SHA: expectedHead, GITHUB_SHA: expectedHead, TRIAL_RUN_ID: String(run.id),
      TRIAL_RUNNER_ENVIRONMENT: "github-hosted" }, initial.machine);
    const found = [...log.matchAll(/HOSTED_BUILD_TRIAL_RESULT (\{[^\r\n]*\})/g)];
    require(found.length <= 1, "duplicate terminal trial receipt");
    const terminal = found.length ? JSON.parse(found[0][1]) : null;
    if (terminal) {
      require(terminal.version === 1 && terminal.runId === run.id && terminal.sourceSha === expectedHead &&
        terminal.attempt === 1 && terminal.workload === workload && terminal.cohort === cohort && terminal.samplerStopped === true,
        "terminal trial receipt binding differs");
      require(JSON.stringify(terminal.machine) === JSON.stringify(initial.machine), "runner identity changed during job");
      identity({ TRIAL_WORKLOAD: workload, TRIAL_COHORT: cohort, GITHUB_EVENT_NAME: "workflow_dispatch",
        TRIAL_ATTEMPT: "1", TRIAL_SOURCE_SHA: expectedHead, GITHUB_SHA: expectedHead, TRIAL_RUN_ID: String(run.id),
        TRIAL_RUNNER_ENVIRONMENT: "github-hosted" }, terminal.machine);
      require(terminal.memory && Number.isSafeInteger(terminal.memory.samples) && terminal.memory.samples > 0 &&
        Number.isSafeInteger(terminal.memory.minimumAvailableMiB) && terminal.memory.minimumAvailableMiB >= 0 &&
        Number.isSafeInteger(terminal.memory.maximumSwapUsedMiB) && terminal.memory.maximumSwapUsedMiB >= 0 &&
        terminal.memory.complete === true && Number.isFinite(terminal.memory.largestGapMs) &&
        terminal.memory.largestGapMs >= 0 && terminal.memory.largestGapMs <= 15000, "terminal memory inventory malformed");
      require(timestamp(terminal.memory.sampleStart) <= timestamp(terminal.memory.sampleEnd) &&
        timestamp(terminal.startedAt) <= timestamp(terminal.finishedAt), "terminal observation times differ");
    }
    if (active.conclusion === "success") require(terminal && terminal.build === "success" && terminal.suite === "success", "green job lacks full workload receipt");
    const duration = (apiTimestamp(active.completed_at) - apiTimestamp(active.started_at)) / 1000;
    require(Number.isFinite(duration) && duration >= 0, "job duration invalid");
    require(Array.isArray(active.steps), "job step inventory absent");
    const builds = active.steps.filter((step) => step.name === CLASSES[workload].build);
    const suites = active.steps.filter((step) => step.name === CLASSES[workload].suite);
    require(builds.length <= 1 && suites.length <= 1, "duplicate workload step");
    const build = builds[0];
    if (active.conclusion === "success") require(build?.conclusion === "success" &&
      suites[0]?.conclusion === "success", "green API job lacks full workload steps");
    const buildSeconds = build && build.started_at && build.completed_at ?
      (apiTimestamp(build.completed_at) - apiTimestamp(build.started_at)) / 1000 : null;
    require(buildSeconds === null || buildSeconds >= 0, "build duration invalid");
    rows.push({ cohort, workload, runId: run.id, jobId: active.id, head: expectedHead,
      conclusion: active.conclusion, jobSeconds: duration, buildSeconds, buildConclusion: build?.conclusion || "not_reached",
      shutdownSignature: log.includes("The runner has received a shutdown signal"),
      memory: terminal?.memory || null, measurement: terminal ? "recorded" : log.includes("The runner has received a shutdown signal") ? "unknown-after-shutdown" : "unknown-missing-terminal" });
  }
  require(seen.size === 6, "cohort inventory incomplete");
  return { version: 1, head: expectedHead, observationsPerWorkload: 1, rows,
    cohorts: ["standard", "large"].map((cohort) => {
      const selected = rows.filter((row) => row.cohort === cohort);
      return { cohort, jobs: selected.length, jobSeconds: selected.reduce((sum, row) => sum + row.jobSeconds, 0), successful: selected.filter((row) => row.conclusion === "success").length,
        shutdownSignatures: selected.filter((row) => row.shutdownSignature).length,
        unknownMeasurements: selected.filter((row) => row.memory === null).length };
    }),
    limitation: "One observation per workload. Shutdown signatures do not establish an external reclaim or a statistically lower failure rate." };
}

async function limitedText(response, limit) {
  require(response.ok, "GitHub read failed: HTTP " + response.status);
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      require(length <= limit, "GitHub response exceeds bounded inventory size");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}
export async function collectComparison({ repository, runIds, head, groupId, token, fetcher = fetch }) {
  require(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || ""), "repository binding absent");
  require(Array.isArray(runIds) && runIds.length === 6 && new Set(runIds).size === 6 &&
    runIds.every((id) => Number.isSafeInteger(id) && id > 0), "six distinct run ids required");
  require(sha(head) && Number.isSafeInteger(groupId) && groupId > 0 && token, "read credentials or comparison binding absent");
  const end = Date.now() + 180000, records = [];
  async function read(route, log = false) {
    const remaining = end - Date.now();
    require(remaining > 0, "comparison read deadline exceeded");
    const response = await fetcher("https://api.github.com/repos/" + repository + route, {
      method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION },
      signal: AbortSignal.timeout(Math.min(20000, remaining)),
    });
    const text = await limitedText(response, log ? 20 * 1024 * 1024 : 2 * 1024 * 1024);
    return log ? text : JSON.parse(text);
  }
  for (const id of runIds) {
    const run = await read("/actions/runs/" + id);
    require(run.repository?.full_name === repository, "run repository differs");
    const jobs = await read("/actions/runs/" + id + "/attempts/1/jobs?per_page=100");
    require(jobs.total_count === 3 && jobs.jobs?.length === 3, "job inventory incomplete");
    const selected = jobs.jobs.filter((job) => job.conclusion !== "skipped");
    require(selected.length === 1, "expected exactly one executed workload per run");
    const log = await read("/actions/jobs/" + selected[0].id + "/logs", true);
    const after = await read("/actions/runs/" + id);
    require(after.id === run.id && after.head_sha === run.head_sha && after.run_attempt === run.run_attempt &&
      after.status === "completed" && after.conclusion === run.conclusion && after.updated_at === run.updated_at,
      "run changed during inventory");
    records.push({ run, jobs, log });
  }
  return trialComparison(records, head, groupId);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "render") { require(args.length === 0, "render accepts no arguments"); process.stdout.write(renderWorkflow(sourceFiles())); }
  else if (command === "verify") { require(args.length === 0, "verify accepts no arguments"); verifyWorkflow(); }
  else if (command === "begin") { require(args.length === 0, "begin accepts no arguments"); begin(); }
  else if (command === "finish") { require(args.length === 0, "finish accepts no arguments"); await finish(); }
  else if (command === "report") {
    require(args.length === 4, "report expects repository, head, group id and six comma-separated run ids");
    const result = await collectComparison({ repository: args[0], head: args[1], groupId: Number(args[2]),
      runIds: args[3].split(",").map(Number), token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
  else if (command === "sample") { require(args.length === 2, "sampler arguments differ"); await sample(args[0], Number(args[1])); }
  else throw new Error("usage: hosted-build-size-trial.mjs render|verify|begin|finish|report");
}
if (process.argv[1] && path.resolve(process.argv[1]) === CODE) main().catch((error) => {
  console.error("hosted-build-size-trial: " + error.message); process.exitCode = 1;
});
