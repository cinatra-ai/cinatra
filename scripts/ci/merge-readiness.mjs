// merge-readiness — the stable required context `merge-readiness / merge-readiness`.
//
// engineering#658 item 3. Reviewer's merge-queue recommendation of 2026-09-09.
//
// WHAT IT DOES
//   Approval stays bound to the pull request's head. CI is judged on the
//   EVENT'S CANDIDATE SHA: `github.sha` for the pull-request test merge,
//   `merge_group.head_sha` for the queue candidate. The CHECK RUNS of that
//   candidate are read from the sha that carries them — the pull request's
//   head on `pull_request` (the test merge commit carries none), the queue's
//   own commit on `merge_group` — which the workflow passes in explicitly.
//   The job reads the
//   versioned inventory `.github/merge-readiness.json`, selects the expected
//   contexts whose path applicability matches the candidate's changed paths,
//   EXCLUDES ITSELF, and waits for every selected context to exist and
//   conclude `success`.
//
//   It fails on missing, failed, cancelled, duplicate-source or timed-out
//   checks. The single exception is a `skipped` conclusion on a context the
//   inventory marks `skippable` (a job under an `if:` guard, which GitHub
//   reports as skipped and branch protection counts as satisfied). A check-run name that is NOT in the inventory is REPORTED and
//   otherwise ignored: an unknown check never joins the wait set, so the job
//   can never wait on itself (a self-dependency would deadlock the queue).
//
//   On the `merge_group` event it additionally revalidates
//     - the approved head (the queue candidate must descend from the exact
//       head the approval was given on: a moved head fails), and
//     - the verification-boundary predicate (the LAST boundary record for the
//       head is `candidate` or `promoted`).
//
//   Its wait is bounded by the LONGEST JOB BUDGET of the workflows it
//   evaluates — each expected entry carries the `timeout-minutes` of the job
//   that reports it — plus WAIT_MARGIN_MINUTES, capped at MAX_WAIT_MINUTES so
//   the job still reports before the queue's 120-minute
//   `check_response_timeout_minutes`. Reaching that bound is NOT a verdict on
//   the candidate: a required run still `queued` or `in_progress` when the
//   wait runs out is reported PENDING (cinatra#3391) — a distinct, named
//   outcome with its own exit code, so a re-run picks up where it left off
//   instead of a loaded runner turning a green candidate red.
//
// FAIL CLOSED everywhere: an unparseable inventory, an unknown event, a
// missing payload field or an unreadable record is a FAILURE, never a skip.
//
// Pure core (exported, unit-tested on fixtures in
// scripts/ci/__tests__/merge-readiness.test.mjs); the CLI at the bottom is the
// only part that talks to the GitHub API.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The FALLBACK wall-clock budget, in minutes, used when no expected context
 * applies to the candidate and there is therefore no job budget to follow.
 * MUST stay below the queue's `check_response_timeout_minutes` (120,
 * engineering#658 item 5) so this job reports first. Asserted by the unit tests.
 */
export const DEADLINE_MINUTES = 90;

/** The queue's own timeout this deadline must stay under (item 5). */
export const QUEUE_TIMEOUT_MINUTES = 120;

/** The margin added on top of the longest job budget the wait follows. */
export const WAIT_MARGIN_MINUTES = 10;

/**
 * The upper bound the wait may reach: the evaluator's own job budget in
 * .github/workflows/merge-readiness-reusable.yml (115) less the job's setup
 * phase, and short of the queue's check_response_timeout_minutes, so the job
 * always reports before either ceiling.
 */
export const MAX_WAIT_MINUTES = 105;

/** GitHub's own default job budget, used for a job that declares none. */
export const DEFAULT_JOB_TIMEOUT_MINUTES = 360;

/** The exit code a PENDING outcome carries — non-zero, and not a FAIL's 1. */
export const EXIT_PENDING = 2;

export const INVENTORY_PATH = ".github/merge-readiness.json";

/* ------------------------------------------------------------------ *
 * Inventory
 * ------------------------------------------------------------------ */

/**
 * Validate a parsed inventory object. Returns { ok, problems }.
 * Fail-closed: every field the evaluator relies on must be well formed.
 */
