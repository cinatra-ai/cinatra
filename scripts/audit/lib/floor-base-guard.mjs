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
// fetch needs no credential, and the guard adds none and reads none (no
// credential helper, no prompt). A remote address with a user part is never
// printed; the remote is then named by its name only. A fetch that fails fails
// the gate with its reason. A base in the checkout already is read as before,
// with nothing fetched. A base named by the gate's own variable is a revision
// the workflow chose and fetched itself: it is never fetched here.
// FLOOR_BASE_FETCH=0 switches the fetch off (a missing base then fails closed
// as before); the tests that run a gate in the real checkout use it.
//
// Node builtins only; the one external program is `git`.

import { execFileSync } from "node:child_process";

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
  const reasons = [];
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      execFileSync(
        "git",
        [
          "-c",
          "credential.helper=",
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

/**
 * The text of `path` (repo-relative, forward slashes) at `ref`.
 * Returns `{ ok: true, text }` or `{ ok: false, reason }`.
 */
function unresolvedReason(ref) {
  return `the base "${ref}" did not resolve (a shallow checkout, or the base branch was not fetched)`;
}

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
 * @returns {{ status: "no-base"|"held"|"grew"|"unreadable", ok: boolean, lines: string[], ref?: string, baseFloor?: *, growth?: string[] }}
 */
export function compareFloorWithBase({ gate, envVar, floorPath, headFloor, parse, grown, repoRoot, env = process.env }) {
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
  const growth = grown(baseFloor, headFloor);
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
