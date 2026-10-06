// A git fixture for the floor base guard tests (cinatra#3832): a temporary
// repository with a BASE commit (published as the remote branch origin/main,
// the way a pull request's checkout sees its base) and a HEAD commit on top.
//
// Node builtins only, so the node:test suites can use it as well as the
// vitest ones. Every git call runs with the user's hooks and signing switched
// off, so the fixture never depends on the machine's git configuration.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(root, args) {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
    { cwd: root, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  }
}

/**
 * Build the fixture. `base` and `head` map repo-relative paths to file
 * contents (a string, or a value written as JSON). The head commit holds the
 * base files overlaid by `head`. Returns `{ root, cleanup }`.
 */
export function makeFloorRepo({ base, head }) {
  const root = mkdtempSync(join(tmpdir(), "floor-base-guard-"));
  git(root, ["init", "-q"]);
  writeFiles(root, base);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  writeFiles(root, head);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "head"]);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * A checkout of ONE commit, the way a workflow's default checkout sees a pull
 * request: a temporary BARE repository is the remote (`origin`), its `main`
 * holds the base files and its `pr` branch the head files on top; the checkout
 * is `git clone --depth=1 --single-branch --branch pr` of it, so `origin/main`
 * is NOT in the checkout and the guard has to fetch its base. Returns
 * `{ root, bare, cleanup }` (`root` is the checkout).
 */
export function makeOneCommitCheckout({ base, head }) {
  const top = mkdtempSync(join(tmpdir(), "floor-base-remote-"));
  const work = join(top, "work");
  const bare = join(top, "remote.git");
  const root = join(top, "checkout");
  mkdirSync(work);
  git(work, ["init", "-q"]);
  writeFiles(work, base);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "base"]);
  git(work, ["checkout", "-q", "-b", "pr"]);
  writeFiles(work, head);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "--allow-empty", "-m", "head"]);
  git(top, ["init", "-q", "--bare", bare]);
  git(work, ["push", "-q", bare, "main", "pr"]);
  git(top, ["clone", "-q", "--depth=1", "--single-branch", "--branch", "pr", pathToFileURL(bare).href, root]);
  return { root, bare, cleanup: () => rmSync(top, { recursive: true, force: true }) };
}

/** Run git in a fixture directory (the fixture's own configuration). */
export function fixtureGit(root, args) {
  return git(root, args);
}

/**
 * Count the git processes a call starts: a `git` on the front of PATH logs
 * its arguments (one line per process) and runs the real git. `fn` runs with
 * that PATH; returns `{ result, calls }` where `calls` are the logged lines.
 */
export function withGitSpy(fn) {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(join(tmpdir(), "floor-base-git-spy-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const spy = join(dir, "git");
  writeFileSync(spy, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
  chmodSync(spy, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
  try {
    const result = fn();
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    return { result, calls };
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A pull request's run against the fixture: its base branch is main. */
export const PULL_REQUEST_RUN = Object.freeze({ GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" });

/**
 * A pull request's run whose base branch cannot be read. The fetch is
 * switched off, so a test that runs a gate in the real checkout never reaches
 * the network; the base then fails closed as it did before the fetch.
 */
export const UNREADABLE_BASE_RUN = Object.freeze({
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_BASE_REF: "no-such-base-3832",
  FLOOR_BASE_FETCH: "0",
});

/** A run that is no pull request (a push to the default branch, a local run). */
export const NO_PULL_REQUEST_RUN = Object.freeze({ GITHUB_EVENT_NAME: "push" });

/** The environment without any base variable, for spawning a gate on a synthetic floor. */
export function envWithoutBase(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (k === "GITHUB_BASE_REF" || k === "GITHUB_EVENT_NAME" || /_BASE$/.test(k)) delete out[k];
  }
  return out;
}