export function validateInventory(inv) {
  const problems = [];
  const bad = (m) => problems.push(m);
  if (inv === null || typeof inv !== "object" || Array.isArray(inv)) {
    return { ok: false, problems: ["inventory is not a JSON object"] };
  }
  if (!Number.isInteger(inv.version) || inv.version < 1) bad("inventory 'version' is not a positive integer");
  if (typeof inv.selfContext !== "string" || inv.selfContext === "") bad("inventory 'selfContext' is not a non-empty string");
  if (!Number.isInteger(inv.deadlineMinutes) || inv.deadlineMinutes <= 0) {
    bad("inventory 'deadlineMinutes' is not a positive integer");
  } else if (inv.deadlineMinutes >= QUEUE_TIMEOUT_MINUTES) {
    bad(`inventory 'deadlineMinutes' (${inv.deadlineMinutes}) must be shorter than the queue timeout (${QUEUE_TIMEOUT_MINUTES})`);
  }
  if (!Array.isArray(inv.expected) || inv.expected.length === 0) {
    bad("inventory 'expected' is not a non-empty array");
  } else {
    const seen = new Set();
    for (const e of inv.expected) {
      const label = typeof e?.context === "string" ? e.context : JSON.stringify(e);
      if (typeof e?.context !== "string" || e.context === "") { bad(`expected entry ${label} has no usable 'context'`); continue; }
      if (seen.has(e.context)) bad(`expected context '${e.context}' is listed twice`);
      seen.add(e.context);
      if (typeof e.app !== "string" || e.app === "") bad(`expected context '${e.context}' names no trusted GitHub App ('app')`);
      if (typeof e.workflow !== "string" || e.workflow === "") bad(`expected context '${e.context}' names no source 'workflow'`);
      if (!Array.isArray(e.paths) || e.paths.length === 0 || !e.paths.every((p) => typeof p === "string" && p !== "")) {
        bad(`expected context '${e.context}' has a malformed 'paths' applicability (must be a non-empty array of non-empty globs; use ["**"] for always-on)`);
      }
      if (e.skippable !== undefined && typeof e.skippable !== "boolean") {
        bad(`expected context '${e.context}' has a non-boolean 'skippable' flag`);
      }
      if (
        e.timeoutMinutes !== undefined &&
        e.timeoutMinutes !== null &&
        !(Number.isInteger(e.timeoutMinutes) && e.timeoutMinutes > 0)
      ) {
        bad(`expected context '${e.context}' has a malformed 'timeoutMinutes' job budget (a positive integer, or null when the job declares none)`);
      }
    }
    if (seen.has(inv.selfContext)) bad(`inventory 'expected' contains the job's own context '${inv.selfContext}' — the job would wait on itself`);
  }
  if (inv.reportOnly !== undefined && !Array.isArray(inv.reportOnly)) bad("inventory 'reportOnly' is not an array");
  return { ok: problems.length === 0, problems };
}

/** Read + validate the inventory from a repo checkout. Throws on any problem. */
export function loadInventory(repoRoot) {
  const file = path.join(repoRoot, INVENTORY_PATH);
  let inv;
  try {
    inv = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`merge-readiness: cannot read ${INVENTORY_PATH}: ${err.message}`);
  }
  const { ok, problems } = validateInventory(inv);
  if (!ok) throw new Error(`merge-readiness: ${INVENTORY_PATH} is invalid:\n  - ${problems.join("\n  - ")}`);
  return inv;
}

/* ------------------------------------------------------------------ *
 * Candidate SHA + approved head
 * ------------------------------------------------------------------ */

/**
 * The sha CI is evaluated on for this event.
 *   pull_request -> `github.sha` (the pull-request TEST MERGE commit)
 *   merge_group  -> `merge_group.head_sha` (the queue candidate)
 * Any other event, or a missing field, fails closed.
 */
export function resolveCandidateSha({ eventName, githubSha, payload }) {
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    if (typeof githubSha !== "string" || githubSha === "") {
      throw new Error("merge-readiness: pull_request event without a github.sha (failing closed)");
    }
    return githubSha;
  }
  if (eventName === "merge_group") {
    const head = payload?.merge_group?.head_sha;
    if (typeof head !== "string" || head === "") {
      throw new Error("merge-readiness: merge_group event without merge_group.head_sha (failing closed)");
    }
    return head;
  }
  throw new Error(`merge-readiness: unsupported event '${eventName}' — this check runs on pull_request and merge_group only (failing closed)`);
}

