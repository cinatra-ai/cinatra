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
    if (branch.startsWith("-") || branch.includes("..") || !BRANCH_NAME_RE.test(branch)) {
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
export function readFileAtBase(repoRoot, ref, path) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    return {
      ok: false,
      reason: `the base "${ref}" did not resolve (a shallow checkout, or the base branch was not fetched)`,
    };
  }
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

  const read = readFileAtBase(repoRoot, where.ref, floorPath);
  if (!read.ok) return unreadable(read.reason, where.ref);
  let baseFloor;
  try {
    baseFloor = parse(read.text);
  } catch (err) {
    return unreadable(`the copy on "${where.ref}" is not a readable floor (${err?.message ?? err})`, where.ref);
  }
  const growth = grown(baseFloor, headFloor);
  if (growth.length > 0) {
    return {
      status: "grew",
      ok: false,
      ref: where.ref,
      baseFloor,
      growth,
      lines: [
        `[${gate}] FAIL — the floor ${floorPath} GREW against the base "${where.ref}" ` +
          `(a floor only shrinks; no pull request raises it in its own change):`,
        ...growth.map((g) => `  + ${g}`),
      ],
    };
  }
  return {
    status: "held",
    ok: true,
    ref: where.ref,
    baseFloor,
    growth,
    lines: [`[${gate}] floor base guard: ${floorPath} does not grow against the base "${where.ref}".`],
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
