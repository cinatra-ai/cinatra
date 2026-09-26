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
//   The expected set follows the pull request's BASE branch (#3653). A
//   workflow whose `pull_request` trigger does not run for that base (its
//   `branches` filter does not match the base, or its `branches-ignore`
//   filter does) posts no check run on the candidate, so its contexts are not
//   expected. The inventory records those filters per workflow (`triggers`);
//   the summary prints the derived set and names each excluded workflow on
//   its own line. The queue candidate (`merge_group`) keeps the full set.
//
//   Each check run is read against the LATEST run of its workflow at the head
//   (cinatra#3673): the highest run id per workflow path in the head's
//   workflow runs listing, to which a check run maps through its check suite.
//   A check run of a superseded run — the batch concurrency cancels when a
//   draft pull request is marked ready seconds after it was opened — is
//   neither a failure nor a pass: it is ignored, and its context is pending
//   until the latest run reports it. A runs listing the job cannot read
//   completely is a refusal, never a fall back to reading every check run at
//   the head as current. The log names the run each context was read from.
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
  // #3653: each workflow's recorded `pull_request` branch filters. Optional:
  // a workflow with no record is expected for every base, as before. A record
  // that is present is read strictly, because a filter this job cannot read
  // exactly would make it guess which workflows run for a base.
  if (inv.triggers !== undefined) {
    if (inv.triggers === null || typeof inv.triggers !== "object" || Array.isArray(inv.triggers)) {
      bad("inventory 'triggers' is not an object keyed by workflow path");
    } else {
      for (const [workflow, record] of Object.entries(inv.triggers)) {
        if (record === null || typeof record !== "object" || Array.isArray(record)) {
          bad(`trigger record of '${workflow}' is not an object`);
          continue;
        }
        const pr = record.pull_request;
        if (pr === undefined || pr === null) continue;
        if (typeof pr !== "object" || Array.isArray(pr)) {
          bad(`pull_request trigger of '${workflow}' is not an object`);
          continue;
        }
        for (const key of ["branches", "branches-ignore"]) {
          const list = pr[key];
          if (list === undefined || list === null) continue;
          if (!Array.isArray(list) || list.length === 0 || !list.every((p) => typeof p === "string" && p !== "")) {
            bad(`pull_request '${key}' of '${workflow}' is malformed (null, or a non-empty array of non-empty patterns)`);
            continue;
          }
          for (const p of list) {
            try {
              branchPatternToRegExp(p.startsWith("!") ? p.slice(1) : p);
            } catch (err) {
              bad(`pull_request '${key}' of '${workflow}': ${err.message}`);
            }
          }
        }
        if (Array.isArray(pr.branches) && Array.isArray(pr["branches-ignore"])) {
          bad(`pull_request trigger of '${workflow}' sets both 'branches' and 'branches-ignore', which GitHub refuses`);
        }
      }
    }
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

/**
 * The branch the candidate's `pull_request` triggers are matched against
 * (#3653): the pull request's BASE branch, read from the same event payload
 * that gives the job the pull request's number. The queue event returns null,
 * so the queue candidate keeps the full set. A pull_request payload without
 * the base fails closed.
 */
export function resolveBaseRef({ eventName, payload }) {
  if (eventName !== "pull_request" && eventName !== "pull_request_target") return null;
  const ref = payload?.pull_request?.base?.ref;
  if (typeof ref !== "string" || ref === "") {
    throw new Error("merge-readiness: pull_request event without the pull request's base branch (failing closed)");
  }
  return ref;
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
 * Base-branch applicability (#3653)
 * ------------------------------------------------------------------ */

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A character-class range GitHub accepts: 0-9, a-z or A-Z, in order. */
const classRange = (from, to) =>
  from <= to && [/[0-9]/, /[a-z]/, /[A-Z]/].some((kind) => kind.test(from) && kind.test(to));

/**
 * Translate one pattern of a workflow's `branches` / `branches-ignore` filter
 * into a RegExp, with the filter-pattern syntax GitHub documents for it:
 *   `*`   any characters except `/`      `**`  any characters, `/` included
 *   `?`   zero or one of the preceding character
 *   `+`   one or more of the preceding character
 *   `[…]` one listed letter or digit, or one from a range 0-9, a-z or A-Z
 *   `\`   makes the next character literal; every other character is literal.
 * A leading `!` (negation) is read by matchesBranchFilter, not here. A pattern
 * GitHub would refuse (an unclosed or empty class, another character in a
 * class, a trailing `\`) throws, so the inventory check rejects it.
 */
export function branchPatternToRegExp(pattern) {
  const atoms = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") { i++; atoms.push("(?:[^/]+/)*"); } else { atoms.push(".*"); }
      } else {
        atoms.push("[^/]*");
      }
    } else if ((c === "?" || c === "+") && atoms.length > 0) {
      atoms.push(`(?:${atoms.pop()})${c}`);
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      const body = end === -1 ? "" : pattern.slice(i + 1, end);
      const parts = body.match(/[A-Za-z0-9]-[A-Za-z0-9]|[A-Za-z0-9]/g) ?? [];
      if (body === "" || parts.join("") !== body || !parts.every((p) => p.length === 1 || classRange(p[0], p[2]))) {
        throw new Error(
          `branch filter '${pattern}' has a character class GitHub does not accept (letters, digits and ranges 0-9, a-z, A-Z only)`,
        );
      }
      atoms.push(`[${body}]`);
      i = end;
    } else if (c === "\\") {
      if (i + 1 >= pattern.length) throw new Error(`branch filter '${pattern}' ends with a lone '\\'`);
      i++;
      atoms.push(escapeRegExp(pattern[i]));
    } else {
      atoms.push(escapeRegExp(c));
    }
  }
  return new RegExp(`^${atoms.join("")}$`);
}