/**
 * The TWO shas this job works with, kept apart on purpose.
 *
 *   lookupSha   — the commit whose CHECK RUNS are read. On `pull_request`
 *                 that is the pull request's HEAD (`github.event.pull_request.head.sha`):
 *                 GitHub reports check runs there, never on the ephemeral test
 *                 merge commit, so reading the test merge reports every
 *                 expected context as missing.
 *   recordedSha — the candidate the summary names as the tree under
 *                 evaluation: `github.sha` (the test merge) on `pull_request`.
 *
 * On `merge_group` the queue's own commit carries its runs, so the two are the
 * same sha and that road is unchanged.
 *
 * The head sha is passed IN by the workflow (`headSha`) — it is never inferred
 * from the event payload here, so a unit test can pin either event.
 */
export function resolveCandidateShas({ eventName, githubSha, headSha, payload }) {
  const recordedSha = resolveCandidateSha({ eventName, githubSha, payload });
  if (eventName === "merge_group") return { lookupSha: recordedSha, recordedSha };
  if (typeof headSha !== "string" || headSha === "") {
    throw new Error(
      "merge-readiness: pull_request event without the pull request's head sha (failing closed) — the workflow must pass it",
    );
  }
  return { lookupSha: headSha, recordedSha };
}

/**
 * Queue-arm revalidation of the approved head: the pull request's head must
 * still be the exact commit the approval was given on. A head that moved
 * after the approval invalidates the queue entry.
 */
export function validateApprovedHead({ approvedHead, pullRequestHead }) {
  if (typeof approvedHead !== "string" || approvedHead === "") {
    return { ok: false, reason: "no approved head could be resolved for the queued pull request (failing closed)" };
  }
  if (typeof pullRequestHead !== "string" || pullRequestHead === "") {
    return { ok: false, reason: "the queued pull request reports no head sha (failing closed)" };
  }
  if (approvedHead !== pullRequestHead) {
    return {
      ok: false,
      reason: `the approved head moved: approval is bound to ${approvedHead} but the pull request head is now ${pullRequestHead} — a new approval is required`,
    };
  }
  return { ok: true, reason: null };
}

/* ------------------------------------------------------------------ *
 * Verification-boundary predicate
 * ------------------------------------------------------------------ */

const BOUNDARY_RE = /^Verification boundary:\s*([A-Za-z][A-Za-z-]*)\s+at\s+([0-9a-f]{7,40})/;

/**
 * Parse the column-0 `Verification boundary: <state> at <sha>` records out of
 * a record text (a pull-request body, a record file). Returns the records in
 * document order as { state, sha }.
 */
export function parseBoundaryRecords(text) {
  if (typeof text !== "string") return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(BOUNDARY_RE);
    if (m) out.push({ state: m[1], sha: m[2] });
  }
  return out;
}

/** The states a boundary record may carry that mean "verified for merge". */
export const BOUNDARY_MERGEABLE_STATES = ["candidate", "promoted"];

/**
 * The boundary predicate: the LAST record for `head` must be `candidate` or
 * `promoted`. No record for the head, or a later non-mergeable state (for
 * example `candidate-pending-ci` or `proof-failed`), fails closed.
 */
export function verificationBoundaryVerdict(text, head) {
  if (typeof head !== "string" || head === "") {
    return { ok: false, state: null, reason: "no head sha to evaluate the verification boundary against (failing closed)" };
  }
  const forHead = parseBoundaryRecords(text).filter((r) => head.startsWith(r.sha) || r.sha.startsWith(head));
  if (forHead.length === 0) {
    return { ok: false, state: null, reason: `no verification-boundary record names the head ${head} (failing closed)` };
  }
  const last = forHead[forHead.length - 1];
  if (!BOUNDARY_MERGEABLE_STATES.includes(last.state)) {
    return {
      ok: false,
      state: last.state,
      reason: `the last verification-boundary record for ${head} is '${last.state}', not one of ${BOUNDARY_MERGEABLE_STATES.join(" / ")}`,
    };
  }
  return { ok: true, state: last.state, reason: null };
}

/* ------------------------------------------------------------------ *
 * Path applicability
 * ------------------------------------------------------------------ */

