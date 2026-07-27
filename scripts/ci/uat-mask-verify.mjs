#!/usr/bin/env node
/**
 * Assert that the WP/Drupal UAT jobs render their per-run minted values MASKED
 * in THIS run's public job log (cinatra#2131).
 *
 * WHAT THIS GUARDS
 * ----------------
 * The four values the UAT jobs mint per run (BETTER_AUTH_SECRET,
 * NANGO_ENCRYPTION_KEY, CINATRA_BRIDGE_TOKEN, CINATRA_CONTEXT_ATTEST_KEY) are
 * written to $GITHUB_ENV, which makes them part of the JOB env — and the runner
 * prints the whole job env in the `##[group]Run …` header of every subsequent
 * step. A derivation step therefore does not have to echo anything for its
 * output to be rendered in the job log, and this repository's job logs are
 * public. Registering each value with the runner's log masker at mint time is
 * what keeps them out; this job is the assertion that it worked.
 *
 * WHY THIS CHECK IS STRUCTURAL, NOT A VALUE GREP
 * ----------------------------------------------
 * An exact-value grep of a job's own log is impossible from inside that job:
 * the log blob is only published when the job COMPLETES (the API answers
 * `BlobNotFound` for an in-progress job), and the values cannot be handed to a
 * later job either — masked values are redacted out of job outputs, which is
 * the masking working as intended. So this runs as a SEPARATE job that reads
 * the finished log of the UAT job in the same run and checks the leak site
 * directly: every rendering of those four env keys must show `***`.
 *
 * That is strictly narrower than "the value appears nowhere", so it is paired
 * with the in-job `uat-diagnostics.sh scan` step, which greps the actual
 * in-memory values across everything staged for artifact upload. Together they
 * cover the log surface and the durable surface; neither alone would.
 *
 * This script prints key names, counts and line numbers ONLY. It never prints a
 * captured value, and it writes nothing to disk.
 */
import process from "node:process";

const TARGET_JOBS = new Set(["uat-gate", "nightly"]);
const MINTED_KEYS = [
  "BETTER_AUTH_SECRET",
  "NANGO_ENCRYPTION_KEY",
  "CINATRA_BRIDGE_TOKEN",
  "CINATRA_CONTEXT_ATTEST_KEY",
];
// Echoed by the "Assert app-service env present" step, which runs ONLY on the
// real-run path and only after all four values have been minted. Its presence
// is the positive control: it means the job did reach the state where the env
// dump must contain all four keys, so zero occurrences would mean this check is
// reading the wrong thing rather than that nothing leaked.
const REAL_RUN_MARKER = "app-service env present";
const MASKED = "***";

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const attempt = process.env.GITHUB_RUN_ATTEMPT || "1";

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

if (!token) fail("no GitHub token available — cannot read this run's job log.");
if (!repo || !runId) fail("GITHUB_REPOSITORY / GITHUB_RUN_ID are not set.");

const api = async (path, { raw = false } = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: raw ? "*/*" : "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "cinatra-uat-mask-verify",
    },
  });
  if (!res.ok) {
    const err = new Error(`GitHub API ${res.status} for ${path}`);
    err.status = res.status;
    throw err;
  }
  return raw ? res.text() : res.json();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The log blob lands a moment after the job reports completion, so a first 404
 * is expected rather than fatal.
 */
async function fetchJobLog(jobId) {
  let lastStatus = 0;
  for (let attemptNo = 1; attemptNo <= 6; attemptNo += 1) {
    try {
      return await api(`/repos/${repo}/actions/jobs/${jobId}/logs`, { raw: true });
    } catch (error) {
      lastStatus = error.status ?? 0;
      if (lastStatus && lastStatus !== 404 && lastStatus !== 410) throw error;
      await sleep(5000);
    }
  }
  throw new Error(`job ${jobId} log never became readable (last status ${lastStatus})`);
}

/** Count masked vs unmasked renderings of `KEY: <value>` in a job log. */
function inspectKey(log, key) {
  const re = new RegExp(String.raw`^\S+\s+${key}: (.*)$`, "gm");
  const unmaskedLines = [];
  let occurrences = 0;
  let match;
  while ((match = re.exec(log)) !== null) {
    occurrences += 1;
    if (match[1].replace(/\r$/, "").trim() !== MASKED) {
      // LINE NUMBER ONLY — printing the captured text would republish the leak.
      unmaskedLines.push(log.slice(0, match.index).split("\n").length);
    }
  }
  return { occurrences, unmaskedLines };
}

const jobs = [];
for (let page = 1; page <= 5; page += 1) {
  const body = await api(
    `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
  );
  jobs.push(...body.jobs);
  if (body.jobs.length < 100) break;
}

// A SKIPPED job also reports `status: "completed"` (with `conclusion:
// "skipped"`) and has no log blob at all — the `uat-gate` job is skipped on
// every schedule/dispatch run and `nightly` on every pull_request run, so
// filtering on status alone would chase a log that never appears.
const RAN_CONCLUSIONS = new Set(["success", "failure", "timed_out"]);
const targets = jobs.filter(
  (job) => TARGET_JOBS.has(job.name) && job.status === "completed" && RAN_CONCLUSIONS.has(job.conclusion),
);
if (targets.length === 0) {
  console.log("no completed UAT job in this run — nothing to verify.");
  process.exit(0);
}

let failed = false;
for (const job of targets) {
  let log;
  try {
    log = await fetchJobLog(job.id);
  } catch (error) {
    fail(`could not read the ${job.name} job log: ${error.message}`);
  }
  const realRun = log.includes(REAL_RUN_MARKER);
  let total = 0;
  const report = [];
  for (const key of MINTED_KEYS) {
    const { occurrences, unmaskedLines } = inspectKey(log, key);
    total += occurrences;
    report.push(`  ${key}: renderings=${occurrences} unmasked=${unmaskedLines.length}`);
    if (unmaskedLines.length > 0) {
      failed = true;
      console.log(
        `::error::${job.name}: ${key} rendered UNMASKED ${unmaskedLines.length} time(s) in the public job log (log lines ${unmaskedLines.join(", ")}).`,
      );
    }
    if (realRun && occurrences === 0) {
      failed = true;
      console.log(
        `::error::${job.name}: reached the real-run path but ${key} never appears in the job env dump — this check can no longer confirm masking and must not report green.`,
      );
    }
  }
  console.log(`job=${job.name} real_run=${realRun} minted_value_renderings=${total}`);
  console.log(report.join("\n"));
  if (!realRun) {
    console.log(`  (fast-pass job — no values were minted, so there is nothing to mask)`);
  }
}

if (failed) process.exit(1);
console.log("OK: every rendering of a per-run minted value in this run's public job log is masked.");
