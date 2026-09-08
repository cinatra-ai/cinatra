#!/usr/bin/env node
// Hosted-runner reclaim — one guarded automatic re-run (cinatra#3316, items 1
// and 2).
//
// WHY: GitHub's hosted runners occasionally take the machine away in the
// middle of a production build. The job's build step is then reported as
// `cancelled`, the job concludes `failure`, and the log carries the literal
// line "The runner has received a shutdown signal". Nothing about the change
// under test caused it, and a manual re-run of that ONE job passes the build.
// Until then a green pull request sits red waiting for a person to notice.
//
// WHAT THIS DOES: on the completion of one of the three build-carrying
// workflows, it re-runs EXACTLY ONE job through the job-specific re-run
// endpoint, and only when every guard below holds. It never calls the
// run-level re-run-all-failed-jobs endpoint, never re-runs a second attempt,
// and writes nothing anywhere except its own step summary.
//
// THE GUARDS (all of them, in this order — the first that does not hold ends
// the run with a reason code and no re-run):
//   1. the run belongs to THIS repository;
//   2. the run's event is `pull_request`;
//   3. the run's conclusion is `failure` — not cancelled, not timed out, not
//      success;
//   4. `run_attempt` reads 1 on a FRESH read of the run (attempt 2 fires the
//      watcher again; this is what stops it);
//   5. the run carries a pull request (a fork run carries none);
//   6. the run's head is still the pull request's CURRENT head (fresh read);
//   7. exactly ONE job failed, and it is on the allowlist below (workflow name
//      plus job name);
//   8. that job's own build step — by its exact name — concluded `cancelled`,
//      and every step before it is green;
//   9. the job's log carries the exact reclaim marker.
//
// STATED RISK (from the issue): a log-line classification can coincide with a
// genuine failure in the same job. Guards 7-9 narrow it — the failure must be
// the build step, cancelled, with nothing broken before it — and a second
// attempt is NEVER excused: if the re-run fails, the pull request stays red.
//
// A step that was SKIPPED before the build step counts as green. This is not
// laxity: all three jobs carry conditional pre-build steps that skip on the
// normal path (dashboard-live-verify's "Skip stub (no dashboard-surface
// changes)" skips precisely WHEN the real build runs, and the swap steps skip
// whenever CI_BUILD_RUNNER moves the job to a larger runner). Requiring a
// literal `success` from every earlier step would mean this watcher could
// never fire. A `failure`, `cancelled` or `timed_out` earlier step still
// refuses the re-run.
//
// Pre-install-safe: node builtins only. The decision is a PURE function so
// every guard is unit-testable — see
// scripts/ci/__tests__/hosted-reclaim-rerun.test.mjs. The watcher itself can
// only run from the default branch (that is how `workflow_run` works), so the
// unit tier is the acceptance surface until it is merged.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The only repository this watcher will ever act on. */
export const REPOSITORY = "cinatra-ai/cinatra";

/** The literal line the runner writes when it reclaims the machine. */
export const RECLAIM_MARKER = "The runner has received a shutdown signal";

/** The single reason a re-run is ever issued. */
export const RERUN_REASON = "hosted-runner-reclaim";

// The three build-carrying jobs, grounded against the live workflow files.
// Each carries its OWN build-step name — they are three different strings, and
// matching one guessed string against all three would silently never fire for
// two of them. `Build and publish image`'s `image` job declares no job-level
// `name:`, so GitHub displays it as the job id itself.
export const ALLOWLIST = Object.freeze([
  Object.freeze({
    workflow: "design-visual-verify",
    job: "/design-fixtures pixel-diff + axe",
    buildStep: "Build (standalone production server)",
  }),
  Object.freeze({
    workflow: "dashboard-live-verify",
    job: "/agents Playwright smoke",
    buildStep: "Build app (production)",
  }),
  Object.freeze({
    workflow: "Build and publish image",
    job: "image",
    buildStep: "Build image (load for prod-boot e2e)",
  }),
]);