/**
 * Does an ordered `branches` / `branches-ignore` list match this branch? The
 * LAST pattern that matches decides: a `!` pattern excludes what an earlier
 * pattern matched, and a later positive pattern includes it again. This is
 * GitHub's rule for negated filter patterns.
 */
export function matchesBranchFilter(patterns, branch) {
  let matched = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    if (branchPatternToRegExp(negated ? raw.slice(1) : raw).test(branch)) matched = !negated;
  }
  return matched;
}

/**
 * Does a workflow's recorded `pull_request` trigger run for a pull request
 * into `baseRef`? Its `branches` list must match the base, and its
 * `branches-ignore` list must not. A list that is null or empty filters nothing.
 */
export function pullRequestTriggerRunsFor(trigger, baseRef) {
  const branches = trigger?.branches;
  const ignored = trigger?.["branches-ignore"];
  if (Array.isArray(branches) && branches.length > 0 && !matchesBranchFilter(branches, baseRef)) return false;
  if (Array.isArray(ignored) && ignored.length > 0 && matchesBranchFilter(ignored, baseRef)) return false;
  return true;
}

/**
 * The expected set for the candidate's base branch: every inventory context
 * except the job's own, less the contexts of each workflow whose recorded
 * `pull_request` trigger does not run for `baseRef`. Such a workflow posts no
 * check run on the candidate, so nothing from it can be waited on. Returns the
 * kept entries and one `not expected` line for each excluded workflow. With no
 * base (the queue event), and for a workflow with no recorded trigger, every
 * context stays expected, as before.
 */
export function expectedForBase({ inventory, baseRef }) {
  const all = inventory.expected.filter((e) => e.context !== inventory.selfContext);
  if (typeof baseRef !== "string" || baseRef === "") return { expected: all, notExpected: [] };
  const triggers = object(inventory.triggers) ? inventory.triggers : {};
  const excluded = new Set();
  for (const workflow of new Set(all.map((e) => e.workflow))) {
    const trigger = Object.hasOwn(triggers, workflow) ? triggers[workflow]?.pull_request : null;
    if (object(trigger) && !pullRequestTriggerRunsFor(trigger, baseRef)) excluded.add(workflow);
  }
  return {
    expected: all.filter((e) => !excluded.has(e.workflow)),
    notExpected: [...excluded].sort().map((workflow) => `not expected: ${workflow} (trigger excludes base '${baseRef}')`),
  };
}