/** Translate one GitHub-workflow path glob into a RegExp. */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:[^/]+/)*"; } else { re += ".*"; }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Does an expected context apply to this candidate?
 * `["**"]` (or a null/undefined changed-path list, meaning "unknown — assume
 * everything") is always applicable; otherwise at least one changed path must
 * match at least one glob.
 */
export function pathsApply(globs, changedPaths) {
  if (!Array.isArray(globs) || globs.length === 0) return true;
  if (globs.includes("**")) return true;
  if (!Array.isArray(changedPaths)) return true; // unknown diff => fail closed onto "applicable"
  const res = globs.map(globToRegExp);
  return changedPaths.some((p) => res.some((r) => r.test(p)));
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

/**
 * The source string a check run is attributed to. Two check runs sharing an
 * expected context name but not this string are a DUPLICATE SOURCE: which one
 * the branch protection would match is ambiguous, so the job fails closed.
 */
export const sourceOf = (c) => `${c.app ?? "?"}:${c.workflow ?? "?"}`;

/**
 * Which of several check runs of ONE name from ONE source branch protection
 * would match: the LATEST attempt. A re-run job leaves the first attempt's
 * check run beside the second on the same commit, so the highest check-run id
 * wins, with `completedAt` as the tie-breaker when ids are missing or equal.
 */
export function latestRun(runs) {
  const key = (c) => {
    const id = typeof c?.id === "number" && Number.isFinite(c.id) ? c.id : -Infinity;
    const t = Date.parse(c?.completedAt ?? "");
    return [id, Number.isNaN(t) ? -Infinity : t];
  };
  return runs.reduce((best, c) => {
    const [bi, bt] = key(best);
    const [ci, ct] = key(c);
    if (ci !== bi) return ci > bi ? c : best;
    return ct > bt ? c : best;
  });
}

const CONCLUSION_FAIL_LABEL = {
  failure: "failed",
  cancelled: "cancelled",
  timed_out: "timed out",
  action_required: "requires action",
  neutral: "concluded neutral",
  skipped: "was skipped",
  stale: "is stale",
};

/**
 * Pure evaluation of one candidate sha. Called when the wait is over (either
 * every applicable context concluded, or the deadline expired).
 *
 * @param {object} args
 * @param {object} args.inventory   parsed .github/merge-readiness.json
 * @param {Array}  args.checks      [{ id, name, status, conclusion, completedAt, app, workflow }]
 * @param {Array|null} args.changedPaths  paths changed by the candidate (null = unknown)
 * @param {string} args.eventName
 * @param {object} [args.queue]     merge_group arm: { approvedHead, pullRequestHead, recordText }
 * @param {number} [args.waitedMinutes] the wait this run actually spent, named
 *                 in the pending text (defaults to the inventory's fallback).
 * @returns {{ok: boolean, verdict: "PASS"|"PENDING"|"FAIL", failures: string[], pending: string[], reports: string[], waitedOn: string[]}}
 */
export function evaluateReadiness({ inventory, checks, changedPaths, eventName, queue, waitedMinutes }) {
  const failures = [];
  const pending = [];
  const reports = [];
  const waited = Number.isFinite(waitedMinutes) && waitedMinutes > 0 ? waitedMinutes : inventory.deadlineMinutes;

  const applicable = inventory.expected.filter(
    (e) => e.context !== inventory.selfContext && pathsApply(e.paths, changedPaths),
  );
  const skipped = inventory.expected.filter((e) => !applicable.includes(e) && e.context !== inventory.selfContext);
  for (const e of skipped) reports.push(`not applicable to this candidate (paths ${JSON.stringify(e.paths)}): ${e.context}`);

  const byName = new Map();
  for (const c of checks ?? []) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }

  for (const e of applicable) {
    const runs = byName.get(e.context) ?? [];
    if (runs.length === 0) {
      failures.push(`missing: no check run named '${e.context}' reported on the candidate (expected from ${e.workflow})`);
      continue;
    }
    const sources = new Set(runs.map(sourceOf));
    if (sources.size > 1) {
      failures.push(
        `duplicate-source: '${e.context}' was reported ${runs.length} times from ${sources.size} source(s) [${[...sources].join(", ")}] — which run branch protection would match is ambiguous`,
      );
      continue;
    }
    // Several runs of one name from ONE source are a re-run: branch protection
    // matches the latest of them, so the latest one's conclusion decides here too.
    const run = latestRun(runs);
    if (runs.length > 1) {
      reports.push(`re-run (the latest of ${runs.length} runs from one source decides): '${e.context}'`);
    }
    if (run.app !== e.app) {
      failures.push(`untrusted-source: '${e.context}' was reported by app '${run.app}', but the inventory trusts '${e.app}'`);
      continue;
    }
    if (run.status !== "completed") {
      // A deadline is never a readiness verdict (cinatra#3391): the candidate
      // is not red, its check has simply not reported yet.
      pending.push(`pending: '${e.context}' is still '${run.status}' after ${waited} minutes — not a failure`);
      continue;
    }
    if (run.conclusion === "skipped" && e.skippable === true) {
      // A job under an `if:` guard reports `skipped` when the guard is false.
      // Branch protection counts a skipped required check as satisfied, and
      // the inventory derives `skippable` from that same guard — so this is
      // the ONE conclusion other than `success` the job accepts, and only for
      // contexts the generator marked.
      reports.push(`skipped (guarded job, accepted): '${e.context}'`);
      continue;
    }
    if (run.conclusion !== "success") {
      const label = CONCLUSION_FAIL_LABEL[run.conclusion] ?? `concluded '${run.conclusion}'`;
      failures.push(`${label}: '${e.context}'`);
    }
  }

  const known = new Set(inventory.expected.map((e) => e.context));
  for (const name of byName.keys()) {
    if (known.has(name)) continue;
    if (name === inventory.selfContext) continue; // never wait on ourselves
    reports.push(`unknown check (not in ${INVENTORY_PATH}; reported, not waited on): ${name}`);
  }

  if (eventName === "merge_group") {
    const head = validateApprovedHead({
      approvedHead: queue?.approvedHead,
      pullRequestHead: queue?.pullRequestHead,
    });
    if (!head.ok) failures.push(`approved-head: ${head.reason}`);
    const boundary = verificationBoundaryVerdict(queue?.recordText, queue?.pullRequestHead);
    if (!boundary.ok) failures.push(`verification-boundary: ${boundary.reason}`);
  }

  // A real red outranks an unfinished run: a FAIL stays a FAIL.
  const verdict = failures.length > 0 ? "FAIL" : pending.length > 0 ? "PENDING" : "PASS";
  return {
    ok: verdict === "PASS",
    verdict,
    failures,
    pending,
    reports,
    waitedOn: applicable.map((e) => e.context),
  };
}

/**
 * The wait this run is allowed: the LONGEST job budget among the expected
 * contexts that apply to this candidate (each entry's `timeoutMinutes`, the
 * `timeout-minutes` of the job that reports it; GitHub's own default budget
 * when the job declares none) plus WAIT_MARGIN_MINUTES, capped at
 * MAX_WAIT_MINUTES. With no applicable context there is no budget to follow
 * and the inventory's fallback deadline is used.
 */
export function waitBudgetMinutes({ inventory, changedPaths }) {
  const applicable = inventory.expected.filter(
    (e) => e.context !== inventory.selfContext && pathsApply(e.paths, changedPaths),
  );
  if (applicable.length === 0) return Math.min(inventory.deadlineMinutes, MAX_WAIT_MINUTES);
  const longest = Math.max(
    ...applicable.map((e) =>
      Number.isInteger(e.timeoutMinutes) && e.timeoutMinutes > 0 ? e.timeoutMinutes : DEFAULT_JOB_TIMEOUT_MINUTES,
    ),
  );
  return Math.min(longest + WAIT_MARGIN_MINUTES, MAX_WAIT_MINUTES);
}

/** PASS 0, PENDING its own code, FAIL 1 — a pending run is not a red run. */
export function exitCodeFor(result) {
  if (result.verdict === "PASS") return 0;
  if (result.verdict === "PENDING") return EXIT_PENDING;
  return 1;
}

/**
 * Polling predicate: is the candidate's check set settled enough to judge?
 * True when every applicable expected context has a COMPLETED check run —
 * missing and in-progress contexts keep the job waiting until the deadline.
 */
export function isSettled({ inventory, checks, changedPaths }) {
  const applicable = inventory.expected.filter(
    (e) => e.context !== inventory.selfContext && pathsApply(e.paths, changedPaths),
  );
  const byName = new Map();
  for (const c of checks ?? []) byName.set(c.name, c);
  return applicable.every((e) => byName.get(e.context)?.status === "completed");
}

/** Render the human-readable job summary. */
export function renderSummary({ candidateSha, lookupSha, eventName, result }) {
  const lines = [
    `merge-readiness: ${result.verdict}`,
    `  event: ${eventName}`,
    `  candidate: ${candidateSha}`,
  ];
  if (typeof lookupSha === "string" && lookupSha !== "" && lookupSha !== candidateSha) {
    lines.push(`  checks read from: ${lookupSha} (the head that carries the runs; the candidate above is the tree under evaluation)`);
  }
  lines.push(`  waited on ${result.waitedOn.length} expected context(s)`);
  for (const r of result.reports) lines.push(`  report: ${r}`);
  for (const p of result.pending ?? []) lines.push(`  ${p}`);
  for (const f of result.failures) lines.push(`  FAIL: ${f}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * CLI (the only part that talks to the GitHub API)
 * ------------------------------------------------------------------ */

const api = async (token, urlPath) => {
  const res = await fetch(`https://api.github.com${urlPath}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "cinatra-merge-readiness",
    },
  });
  if (!res.ok) throw new Error(`merge-readiness: GET ${urlPath} -> ${res.status} ${res.statusText}`);
  return res.json();
};