/** The closed set of reasons a re-run is refused. */
export const SKIP_REASONS = Object.freeze({
  NOT_THIS_REPOSITORY: "not-this-repository",
  NOT_A_PULL_REQUEST_EVENT: "not-a-pull-request-event",
  RUN_CANCELLED: "run-cancelled",
  RUN_TIMED_OUT: "run-timed-out",
  RUN_NOT_FAILURE: "run-not-failure",
  SECOND_ATTEMPT: "second-attempt",
  NO_PULL_REQUEST_ATTACHED: "no-pull-request-attached",
  PULL_HEAD_UNREADABLE: "pull-head-unreadable",
  HEAD_MOVED: "head-moved",
  NO_FAILED_JOB: "no-failed-job",
  MULTIPLE_FAILED_JOBS: "multiple-failed-jobs",
  JOB_NOT_ALLOWLISTED: "job-not-allowlisted",
  BUILD_STEP_MISSING: "build-step-missing",
  BUILD_STEP_NOT_CANCELLED: "build-step-not-cancelled",
  EARLIER_STEP_NOT_GREEN: "earlier-step-not-green",
  MARKER_ABSENT: "marker-absent",
});

const EARLIER_STEP_OK = new Set(["success", "skipped"]);
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The whole decision, as a pure function.
 *
 * @param {object} input
 * @param {object} input.run          a FRESH read of the triggering run.
 * @param {object[]} input.jobs       the run's jobs (`?filter=latest`).
 * @param {Record<string, string>} input.logByJobId  job id -> job log text.
 * @param {string|null} input.pullHead the pull request's CURRENT head sha.
 * @param {object[]} [input.allowlist]
 * @param {string} [input.repository]
 * @returns {{rerun: number, reason: string, workflow: string, job: string, step: string}
 *          | {skip: true, reason: string, detail: string}}
 */
