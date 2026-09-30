// The floor base guard (cinatra#3832): a ratchet gate's committed floor is
// compared with the copy of the same file on the base branch, so a pull
// request cannot raise a floor in its own change.
//
// A ratchet gate compares a live count or list with a committed floor file and
// fails on growth. Without this guard the floor is read only from the pull
// request's own checkout: the same change that adds a new occurrence can add it
// to the floor and pass. The guard reads the floor file at the base reference
// and asks the gate's own question — "did the floor grow?" — with the gate's own
// meaning of growth (a new item, a raised count, a new key, a new package in a
// set). Lowering a floor or removing a stale item is never growth.
//
// WHERE THE BASE COMES FROM, in this order:
//   1. the gate's own environment variable, when the workflow sets one (the
//      value is a git revision: the remote base branch on a pull request, the
//      previous tip on a push);
//   2. else the platform's variable for a pull request's base branch
//      (GITHUB_BASE_REF, set on every pull request run), read as the remote
//      branch of that name (`origin/main` for `main`);
//   3. else there is no base: a run that is no pull request (a push to the
//      default branch, a local run). The guard says so in one line and passes;
//      the gate's own check against the tree still runs.
//
// FAIL CLOSED. On a pull request's run (or whenever a base is named) a base that
// cannot be read fails the gate with a line that names the reason: a flag-like
// or malformed reference, a reference that does not resolve (a shallow
// checkout), a floor file that is not on the base, a base copy that does not
// parse. The guard never passes in silence.
//
// A CHECKOUT OF ONE COMMIT. A workflow whose checkout takes one commit has no
// base branch in it. When the base came from the pull request's base branch
// (source 2) and does not resolve, the guard fetches that branch itself, one
// commit deep, from the checkout's own remote `origin` (for the base branch
// `main`):
//   git fetch --depth=1 --no-tags origin +refs/heads/main:refs/floor-base-guard/main
// into a reference of its own, never into a branch of the checkout, and reads
// the floor there. The branch name is checked against the form of a branch
// name before it reaches git. One attempt with a timeout of 30 seconds, one
// more after a failure, no other network call. The repository is public: the
// fetch needs no credential, and the guard adds none and reads none. The fetch
// is anonymous whatever the checkout left in its configuration: no credential
// helper, no prompt, no askpass program, and every extra HTTP header key
// (`http.extraheader` and each address-scoped one) is reset to empty for the
// guard's own call, so a job token a checkout stored is never sent. A remote address with a user part is never
// printed; the remote is then named by its name only. A fetch that fails fails
// the gate with its reason. A base in the checkout already is read as before,
// with nothing fetched. A base named by the gate's own variable is a revision
// the workflow chose and fetched itself: it is never fetched here.
// FLOOR_BASE_FETCH=0 switches the fetch off (a missing base then fails closed
// as before); the tests that run a gate in the real checkout use it.
//
// Node builtins only; the one external program is `git`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The platform's variable naming a pull request's base branch. */
export const PULL_REQUEST_BASE_VAR = "GITHUB_BASE_REF";

/** The platform's variable naming the event of the run. */
export const EVENT_NAME_VAR = "GITHUB_EVENT_NAME";

/** The events whose runs always carry a base branch. */
export const PULL_REQUEST_EVENTS = new Set(["pull_request", "pull_request_target"]);

// A branch name as the platform reports it. Deliberately narrow: anything else
// is refused rather than handed to git.
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

/** The remote a pull request's base branch is read from (`origin/main` for `main`). */
export const BASE_REMOTE = "origin";

/** The namespace of the references the guard fetches a base into. */
export const FETCHED_REF_PREFIX = "refs/floor-base-guard/";

/** One fetch attempt's time limit, in milliseconds. */
export const FETCH_TIMEOUT_MS = 30_000;

/** Fetch attempts: one, and one more after a failure. */
export const FETCH_ATTEMPTS = 2;

/** "0" switches the fetch off; a missing base then fails closed. */
export const FETCH_SWITCH_VAR = "FLOOR_BASE_FETCH";

/**
 * True when `name` has the form of a branch name: letters, digits, dot, dash,
 * underscore and slash; no leading dash; no `..`.
 */
export function isBranchName(name) {
  return typeof name === "string" && BRANCH_NAME_RE.test(name) && !name.startsWith("-") && !name.includes("..");
}