/** The contexts this candidate waits on: its base's expected set, narrowed by path applicability. */
const applicableTo = ({ inventory, changedPaths, baseRef }) =>
  expectedForBase({ inventory, baseRef }).expected.filter((e) => pathsApply(e.paths, changedPaths));

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
 * One entry of the check-runs listing (`GET /repos/{repo}/commits/{sha}/check-runs`)
 * in the shape the evaluation reads. `workflow` stands in as the source until
 * the check suite is resolved to the workflow that produced it.
 */
export function checkRunFromApi(c) {
  return {
    id: typeof c.id === "number" ? c.id : null,
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
    completedAt: c.completed_at ?? null,
    app: c.app?.slug ?? null,
    checkSuiteId: typeof c.check_suite?.id === "number" ? c.check_suite.id : null,
    workflow: c.check_suite?.id != null ? `check_suite:${c.check_suite.id}` : (c.html_url ?? "?"),
  };
}

/**
 * Index one head's workflow-run listing (`GET /repos/{repo}/actions/runs?head_sha=`)
 * by check-suite id: `check_suite_id` -> the run's repo-relative workflow `path`.
 * Several runs of one workflow at one head (a draft-to-ready flip runs it
 * twice) carry DIFFERENT check-suite ids and the SAME path, so the index is
 * what collapses them to one source.
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

/** The refusal to judge a head whose workflow runs cannot be read (cinatra#3673). */
const workflowRunsRefusal = (sha, reason) =>
  new Error(
    `merge-readiness: cannot read the workflow runs of ${sha} (${reason}) — refusing to judge its check runs without each workflow's latest run (failing closed)`,
  );

/**
 * Read one head's workflow runs listing strictly — every page of
 * `GET /repos/{repo}/actions/runs?head_sha=` merged into one
 * `{ total_count, workflow_runs }` — and return its runs (cinatra#3673).
 * Every check run is judged against the latest run of its workflow, so a
 * listing this job cannot read completely is a refusal that names the reason,
 * never a fall back to reading every check run at the head as current.
 */
export function readWorkflowRuns(listing, headSha) {
  const refuse = (reason) => {
    throw workflowRunsRefusal(headSha, reason);
  };
  if (!object(listing)) refuse("the listing is not an object");
  const runs = listing.workflow_runs;
  if (!Array.isArray(runs)) refuse("'workflow_runs' is not an array");
  if (!Number.isSafeInteger(listing.total_count) || listing.total_count < 0) refuse("'total_count' is not a count");
  if (runs.length !== listing.total_count) refuse(`the listing holds ${runs.length} of ${listing.total_count} runs`);
  const ids = new Set();
  const suites = new Set();
  runs.forEach((r, i) => {
    if (!object(r) || !positive(r.id)) refuse(`run #${i + 1} has no run id`);
    if (ids.has(r.id)) refuse(`run ${r.id} is listed twice`);
    ids.add(r.id);
    if (!positive(r.check_suite_id)) refuse(`run ${r.id} has no check suite id`);
    if (suites.has(r.check_suite_id)) refuse(`run ${r.id} shares check suite ${r.check_suite_id} with another run`);
    suites.add(r.check_suite_id);
    if (typeof r.path !== "string" || r.path === "") refuse(`run ${r.id} names no workflow path`);
    if (typeof r.status !== "string" || r.status === "") refuse(`run ${r.id} has no status`);
    if (r.conclusion !== null && typeof r.conclusion !== "string") refuse(`run ${r.id} has a malformed conclusion`);
    if (r.head_sha !== headSha) refuse(`run ${r.id} belongs to head ${r.head_sha}`);
  });
  return runs;
}

