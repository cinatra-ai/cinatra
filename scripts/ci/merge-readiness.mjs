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
//   On `merge_group`, immutable engine entrypoints authenticate the exact
//   queued PR/head/base/tree and current candidate/promoted boundary. Complete
//   file inventory and both receipts must remain identical across the wait.
//   Editable body records and queue-ref guesses cannot supply authority.
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
import { execFileSync } from "node:child_process";
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
 * Candidate SHA + authenticated queue identity
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

/* Queue authority comes only from the immutable, separately checked-out engine. */
export const QUEUE_ENGINE_PIN = "1e40675e1642dcc32d195f27b3deb285b4d3d6fc";
export const QUEUE_ENGINE_DIRECTORY = ".merge-readiness-engine";
const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const requireQueue = (condition, message) => { if (!condition) throw new Error(`merge-readiness: queue ${message}`); };
const exactKeys = (value, keys) => object(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

export function validateQueueBinding(report, expected) {
  requireQueue(object(report) && report.arm === "merge-group" && report.mode === "enforce" && report.repo === expected.repository
    && report.apiSkippedReason === null && report.findingCount === 0 && Array.isArray(report.findings) && report.findings.length === 0,
  "engine did not return an authenticated enforce result");
  const q = report.queueBinding;
  requireQueue(exactKeys(q, ["schema", "repository", "repositoryId", "pullRequest", "headSha", "headRepositoryId", "baseRef", "baseSha", "groupHeadSha", "parents", "groupTree", "authority"]), "binding shape is invalid");
  requireQueue(q.schema === "cinatra.queue-binding/v1" && q.repository === expected.repository
    && positive(q.repositoryId) && positive(q.headRepositoryId) && positive(q.pullRequest)
    && FULL_SHA.test(q.headSha) && FULL_SHA.test(q.baseSha) && FULL_SHA.test(q.groupHeadSha) && FULL_SHA.test(q.groupTree)
    && q.groupHeadSha === expected.groupHeadSha && q.baseSha === expected.baseSha && q.baseRef === expected.baseRef
    && Array.isArray(q.parents) && q.parents.length === 2 && q.parents[0] === q.baseSha && q.parents[1] === q.headSha
    && ["review", "delegated-v1"].includes(q.authority), "binding does not match the event and exact candidate");
  requireQueue(q.authority !== "delegated-v1" || q.headRepositoryId === q.repositoryId, "delegated head repository differs");
  return Object.fromEntries(["schema", "repository", "repositoryId", "pullRequest", "headSha", "headRepositoryId", "baseRef", "baseSha", "groupHeadSha", "parents", "groupTree", "authority"].map(key => [key, q[key]]));
}

export function validateBoundaryBinding(value, q) {
  requireQueue(exactKeys(value, ["schema", "repository", "repositoryId", "pullRequest", "headSha", "state", "commentId", "digest"]), "boundary shape is invalid");
  requireQueue(value.schema === "cinatra.verification-boundary-current/v1" && value.repository === q.repository
    && value.repositoryId === q.repositoryId && value.pullRequest === q.pullRequest && value.headSha === q.headSha
    && ["candidate", "promoted"].includes(value.state) && positive(value.commentId) && DIGEST.test(value.digest),
  "boundary is not authenticated for the exact queued head");
  return Object.fromEntries(["schema", "repository", "repositoryId", "pullRequest", "headSha", "state", "commentId", "digest"].map(key => [key, value[key]]));
}

function engineEnvironment(token) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") || key.startsWith("PYTHON") || ["NODE_OPTIONS", "NODE_PATH", "GH_DEBUG"].includes(key)) delete env[key];
  return { ...env, GH_HOST: "github.com", GH_TOKEN: token, GITHUB_TOKEN: token,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", PYTHONDONTWRITEBYTECODE: "1" };
}

export function createQueueEngineReader(repoRoot, token, execute = execFileSync) {
  const root = path.resolve(repoRoot), engine = path.join(root, QUEUE_ENGINE_DIRECTORY);
  const options = { cwd: root, env: engineEnvironment(token), encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
  const git = (cwd, ...args) => execute("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { ...options, timeout: 3000 }).trim();
  const verify = () => {
    requireQueue(FULL_SHA.test(QUEUE_ENGINE_PIN), "engine merge pin is not selected");
    requireQueue(fs.realpathSync(engine) === engine && !fs.lstatSync(engine).isSymbolicLink(), "engine path is not the fixed checkout");
    requireQueue(git(engine, "rev-parse", "--show-toplevel") === engine && git(engine, "rev-parse", "HEAD") === QUEUE_ENGINE_PIN, "engine checkout does not match the pinned source");
    requireQueue(git(engine, "status", "--porcelain", "--untracked-files=all", "--ignored") === "", "engine checkout is not clean");
  };
  return (kind, args, groupHead) => {
    verify();
    requireQueue(git(root, "rev-parse", "HEAD") === groupHead, "checkout is not the event candidate");
    const script = kind === "attribution" ? "truthful-attribution-gate.mjs" : kind === "boundary" ? "verification-boundary.py" : null;
    requireQueue(script !== null, "unknown engine operation");
    let raw;
    try { raw = execute(kind === "attribution" ? process.execPath : "python3", [path.join(engine, "scripts", script), ...args], options); }
    catch { throw new Error(`merge-readiness: queue ${kind} engine refused or could not complete`); }
    verify();
    requireQueue(git(root, "rev-parse", "HEAD") === groupHead, "checkout changed during engine read");
    try { return JSON.parse(raw); } catch { throw new Error(`merge-readiness: queue ${kind} result is not one JSON document`); }
  };
}

function queuedPullIdentity(pr, q) {
  requireQueue(object(pr) && pr.number === q.pullRequest && pr.state === "open" && pr.merged === false && pr.draft === false
    && pr.head?.sha === q.headSha && pr.head?.repo?.id === q.headRepositoryId
    && typeof pr.head?.ref === "string" && pr.head.ref !== ""
    && typeof pr.head?.repo?.full_name === "string" && pr.head.repo.full_name !== ""
    && pr.base?.ref === q.baseRef && pr.base?.repo?.id === q.repositoryId && pr.base?.repo?.full_name === q.repository
    && Number.isSafeInteger(pr.changed_files) && pr.changed_files >= 0 && pr.changed_files <= 3000,
  "pull identity or file count differs from verified engine binding");
  return [pr.number, pr.state, pr.merged, pr.draft, pr.head.sha, pr.head.ref, pr.head.repo.id, pr.head.repo.full_name,
    pr.base.ref, pr.base.repo.id, pr.base.repo.full_name, pr.changed_files];
}

export async function readQueuedFiles(get, q) {
  const endpoint = `/repos/${q.repository}/pulls/${q.pullRequest}`;
  const identity = queuedPullIdentity(await get(endpoint), q);
  const files = [], seen = new Set(); let complete = false;
  const validPath = name => typeof name === "string" && name !== "" && !name.startsWith("/") && !name.split("/").some(x => x === ".." || x === "") && !/[\x00-\x1f]/.test(name);
  for (let page = 1; page <= 31; page++) {
    const rows = await get(`${endpoint}/files?per_page=100&page=${page}`);
    requireQueue(Array.isArray(rows) && rows.length <= 100, "file page is malformed");
    for (const f of rows) {
      requireQueue(object(f) && validPath(f.filename) && !seen.has(f.filename) && FULL_SHA.test(f.sha)
        && ["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"].includes(f.status)
        && [f.additions, f.deletions, f.changes].every(n => Number.isSafeInteger(n) && n >= 0)
        && (f.previous_filename == null || validPath(f.previous_filename))
        && (f.status !== "renamed" || validPath(f.previous_filename)), "file inventory is incomplete or malformed");
      seen.add(f.filename);
      files.push({ filename: f.filename, previous_filename: f.previous_filename ?? null, status: f.status, sha: f.sha,
        additions: f.additions, deletions: f.deletions, changes: f.changes });
      requireQueue(files.length <= 3000, "file inventory exceeds API limit");
    }
    if (rows.length < 100) { complete = true; break; }
  }
  requireQueue(complete && files.length === identity.at(-1), "file pagination or count is incomplete");
  requireQueue(JSON.stringify(queuedPullIdentity(await get(endpoint), q)) === JSON.stringify(identity), "pull changed during file inventory");
  files.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
  return { identity, files, changedPaths: [...new Set(files.flatMap(f => [f.filename, f.previous_filename].filter(Boolean)))].sort() };
}

export async function readQueueEvidence({ repo, payload, lookupSha, recordedSha, get, engine }) {
  const group = payload?.merge_group;
  requireQueue(typeof repo === "string" && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.includes("..")
    && FULL_SHA.test(group?.head_sha) && FULL_SHA.test(group?.base_sha)
    && typeof group?.base_ref === "string" && group.base_ref.startsWith("refs/heads/") && group.base_ref.length > 11
    && lookupSha === group.head_sha && recordedSha === group.head_sha, "event does not bind full candidate/base identity");
  const expected = { repository: repo, groupHeadSha: group.head_sha, baseSha: group.base_sha, baseRef: group.base_ref.slice(11) };
  const binding = validateQueueBinding(engine("attribution", ["--arm", "merge-group", "--mode", "enforce", "--format", "json", "--repo", repo,
    "--merge-group-head", expected.groupHeadSha, "--merge-group-base", expected.baseSha, "--gate-arm-wait-ms", "0"], expected.groupHeadSha), expected);
  const boundary = validateBoundaryBinding(engine("boundary", ["--repo", repo, "--pr", String(binding.pullRequest), "--head", binding.headSha], expected.groupHeadSha), binding);
  const inventory = await readQueuedFiles(get, binding);
  return { binding, boundary, ...inventory };
}

export function validateQueueEvidencePair(queue) {
  requireQueue(object(queue?.before) && object(queue?.after), "authenticated before/after evidence is missing");
  for (const snapshot of [queue.before, queue.after]) {
    const q = snapshot.binding;
    validateQueueBinding({ arm: "merge-group", mode: "enforce", repo: q?.repository, apiSkippedReason: null, findingCount: 0, findings: [], queueBinding: q },
      { repository: q?.repository, groupHeadSha: q?.groupHeadSha, baseSha: q?.baseSha, baseRef: q?.baseRef });
    validateBoundaryBinding(snapshot.boundary, q);
    requireQueue(Array.isArray(snapshot.files) && Array.isArray(snapshot.identity) && Array.isArray(snapshot.changedPaths), "file snapshot is missing");
  }
  requireQueue(JSON.stringify(queue.before) === JSON.stringify(queue.after), "authority, receipt or file inventory changed while waiting");
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
 *
 * `workflow` is the WORKFLOW the run came from once `resolveCheckWorkflows`
 * has resolved it (see below); the check-suite id stands in for a run no
 * workflow owns.
 */
export const sourceOf = (c) => `${c.app ?? "?"}:${c.workflow ?? "?"}`;

/**
 * Index one head's workflow-run listing (`GET /repos/{repo}/actions/runs?head_sha=`)
 * by check-suite id: `check_suite_id` -> the run's repo-relative workflow `path`.
 * Several runs of one workflow at one head (a re-run, a draft-to-ready flip, a
 * synchronize) carry DIFFERENT check-suite ids and the SAME path, so the index
 * is what collapses them to one source.
 */
export function workflowPathsBySuite(runs) {
  const bySuite = new Map();
  for (const r of runs ?? []) {
    const id = typeof r?.check_suite_id === "number" && Number.isFinite(r.check_suite_id) ? r.check_suite_id : null;
    const wfPath = typeof r?.path === "string" && r.path !== "" ? r.path : null;
    if (id === null || wfPath === null) continue;
    if (!bySuite.has(id)) bySuite.set(id, wfPath);
  }
  return bySuite;
}

/**
 * Resolve every check run's check-suite id to the workflow that produced it.
 * A check-run payload carries no workflow identity, only its check suite, so a
 * suite that maps to a workflow run becomes the source `<app>:<workflow path>`
 * (cinatra#3391: the draft stub and the ready-for-review run of ONE workflow
 * are two suites and were read as two sources); a suite no workflow run owns
 * (an app outside Actions) keeps the check-suite-id source it already had.
 */
export function resolveCheckWorkflows(checks, suiteWorkflows) {
  const bySuite = suiteWorkflows instanceof Map ? suiteWorkflows : new Map();
  return (checks ?? []).map((c) => {
    const wfPath = c?.checkSuiteId != null ? bySuite.get(c.checkSuiteId) : undefined;
    if (typeof wfPath !== "string" || wfPath === "") return { ...c, workflowResolved: false };
    return { ...c, workflow: wfPath, workflowResolved: true };
  });
}

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
 * @param {object} [args.queue]     merge_group arm: authenticated { before, after } snapshots
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
    // The inventory records the workflow path of every expected context, so a
    // RESOLVED path that is not that one is a foreign workflow claiming the
    // context (a tightening; an unresolved run is judged exactly as before).
    if (run.workflowResolved === true && typeof e.workflow === "string" && run.workflow !== e.workflow) {
      failures.push(
        `untrusted-source: '${e.context}' was reported by workflow '${run.workflow}', but the inventory expects '${e.workflow}'`,
      );
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
    try { validateQueueEvidencePair(queue); }
    catch (error) { failures.push(`queue-authority: ${error.message}`); }
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
        checkSuiteId: typeof c.check_suite?.id === "number" ? c.check_suite.id : null,
        workflow: c.check_suite?.id != null ? `check_suite:${c.check_suite.id}` : (c.html_url ?? "?"),
      });
    }
    if ((body.check_runs ?? []).length < 100) break;
  }
  return out;
}

/** The workflow runs of one head, indexed by check-suite id (see workflowPathsBySuite). */
async function listWorkflowPaths(token, repo, sha) {
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const body = await api(token, `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100&page=${page}`);
    const got = body.workflow_runs ?? [];
    for (const r of got) runs.push(r);
    if (got.length < 100) break;
  }
  return workflowPathsBySuite(runs);
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

  const prNumber = payload?.pull_request?.number ?? null;
  const queueArgs = eventName === "merge_group" ? { repo, payload, lookupSha, recordedSha,
    get: endpoint => api(token, endpoint), engine: createQueueEngineReader(repoRoot, token) } : null;
  const before = queueArgs ? await readQueueEvidence(queueArgs) : null;
  const changedPaths = before ? before.changedPaths : prNumber ? await listChangedPaths(token, repo, prNumber) : null;

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

  // A check run names its check suite, never its workflow: resolve the suites
  // of this head to workflows before the sources are judged.
  checks = resolveCheckWorkflows(checks, await listWorkflowPaths(token, repo, lookupSha));

  const queue = queueArgs ? { before, after: await readQueueEvidence(queueArgs) } : undefined;

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