export function decide({
  run,
  jobs,
  logByJobId,
  pullHead,
  allowlist = ALLOWLIST,
  repository = REPOSITORY,
}) {
  const skip = (reason, detail) => ({ skip: true, reason, detail });

  // 1. This repository, and no other.
  const fullName = run && run.repository ? run.repository.full_name : undefined;
  if (fullName !== repository) {
    return skip(
      SKIP_REASONS.NOT_THIS_REPOSITORY,
      `the run belongs to ${fullName ?? "an unreadable repository"}, not ${repository}`,
    );
  }

  // 2. A pull request run. Push and merge_group runs share heads with open
  //    pull requests, so this is checked on its own and not inferred.
  if (run.event !== "pull_request") {
    return skip(
      SKIP_REASONS.NOT_A_PULL_REQUEST_EVENT,
      `the run's event is ${run.event ?? "unreadable"}`,
    );
  }

  // 3. Failure, and only failure.
  if (run.conclusion === "cancelled") {
    return skip(SKIP_REASONS.RUN_CANCELLED, "the run was cancelled");
  }
  if (run.conclusion === "timed_out") {
    return skip(SKIP_REASONS.RUN_TIMED_OUT, "the run timed out");
  }
  if (run.conclusion !== "failure") {
    return skip(
      SKIP_REASONS.RUN_NOT_FAILURE,
      `the run concluded ${run.conclusion ?? "unreadable"}`,
    );
  }

  // 4. First attempt only. This is what makes the re-run happen at most once.
  if (run.run_attempt !== 1) {
    return skip(
      SKIP_REASONS.SECOND_ATTEMPT,
      `run_attempt reads ${run.run_attempt} on a fresh read — a second attempt is never excused`,
    );
  }

  // 5. A pull request must be attached (a fork run carries none).
  const pulls = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  if (pulls.length === 0) {
    return skip(
      SKIP_REASONS.NO_PULL_REQUEST_ATTACHED,
      "the run carries no pull request (a fork run, or a run outside the pull-request flow)",
    );
  }

  // 6. The head must still be the pull request's current head.
  if (typeof pullHead !== "string" || !SHA_RE.test(pullHead)) {
    return skip(
      SKIP_REASONS.PULL_HEAD_UNREADABLE,
      "the pull request's current head could not be read — refusing rather than guessing",
    );
  }
  if (run.head_sha !== pullHead) {
    return skip(
      SKIP_REASONS.HEAD_MOVED,
      `the run tested ${run.head_sha} but the pull request now points at ${pullHead}`,
    );
  }

  // 7. Exactly one failed job, and it is allowlisted.
  const all = Array.isArray(jobs) ? jobs : [];
  const failed = all.filter((j) => j && j.conclusion === "failure");
  if (failed.length === 0) {
    return skip(SKIP_REASONS.NO_FAILED_JOB, "no job in the run concluded failure");
  }
  if (failed.length > 1) {
    return skip(
      SKIP_REASONS.MULTIPLE_FAILED_JOBS,
      `${failed.length} jobs failed (${failed.map((j) => j.name).join(", ")}) — a reclaim takes one job, not several`,
    );
  }
  const job = failed[0];
  const entry = allowlist.find(
    (e) => e.workflow === run.name && e.job === job.name,
  );
  if (!entry) {
    return skip(
      SKIP_REASONS.JOB_NOT_ALLOWLISTED,
      `${run.name ?? "an unnamed workflow"} / ${job.name ?? "an unnamed job"} is not a build-carrying job this watcher may re-run`,
    );
  }

  // 8. The build step is the cancelled one, and nothing broke before it.
  const steps = [...(Array.isArray(job.steps) ? job.steps : [])].sort(
    (a, b) => (a.number ?? 0) - (b.number ?? 0),
  );
  const at = steps.findIndex((s) => s.name === entry.buildStep);
  if (at === -1) {
    return skip(
      SKIP_REASONS.BUILD_STEP_MISSING,
      `the job ran no step named '${entry.buildStep}' — the workflow changed and this allowlist is stale`,
    );
  }
  if (steps[at].conclusion !== "cancelled") {
    return skip(
      SKIP_REASONS.BUILD_STEP_NOT_CANCELLED,
      `'${entry.buildStep}' concluded ${steps[at].conclusion ?? "unreadable"} — the job failed on its own merits`,
    );
  }
  const broken = steps
    .slice(0, at)
    .find((s) => !EARLIER_STEP_OK.has(s.conclusion));
  if (broken) {
    return skip(
      SKIP_REASONS.EARLIER_STEP_NOT_GREEN,
      `'${broken.name}' concluded ${broken.conclusion ?? "unreadable"} before the build step`,
    );
  }

  // 9. The reclaim marker, verbatim, in that job's own log.
  const logs = logByJobId ?? {};
  const log = logs[job.id];
  if (typeof log !== "string" || !log.includes(RECLAIM_MARKER)) {
    return skip(
      SKIP_REASONS.MARKER_ABSENT,
      "the job log does not carry the reclaim marker",
    );
  }

  return {
    rerun: job.id,
    reason: RERUN_REASON,
    workflow: entry.workflow,
    job: entry.job,
    step: entry.buildStep,
  };
}

// ---------------------------------------------------------------------------
// The thin runner. Reads the event, performs the fresh reads, calls decide,
// and records the outcome in this run's OWN step summary. It posts nothing on
// the pull request and opens nothing.
// ---------------------------------------------------------------------------

const API = process.env.GITHUB_API_URL || "https://api.github.com";

const headers = (token) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
  "user-agent": "cinatra-hosted-reclaim-rerun",
});

async function readJson(url, token) {
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

/**
 * The job-log endpoint answers with a redirect to a SIGNED storage URL. The
 * signed URL must be fetched WITHOUT the API authorization header (storage
 * rejects two authentication mechanisms), so the redirect is followed by hand.
 * An unreadable log is an empty string: the marker guard then refuses.
 */
export async function readJobLog(url, token, doFetch = fetch) {
  const res = await doFetch(url, { headers: headers(token), redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) return "";
    const signed = await doFetch(location);
    return signed.ok ? signed.text() : "";
  }
  return res.ok ? res.text() : "";
}

function record(lines) {
  const text = `${lines.join("\n")}\n`;
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, text);
  process.stdout.write(text);
}