/**
 * True when a remote address holds a user part: `scheme://user@host/...` or
 * the scp form `user@host:path`. Such an address is never printed.
 */
export function remoteAddressHoldsUserPart(address) {
  if (typeof address !== "string") return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(address)) {
    const authority = address.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0];
    return authority.includes("@");
  }
  // The scp form: no scheme, `[user@]host:path`, with no slash before the colon.
  return /^[^/:]*@[^/:]+:/.test(address);
}

/**
 * `text` with the remote's address replaced by its name and every user part
 * of any address removed, so a credential can never reach a printed line.
 */
export function redactRemote(text, { name, url }) {
  let out = String(text);
  if (typeof url === "string" && url !== "") out = out.split(url).join(`the remote "${name}"`);
  return out
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@'"]*@/g, "$1")
    .replace(/(^|[\s'"])[^\s/:@'"]+@([^\s/:'"]+:)/g, "$1$2");
}

function remoteUrl(repoRoot, remote) {
  try {
    const url = execFileSync("git", ["config", "--get", `remote.${remote}.url`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return url === "" ? undefined : url;
  } catch {
    return undefined;
  }
}

/**
 * The configuration keys of an extra HTTP header scoped to an address
 * (`http.ADDRESS.extraheader`), in every scope git reads for the checkout,
 * includes followed: the keys a checkout action writes a job's token into.
 */
export function extraHeaderKeys(repoRoot) {
  try {
    return execFileSync("git", ["config", "--includes", "--name-only", "--get-regexp", "^http\\..*\\.extraheader$"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((k) => k.trim())
      .filter(Boolean)
      .filter((k, i, all) => all.indexOf(k) === i);
  } catch {
    return []; // git exits 1 when no key matches
  }
}

/**
 * The `-c` arguments that make the guard's fetch anonymous whatever the
 * checkout left in its configuration: no credential helper, no askpass
 * program, no extra header (an empty value resets git's list of extra
 * headers), for `http.extraheader` and for every address-scoped key.
 */
export function anonymousFetchArgs(repoRoot) {
  const args = ["-c", "credential.helper=", "-c", "core.askPass=", "-c", "http.extraheader="];
  for (const key of extraHeaderKeys(repoRoot)) args.push("-c", `${key}=`);
  return args;
}

/** The last line git wrote to stderr, redacted and short. */
function gitSaid(err, remote) {
  const text = String(err?.stderr ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!text) return `git exited with status ${err?.status ?? "unknown"}`;
  return redactRemote(text, remote).slice(0, 200);
}

/**
 * Fetch `branch` one commit deep from `remote` into the guard's own reference
 * under `refs/floor-base-guard/` (`refs/floor-base-guard/main` for `main`).
 * The name is checked before git is called.
 * One attempt with a timeout, one more after a failure.
 * Returns `{ ok: true, ref, attempts }` or `{ ok: false, reason, attempts }`.
 */
export function fetchBaseBranch({ repoRoot, remote = BASE_REMOTE, branch, timeoutMs = FETCH_TIMEOUT_MS }) {
  if (!isBranchName(branch)) {
    return { ok: false, attempts: 0, reason: `the base branch "${branch}" is not a branch name` };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith("-")) {
    return { ok: false, attempts: 0, reason: `the remote "${remote}" is not a remote name` };
  }
  const url = remoteUrl(repoRoot, remote);
  if (url === undefined) {
    return { ok: false, attempts: 0, reason: `the checkout has no remote "${remote}" to fetch the base branch from` };
  }
  const named = { name: remote, url };
  const ref = `${FETCHED_REF_PREFIX}${branch}`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
  const anonymous = anonymousFetchArgs(repoRoot);
  const reasons = [];
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      execFileSync(
        "git",
        [
          ...anonymous,
          "fetch",
          "--depth=1",
          "--no-tags",
          "--no-write-fetch-head",
          "--quiet",
          remote,
          `+refs/heads/${branch}:${ref}`,
        ],
        { cwd: repoRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL" },
      );
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return { ok: true, ref, attempts: attempt };
    } catch (err) {
      reasons.push(
        err?.code === "ETIMEDOUT" || (err?.signal && err?.status === null)
          ? `timed out after ${timeoutMs / 1000} s`
          : gitSaid(err, named),
      );
    }
  }
  return {
    ok: false,
    attempts: FETCH_ATTEMPTS,
    reason:
      `fetching the branch "${branch}" from the remote "${remote}" failed after ${FETCH_ATTEMPTS} attempts ` +
      `(${reasons.join("; ")}; ` +
      (remoteAddressHoldsUserPart(url)
        ? "the remote's address holds a user part and is not printed)"
        : `the remote's address is ${url})`),
  };
}

function refResolves(repoRoot, ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the base is, for one gate.
 * Returns `{ kind: "ref", ref, source }`, `{ kind: "none" }` (no pull request,
 * no base named) or `{ kind: "invalid", reason }` (fail closed).
 */
export function resolveFloorBase(envVar, env = process.env) {
  const own = envVar ? env[envVar] : undefined;
  if (typeof own === "string" && own !== "") {
    if (own.startsWith("-")) return { kind: "invalid", reason: `${envVar}="${own}" is flag-like` };
    return { kind: "ref", ref: own, source: envVar };
  }
  const branch = env[PULL_REQUEST_BASE_VAR];
  if (typeof branch === "string" && branch !== "") {
    if (!isBranchName(branch)) {
      return { kind: "invalid", reason: `${PULL_REQUEST_BASE_VAR}="${branch}" is not a branch name` };
    }
    return { kind: "ref", ref: `origin/${branch}`, source: PULL_REQUEST_BASE_VAR };
  }
  if (PULL_REQUEST_EVENTS.has(env[EVENT_NAME_VAR])) {
    return {
      kind: "invalid",
      reason: `the run is a pull request's (${EVENT_NAME_VAR}=${env[EVENT_NAME_VAR]}) but ${PULL_REQUEST_BASE_VAR} is empty`,
    };
  }
  return { kind: "none" };
}

function unresolvedReason(ref) {
  return `the base "${ref}" did not resolve (a shallow checkout, or the base branch was not fetched)`;
}

/**
 * The text of `path` (repo-relative, forward slashes) at `ref`.
 * Returns `{ ok: true, text }` or `{ ok: false, reason }`.
 */
export function readFileAtBase(repoRoot, ref, path) {
  if (!refResolves(repoRoot, ref)) return { ok: false, reason: unresolvedReason(ref) };
  try {
    const text = execFileSync("git", ["show", `${ref}:${path}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, text };
  } catch {
    return { ok: false, reason: `${path} is not on the base "${ref}"` };
  }
}

/**
 * Compare one gate's floor with the base.
 *
 * @param {object} o
 * @param {string} o.gate       the gate's name, the prefix of every line
 * @param {string} [o.envVar]   the gate's own base variable, when a workflow sets one
 * @param {string} o.floorPath  the floor file, repo-relative
 * @param {*} o.headFloor       the floor the gate reads from the checkout (the gate's own shape)
 * @param {(text: string) => *} o.parse  base text -> the same shape; throws when the text is not a floor
 * @param {(baseFloor: *, headFloor: *) => string[]} o.grown  one line per growth, empty when the floor held
 * @param {string} o.repoRoot   where git runs
 * @param {object} [o.env]      the environment (default: the process's)
 * @param {object} [o.permits]  the record road of a register that grows after
 *   a review (see `checkPermits`): `{ path, list, rowKey, keyOfGrowth, rowsOf,
 *   road }`. A growth line whose row the head's permits file records is
 *   absorbed, with a NOTICE line.
 * @returns {{ status: "no-base"|"held"|"grew"|"unreadable", ok: boolean, lines: string[], ref?: string, baseFloor?: *, growth?: string[] }}
 */
export function compareFloorWithBase({ gate, envVar, floorPath, headFloor, parse, grown, repoRoot, env = process.env, permits }) {
  const where = resolveFloorBase(envVar, env);
  if (where.kind === "none") {
    return {
      status: "no-base",
      ok: true,
      lines: [
        `[${gate}] floor base guard: no pull request and no base named` +
          `${envVar ? ` (${envVar} unset)` : ""} — ${floorPath} is not compared with a base on this run.`,
      ],
    };
  }
  const unreadable = (reason, ref) => ({
    status: "unreadable",
    ok: false,
    ref,
    lines: [`[${gate}] FAIL — the floor ${floorPath} cannot be compared with the base: ${reason}. Failing closed.`],
  });
  if (where.kind === "invalid") return unreadable(where.reason);

  // A base that is not in the checkout: the pull request's base branch is
  // fetched, one commit deep; a base named by the gate's own variable is not.
  let ref = where.ref;
  let fetched;
  let said = `the base "${where.ref}"`;
  if (!refResolves(repoRoot, where.ref)) {
    if (where.source !== PULL_REQUEST_BASE_VAR) return unreadable(unresolvedReason(where.ref), where.ref);
    if (env[FETCH_SWITCH_VAR] === "0") {
      return unreadable(
        `${unresolvedReason(where.ref)}; fetching the base is switched off (${FETCH_SWITCH_VAR}=0)`,
        where.ref,
      );
    }
    const branch = env[PULL_REQUEST_BASE_VAR];
    const got = fetchBaseBranch({ repoRoot, remote: BASE_REMOTE, branch });
    if (!got.ok) return unreadable(`${unresolvedReason(where.ref)}, and ${got.reason}`, where.ref);
    ref = got.ref;
    fetched = { remote: BASE_REMOTE, branch };
    said = `the base "${where.ref}" (fetched one commit deep from the remote "${BASE_REMOTE}")`;
  }

  const read = readFileAtBase(repoRoot, ref, floorPath);
  if (!read.ok) return { ...unreadable(read.reason, ref), ...(fetched ? { fetched } : {}) };
  let baseFloor;
  try {
    baseFloor = parse(read.text);
  } catch (err) {
    return {
      ...unreadable(`the copy on "${ref}" is not a readable floor (${err?.message ?? err})`, ref),
      ...(fetched ? { fetched } : {}),
    };
  }
  let growth = grown(baseFloor, headFloor);
  if (permits) {
    const road = applyPermits({ permits, growth, headFloor, repoRoot, ref });
    if (!road.ok) return { ...unreadable(road.reason, ref), ...(fetched ? { fetched } : {}) };
    const extra = { absorbed: road.absorbed, permitProblems: road.problems };
    if (road.remaining.length > 0 || road.problems.length > 0) {
      return {
        status: "grew",
        ok: false,
        ref,
        ...(fetched ? { fetched } : {}),
        baseFloor,
        growth: road.remaining,
        ...extra,
        lines: [
          ...(road.remaining.length > 0
            ? [
                `[${gate}] FAIL — the register ${floorPath} GREW against ${said} ` +
                  `without a record for each added row in ${permits.path}:`,
                ...road.remaining.map((g) => `  + ${g}`),
              ]
            : []),
          ...(road.problems.length > 0
            ? [`[${gate}] FAIL — the records in ${permits.path} do not hold against ${said}:`, ...road.problems.map((p) => `  ! ${p}`)]
            : []),
          `[${gate}] ${permits.road}`,
        ],
      };
    }
    return {
      status: "held",
      ok: true,
      ref,
      ...(fetched ? { fetched } : {}),
      baseFloor,
      growth: [],
      ...extra,
      lines: [`[${gate}] floor base guard: ${floorPath} does not grow against ${said}.`, ...road.notices.map((n) => `[${gate}] NOTICE — ${n}`)],
    };
  }
  if (growth.length > 0) {
    return {
      status: "grew",
      ok: false,
      ref,
      ...(fetched ? { fetched } : {}),
      baseFloor,
      growth,
      lines: [
        `[${gate}] FAIL — the floor ${floorPath} GREW against ${said} ` +
          `(a floor only shrinks; no pull request raises it in its own change):`,
        ...growth.map((g) => `  + ${g}`),
      ],
    };
  }
  return {
    status: "held",
    ok: true,
    ref,
    ...(fetched ? { fetched } : {}),
    baseFloor,
    growth,
    lines: [`[${gate}] floor base guard: ${floorPath} does not grow against ${said}.`],
  };
}

/**
 * Print a guard result: the pass lines to stdout, the failure lines to
 * stderr. Returns `result.ok`.
 */
export function reportFloorGuard(result, out = console) {
  for (const line of result.lines) (result.ok ? out.log : out.error)(line);
  return result.ok;
}

/** Keys of `head` that are not in `base` (both iterables of strings), sorted. */
export function newKeys(base, head) {
  const known = new Set(base);
  return [...new Set(head)].filter((k) => !known.has(k)).sort();
}

/**
 * Growth of a count map `{ key: count }`: a new key or a raised count, as
 * `key (base -> head)` lines, sorted.
 */
export function raisedCounts(base, head) {
  const out = [];
  for (const [k, c] of Object.entries(head ?? {})) {
    const b = Object.prototype.hasOwnProperty.call(base ?? {}, k) ? base[k] : 0;
    if (c > b) out.push(`${k} (${b} -> ${c})`);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// The record road (cinatra#3832): a register that grows after a review.
//
// Some guarded lists are registers of things allowed after a review, not
// floors of faults (the system writers' manifest, the set of system
// extensions). A row added to such a register passes in the pull request that
// carries it, WITH ITS RECORD in the register's permits file:
//   - a row the head adds passes when the head's permits file holds a record
//     for exactly that row, written in the same change (or, for a raised count,
//     updated in it); the gate prints one NOTICE line per absorbed addition,
//     naming the row, the reason and the pull request;
//   - a row added without its record fails; the refusal names the permits file
//     and the record's form;
//   - a record for a row the register does not hold at the head is an orphan
//     and fails; a record for a row that was not added in the change and that
//     the base did not record fails the same way (a record annotates an
//     addition);
//   - a record whose row stands on the register is carried forward UNCHANGED
//     while its row stands (an altered or a deleted record with its row still
//     on the register fails), and it goes when its row goes;
//   - a permits file that does not parse, or a record that is not well formed,
//     fails the gate on a pull request's run. An absent permits file holds no
//     records.
//
// The file form: { "note": "...", "permits": [ { "list", "row", "reason", "pr" } ] }
// where `list` names the register, `row` the exact row (the register's own
// form), `reason` is a sentence (at least six words of three letters or more,
// at least four of them different) and `pr` the number of the pull request
// that carries the addition.
// ---------------------------------------------------------------------------

const PERMIT_KEYS = ["list", "pr", "reason", "row"];

/** A record's reason: at least this many words of three letters or more ... */
export const PERMIT_REASON_MIN_WORDS = 6;

/** ... and at least this many different ones. */
export const PERMIT_REASON_MIN_DISTINCT = 4;

/** True when `reason` is a sentence by the record's rule. */
export function isPermitReason(reason) {
  if (typeof reason !== "string") return false;
  const words = reason
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ""))
    .filter((w) => w.length >= 3);
  return words.length >= PERMIT_REASON_MIN_WORDS && new Set(words).size >= PERMIT_REASON_MIN_DISTINCT;
}

/**
 * A permits file's text -> `[{ key, permit }]`, one per record, for the
 * register `list`; `rowKey(row)` gives the row's key and throws when the row
 * is not a row of that register. Throws when the file or a record is not well
 * formed.
 */
export function parsePermits(text, { list, rowKey }) {
  const doc = JSON.parse(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not a permits file object");
  if (!Array.isArray(doc.permits)) throw new Error('"permits" is not a list');
  const out = [];
  const seen = new Set();
  doc.permits.forEach((p, i) => {
    const at = `record ${i + 1}`;
    if (p === null || typeof p !== "object" || Array.isArray(p)) throw new Error(`${at} is not an object`);
    if (Object.keys(p).sort().join() !== PERMIT_KEYS.join()) throw new Error(`${at} must carry exactly list, row, reason and pr`);
    if (p.list !== list) throw new Error(`${at} names the list ${JSON.stringify(p.list)}, not "${list}"`);
    if (!isPermitReason(p.reason)) {
      throw new Error(
        `${at} needs a reason of at least ${PERMIT_REASON_MIN_WORDS} words of three letters or more, ` +
          `at least ${PERMIT_REASON_MIN_DISTINCT} of them different`,
      );
    }
    if (!(Number.isInteger(p.pr) && p.pr > 0)) throw new Error(`${at}: "pr" must be the pull request's number`);
    let key;
    try {
      key = rowKey(p.row);
    } catch (err) {
      throw new Error(`${at}: the row is not a row of "${list}" (${err?.message ?? err})`);
    }
    if (seen.has(key)) throw new Error(`${at} repeats the row ${key}`);
    seen.add(key);
    out.push({ key, permit: p });
  });
  return out;
}

const samePermit = (a, b) =>
  a.list === b.list && a.reason === b.reason && a.pr === b.pr && JSON.stringify(a.row) === JSON.stringify(b.row);

/**
 * The record road's verdict. `growthKeys` are the rows the head adds (or
 * raises) against the base; `headRows` the rows on the register at the head.
 * Returns `{ absorbed, problems, notices }`: `absorbed` the growth keys whose
 * record the head holds, `problems` one line per broken rule.
 */
export function checkPermits({ basePermits, headPermits, headRows, growthKeys }) {
  const baseBy = new Map(basePermits.map((e) => [e.key, e.permit]));
  const headBy = new Map(headPermits.map((e) => [e.key, e.permit]));
  const onHead = new Set(headRows);
  const grown = new Set(growthKeys);
  const absorbed = [];
  const problems = [];
  const notices = [];
  for (const key of [...grown].sort()) {
    const headPermit = headBy.get(key);
    const basePermit = baseBy.get(key);
    if (headPermit && !(basePermit && samePermit(basePermit, headPermit))) {
      absorbed.push(key);
      notices.push(`ADDITION ABSORBED: ${key}, reason: "${headPermit.reason}", pull request #${headPermit.pr}`);
    } else if (headPermit) {
      problems.push(`${key}: grows on a record carried from the base; update the record for this change`);
    }
  }
  for (const key of [...new Set([...headBy.keys(), ...baseBy.keys()])].sort()) {
    if (grown.has(key)) continue;
    const headPermit = headBy.get(key);
    const basePermit = baseBy.get(key);
    if (headPermit && !onHead.has(key)) {
      problems.push(`${key}: orphan record, the register does not hold its row; remove the record`);
    } else if (headPermit && !basePermit) {
      problems.push(`${key}: a record annotates an addition, and this change does not add the row`);
    } else if (headPermit && !samePermit(basePermit, headPermit)) {
      problems.push(`${key}: the record is altered while its row stands; carry it unchanged`);
    } else if (!headPermit && onHead.has(key)) {
      problems.push(`${key}: the record is deleted while its row stands; carry it unchanged`);
    }
  }
  return { absorbed, problems, notices };
}

/** The permit file at the base: absent holds none; present must parse. */
function readPermitsAtBase(repoRoot, ref, permits) {
  let listed = "";
  try {
    listed = execFileSync("git", ["ls-tree", "--name-only", ref, "--", permits.path], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return { ok: false, reason: `the permit file ${permits.path} cannot be listed on the base "${ref}"` };
  }
  if (listed === "") return { ok: true, permits: [] };
  const read = readFileAtBase(repoRoot, ref, permits.path);
  if (!read.ok) return read;
  try {
    return { ok: true, permits: parsePermits(read.text, permits) };
  } catch (err) {
    return { ok: false, reason: `the permit file ${permits.path} on "${ref}" is not readable (${err?.message ?? err})` };
  }
}

/** The permit file in the checkout: absent holds none; present must parse. */
function readPermitsInCheckout(repoRoot, permits) {
  const abs = join(repoRoot, permits.path);
  if (!existsSync(abs)) return { ok: true, permits: [] };
  try {
    return { ok: true, permits: parsePermits(readFileSync(abs, "utf8"), permits) };
  } catch (err) {
    return { ok: false, reason: `the permit file ${permits.path} is not readable (${err?.message ?? err})` };
  }
}

function applyPermits({ permits, growth, headFloor, repoRoot, ref }) {
  const base = readPermitsAtBase(repoRoot, ref, permits);
  if (!base.ok) return base;
  const head = readPermitsInCheckout(repoRoot, permits);
  if (!head.ok) return head;
  const keyed = growth.map((line) => ({ line, key: permits.keyOfGrowth(line) }));
  const verdict = checkPermits({
    basePermits: base.permits,
    headPermits: head.permits,
    headRows: permits.rowsOf(headFloor),
    growthKeys: keyed.map((g) => g.key),
  });
  const absorbed = new Set(verdict.absorbed);
  return {
    ok: true,
    remaining: keyed.filter((g) => !absorbed.has(g.key)).map((g) => g.line),
    absorbed: verdict.absorbed,
    problems: verdict.problems,
    notices: verdict.notices,
  };
}