/** List the candidate's check runs (filter=latest is the API default). */
async function listChecks(token, repo, sha) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const body = await api(token, `/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    for (const c of body.check_runs ?? []) {
      out.push({
        id: typeof c.id === "number" ? c.id : null,
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        completedAt: c.completed_at ?? null,
        app: c.app?.slug ?? null,
        workflow: c.check_suite?.id != null ? `check_suite:${c.check_suite.id}` : (c.html_url ?? "?"),
      });
    }
    if ((body.check_runs ?? []).length < 100) break;
  }
  return out;
}

async function listChangedPaths(token, repo, prNumber) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const body = await api(token, `/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    for (const f of body) out.push(f.filename);
    if (body.length < 100) break;
  }
  return out;
}

/** The head sha the latest APPROVED review was given on. */
async function resolveApprovedHead(token, repo, prNumber) {
  const reviews = await api(token, `/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);
  const approvals = (reviews ?? []).filter((r) => r.state === "APPROVED");
  if (approvals.length === 0) return null;
  return approvals[approvals.length - 1].commit_id ?? null;
}

/** The merge-group's pull request number, from the queue branch ref. */
export function pullNumberFromQueueRef(ref) {
  const m = /gh-readonly-queue\/[^/]+\/pr-(\d+)-/.exec(ref ?? "");
  return m ? Number(m[1]) : null;
}

async function main() {
  const repoRoot = process.env.GITHUB_WORKSPACE ?? path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const payload = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  if (!repo || !token) {
    console.error("::error::merge-readiness: GITHUB_REPOSITORY and GITHUB_TOKEN are required (failing closed).");
    process.exit(1);
  }

  const inventory = loadInventory(repoRoot);
  const { lookupSha, recordedSha } = resolveCandidateShas({
    eventName,
    githubSha: process.env.MERGE_READINESS_CANDIDATE_SHA || process.env.GITHUB_SHA,
    headSha: process.env.MERGE_READINESS_HEAD_SHA,
    payload,
  });

  let prNumber = payload?.pull_request?.number ?? null;
  if (eventName === "merge_group") prNumber = pullNumberFromQueueRef(payload?.merge_group?.head_ref);

  const changedPaths = prNumber ? await listChangedPaths(token, repo, prNumber) : null;

  const budgetMinutes = waitBudgetMinutes({ inventory, changedPaths });
  const startedAt = Date.now();
  const deadline = startedAt + budgetMinutes * 60_000;
  const intervalMs = Number(process.env.MERGE_READINESS_POLL_MS ?? 30_000);
  let checks = [];
  for (;;) {
    checks = await listChecks(token, repo, lookupSha);
    if (isSettled({ inventory, checks, changedPaths })) break;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  let queue;
  if (eventName === "merge_group") {
    if (!prNumber) {
      console.error("::error::merge-readiness: could not resolve the queued pull request from merge_group.head_ref (failing closed).");
      process.exit(1);
    }
    const pr = await api(token, `/repos/${repo}/pulls/${prNumber}`);
    queue = {
      approvedHead: await resolveApprovedHead(token, repo, prNumber),
      pullRequestHead: pr.head?.sha ?? null,
      recordText: pr.body ?? "",
    };
  }

  const waitedMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
  const result = evaluateReadiness({ inventory, checks, changedPaths, eventName, queue, waitedMinutes });
  const summary = renderSummary({ candidateSha: recordedSha, lookupSha, eventName, result });
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`\n${summary}\n\`\`\`\n`);
  }
  for (const p of result.pending) console.warn(`::warning::merge-readiness: ${p}`);
  for (const f of result.failures) console.error(`::error::merge-readiness: ${f}`);
  if (result.verdict === "PENDING") {
    console.error(
      `::error::merge-readiness: pending after ${waitedMinutes} of ${budgetMinutes} allowed minutes — not a failure of this candidate; re-run this job to continue the wait.`,
    );
  }
  process.exit(exitCodeFor(result));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`::error::merge-readiness: ${err.message}`);
    process.exit(1);
  });
}