/**
 * Judge every check run against the LATEST run of its workflow at the head
 * (cinatra#3673). A draft pull request marked ready seconds after it was
 * opened runs a workflow twice at one head: concurrency cancels the first
 * run, whose jobs end `cancelled` — or `failure` when killed mid-way — while
 * the second run has not yet created every job. The highest run id per
 * workflow path is that workflow's latest run; a check run of an older run is
 * marked `superseded`, and the evaluation ignores it: neither a failure nor a
 * pass. A re-run keeps its run id and check suite, so the attempts of one run
 * stay one run here. A check run maps to its run through its check suite, as
 * resolveCheckWorkflows maps it to its workflow; a check run no listed run
 * owns (an app outside Actions) is left exactly as that leaves it.
 *
 * @param {Array} checks check runs as checkRunFromApi shapes them
 * @param {Array} runs   the head's workflow runs, as readWorkflowRuns accepted them
 */
export function resolveLatestRuns(checks, runs) {
  const latestByWorkflow = new Map();
  for (const r of runs) {
    const seen = latestByWorkflow.get(r.path);
    if (seen === undefined || r.id > seen.id) latestByWorkflow.set(r.path, r);
  }
  const runBySuite = new Map(runs.map((r) => [r.check_suite_id, r]));
  return resolveCheckWorkflows(checks, workflowPathsBySuite(runs)).map((c) => {
    const run = c.workflowResolved === true ? runBySuite.get(c.checkSuiteId) : undefined;
    if (run === undefined) return c;
    const latest = latestByWorkflow.get(run.path);
    return {
      ...c,
      runId: run.id,
      superseded: run.id !== latest.id,
      latestRun: { id: latest.id, status: latest.status, conclusion: latest.conclusion },
    };
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
 * @param {Array}  args.checks      [{ id, name, status, conclusion, completedAt, app, workflow }],
 *                 plus `runId`, `superseded` and `latestRun` where resolveLatestRuns
 *                 mapped the check run to its workflow run (cinatra#3673)
 * @param {Array|null} args.changedPaths  paths changed by the candidate (null = unknown)
 * @param {string} args.eventName
 * @param {object} [args.queue]     merge_group arm: authenticated { before, after } snapshots
 * @param {number} [args.waitedMinutes] the wait this run actually spent, named
 *                 in the pending text (defaults to the inventory's fallback).
 * @param {string|null} [args.baseRef] the pull request's base branch: only the
 *                 workflows whose `pull_request` trigger runs for it are
 *                 expected (#3653). Null keeps the full set (the queue event).
 * @returns {{ok: boolean, verdict: "PASS"|"PENDING"|"FAIL", failures: string[], pending: string[], reports: string[], waitedOn: string[], base: string|null, expectedSet: {context: string, workflow: string}[], notExpected: string[], readFrom: {context: string, runId: number|null, workflow: string|null}[]}}
 */
export function evaluateReadiness({ inventory, checks, changedPaths, eventName, queue, waitedMinutes, baseRef = null }) {
  const failures = [];
  const pending = [];
  const reports = [];
  const readFrom = [];
  const waited = Number.isFinite(waitedMinutes) && waitedMinutes > 0 ? waitedMinutes : inventory.deadlineMinutes;

  const derived = expectedForBase({ inventory, baseRef });
  const applicable = derived.expected.filter((e) => pathsApply(e.paths, changedPaths));
  const skipped = derived.expected.filter((e) => !applicable.includes(e));
  for (const e of skipped) reports.push(`not applicable to this candidate (paths ${JSON.stringify(e.paths)}): ${e.context}`);

  // cinatra#3673: name each superseded workflow run once; its check runs are ignored below.
  const superseded = new Map();
  for (const c of checks ?? []) {
    if (c?.superseded === true && !superseded.has(c.runId)) superseded.set(c.runId, c);
  }
  for (const c of [...superseded.values()].sort((a, b) => a.runId - b.runId)) {
    reports.push(
      `superseded run ignored: run ${c.runId} of ${c.workflow} — run ${c.latestRun.id} is the latest of that workflow at the head`,
    );
  }

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
    // A check run of a superseded workflow run is neither a failure nor a pass
    // (cinatra#3673). Of the rest, several runs of one name from ONE source are
    // a re-run: branch protection matches the latest of them, so the latest
    // one's conclusion decides here too.
    const current = runs.filter((c) => c.superseded !== true);
    const run = latestRun(current.length > 0 ? current : runs);
    if (current.length > 1) {
      reports.push(`re-run (the latest of ${current.length} runs from one source decides): '${e.context}'`);
    }
    if (current.length > 0) readFrom.push({ context: e.context, runId: run.runId ?? null, workflow: run.workflow ?? null });
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
    if (current.length === 0) {
      // Only a superseded run reported this context: it is pending until the
      // latest run of its workflow reports it, and missing once that run has
      // completed without it.
      const latest = run.latestRun;
      if (latest.status !== "completed") {
        pending.push(
          `pending: '${e.context}' is not yet reported by the latest run ${latest.id} of ${run.workflow} (still '${latest.status}') after ${waited} minutes — not a failure`,
        );
      } else {
        failures.push(
          `missing: no check run named '${e.context}' in the latest run ${latest.id} of ${run.workflow}, which concluded '${latest.conclusion}' (a superseded run's check run is ignored)`,
        );
      }
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
    base: typeof baseRef === "string" && baseRef !== "" ? baseRef : null,
    expectedSet: derived.expected.map((e) => ({ context: e.context, workflow: e.workflow })),
    notExpected: derived.notExpected,
    readFrom,
  };
}

/**
 * The wait this run is allowed: the LONGEST job budget among the expected
 * contexts that apply to this candidate (each entry's `timeoutMinutes`, the
 * `timeout-minutes` of the job that reports it; GitHub's own default budget
 * when the job declares none) plus WAIT_MARGIN_MINUTES, capped at
 * MAX_WAIT_MINUTES. With no applicable context there is no budget to follow
 * and the inventory's fallback deadline is used. A workflow that does not run
 * for the base (#3653) adds no budget.
 */
export function waitBudgetMinutes({ inventory, changedPaths, baseRef = null }) {
  const applicable = applicableTo({ inventory, changedPaths, baseRef });
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
 * A workflow that does not run for the base (#3653) is not waited for. A
 * check run of a superseded workflow run never settles a context
 * (cinatra#3673); of the rest, the one the evaluation reads decides.
 */
export function isSettled({ inventory, checks, changedPaths, baseRef = null }) {
  const applicable = applicableTo({ inventory, changedPaths, baseRef });
  const byName = new Map();
  for (const c of checks ?? []) {
    if (c?.superseded === true) continue;
    const seen = byName.get(c.name);
    byName.set(c.name, seen === undefined ? c : latestRun([seen, c]));
  }
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
  const base = typeof result.base === "string" && result.base !== "" ? result.base : null;
  if (base !== null) lines.push(`  base: ${base}`);
  if (Array.isArray(result.expectedSet)) {
    const workflows = new Set(result.expectedSet.map((e) => e.workflow)).size;
    const forBase = base !== null ? ` for base '${base}'` : "";
    lines.push(`  expected set${forBase}: ${result.expectedSet.length} context(s) from ${workflows} workflow(s)`);
    for (const e of result.expectedSet) lines.push(`    expected: ${e.context} (from ${e.workflow})`);
  }
  for (const n of result.notExpected ?? []) lines.push(`  ${n}`);
  lines.push(`  waited on ${result.waitedOn.length} expected context(s)`);
  for (const r of result.reports) lines.push(`  report: ${r}`);
  for (const p of result.pending ?? []) lines.push(`  ${p}`);
  for (const f of result.failures) lines.push(`  FAIL: ${f}`);
  return lines.join("\n");
}

/**
 * The runs an evaluation read (cinatra#3673): one line for each context read
 * from a check run, naming the workflow run that check run belongs to. It is
 * logged after the summary, so the summary of a head with one run per
 * workflow reads exactly as before. Empty when no context was read.
 */
export function renderReadFrom(result) {
  const read = result?.readFrom ?? [];
  if (read.length === 0) return "";
  return [
    "merge-readiness: check runs read",
    ...read.map((r) =>
      r.runId !== null
        ? `  read '${r.context}' from run ${r.runId} of ${r.workflow}`
        : `  read '${r.context}' from ${r.workflow ?? "an unknown source"} (no workflow run of this head owns it)`,
    ),
  ].join("\n");
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
    for (const c of body.check_runs ?? []) out.push(checkRunFromApi(c));
    if ((body.check_runs ?? []).length < 100) break;
  }
  return out;
}

/**
 * The workflow runs of one head, every page, read strictly (see
 * readWorkflowRuns). A request that fails is the same refusal (cinatra#3673).
 */
async function listWorkflowRuns(token, repo, sha) {
  const runs = [];
  let total = null;
  for (let page = 1; page <= 10; page++) {
    let body;
    try {
      body = await api(token, `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100&page=${page}`);
    } catch (err) {
      throw workflowRunsRefusal(sha, err.message.replace(/^merge-readiness: /, ""));
    }
    if (!object(body) || !Array.isArray(body.workflow_runs)) {
      throw workflowRunsRefusal(sha, "a page carries no 'workflow_runs' array");
    }
    runs.push(...body.workflow_runs);
    total = body.total_count;
    if (body.workflow_runs.length < 100) break;
  }
  return readWorkflowRuns({ total_count: total, workflow_runs: runs }, sha);
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
  const baseRef = resolveBaseRef({ eventName, payload });

  const prNumber = payload?.pull_request?.number ?? null;
  const queueArgs = eventName === "merge_group" ? { repo, payload, lookupSha, recordedSha,
    get: endpoint => api(token, endpoint), engine: createQueueEngineReader(repoRoot, token) } : null;
  const before = queueArgs ? await readQueueEvidence(queueArgs) : null;
  const changedPaths = before ? before.changedPaths : prNumber ? await listChangedPaths(token, repo, prNumber) : null;

  const budgetMinutes = waitBudgetMinutes({ inventory, changedPaths, baseRef });
  const startedAt = Date.now();
  const deadline = startedAt + budgetMinutes * 60_000;
  const intervalMs = Number(process.env.MERGE_READINESS_POLL_MS ?? 30_000);
  let checks = [];
  for (;;) {
    const listed = await listChecks(token, repo, lookupSha);
    const expired = Date.now() >= deadline;
    // The wait can end only once every applicable context has a completed
    // check run somewhere at the head; from then on each poll also reads the
    // head's workflow runs, after its check runs so that the run of every
    // listed check run is in that listing. A check run names its check suite,
    // never its workflow: each is resolved to its workflow run, and the wait
    // follows the latest run of each workflow (cinatra#3673).
    const completed = listed.filter((c) => c.status === "completed");
    if (expired || isSettled({ inventory, checks: completed, changedPaths, baseRef })) {
      checks = resolveLatestRuns(listed, await listWorkflowRuns(token, repo, lookupSha));
      if (expired || isSettled({ inventory, checks, changedPaths, baseRef })) break;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  const queue = queueArgs ? { before, after: await readQueueEvidence(queueArgs) } : undefined;

  const waitedMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
  const result = evaluateReadiness({ inventory, checks, changedPaths, eventName, queue, waitedMinutes, baseRef });
  const summary = renderSummary({ candidateSha: recordedSha, lookupSha, eventName, result });
  console.log(summary);
  // The log names the run each context was read from (cinatra#3673).
  const readFrom = renderReadFrom(result);
  if (readFrom !== "") console.log(readFrom);
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