export async function run() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is not set");

  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const trigger = event.workflow_run;
  if (!trigger) throw new Error("the event payload carries no workflow_run");

  // Guard 1 before ANY request: never build a URL out of a foreign repository.
  const triggerRepo = trigger.repository ? trigger.repository.full_name : undefined;
  if (triggerRepo !== REPOSITORY) {
    record([
      "## Hosted-runner reclaim: no re-run",
      "",
      `- decision: \`${SKIP_REASONS.NOT_THIS_REPOSITORY}\``,
      `- detail: the triggering run belongs to ${triggerRepo ?? "an unreadable repository"}`,
    ]);
    return;
  }
  const runId = Number(trigger.id);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error(`the event payload carries an unusable run id: ${trigger.id}`);
  }

  const base = `${API}/repos/${REPOSITORY}`;
  // FRESH reads: run_attempt and the conclusion may both have moved on since
  // the event was queued.
  const runNow = await readJson(`${base}/actions/runs/${runId}`, token);
  const jobs =
    (await readJson(`${base}/actions/runs/${runId}/jobs?filter=latest&per_page=100`, token))
      .jobs ?? [];

  let pullHead = null;
  const pulls = Array.isArray(runNow.pull_requests) ? runNow.pull_requests : [];
  const number = pulls.length > 0 ? Number(pulls[0].number) : NaN;
  if (Number.isSafeInteger(number) && number > 0) {
    try {
      const pull = await readJson(`${base}/pulls/${number}`, token);
      pullHead = pull && pull.head ? pull.head.sha : null;
    } catch {
      pullHead = null;
    }
  }

  // Fetch the log for the ONE candidate job only — never for the whole run.
  const logByJobId = {};
  const failed = jobs.filter((j) => j && j.conclusion === "failure");
  if (failed.length === 1) {
    const candidate = failed[0];
    const allowlisted = ALLOWLIST.some(
      (e) => e.workflow === runNow.name && e.job === candidate.name,
    );
    if (allowlisted) {
      logByJobId[candidate.id] = await readJobLog(
        `${base}/actions/jobs/${candidate.id}/logs`,
        token,
      );
    }
  }

  const outcome = decide({ run: runNow, jobs, logByJobId, pullHead });
  const runUrl =
    runNow.html_url ||
    `https://github.com/${REPOSITORY}/actions/runs/${runId}`;

  if (outcome.skip) {
    record([
      "## Hosted-runner reclaim: no re-run",
      "",
      `- decision: \`${outcome.reason}\``,
      `- detail: ${outcome.detail}`,
      `- source run: ${runUrl}`,
    ]);
    return;
  }

  const res = await fetch(`${base}/actions/jobs/${outcome.rerun}/rerun`, {
    method: "POST",
    headers: { ...headers(token), "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `POST ${base}/actions/jobs/${outcome.rerun}/rerun -> ${res.status} ${body.slice(0, 400)}`,
    );
  }

  record([
    "## Hosted-runner reclaim: one job re-run",
    "",
    `- job: \`${outcome.job}\` (${outcome.workflow})`,
    `- reason: \`${outcome.reason}\` — '${outcome.step}' concluded cancelled with the reclaim marker in its log, every earlier step green`,
    `- source run: ${runUrl}`,
    "",
    "Only this one job was re-run, and only once: attempt 2 fires this watcher again and the attempt guard stops it. If the second attempt fails, the pull request stays red.",
  ]);
}

const invoked =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  run().catch((error) => {
    // Fail VISIBLY: a watcher that cannot evaluate its own inputs must never
    // read as "nothing to do".
    console.error(`::error::hosted-reclaim-rerun: ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
}
