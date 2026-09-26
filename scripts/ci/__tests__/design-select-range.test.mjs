// THE PULL REQUEST'S OWN RANGE (cinatra#3667).
//
// A pull_request run checks out the pull request's MERGE REF: a merge commit
// whose first parent is the tip of main when that merge was made and whose
// second parent is the pull request's head. The base commit the workflow hands
// the selector is the one the event recorded, frozen when the event fired. Once
// main moves in between (a re-run makes it certain), the merge base of that
// recorded base and HEAD is the recorded base itself, and the range up to HEAD
// carries everything main gained since as well as the pull request's own files.
// A widening file that changed on main (the extension lock, measured) then sent
// a pull request that never touched it to every family and to the time cap.
//
// These tests build that shape as a REAL git repository in a temporary
// directory and drive the selector's own diff resolution over it through its
// injectable git:
//
//   base ──── lock (the new tip of main) ──── merge (HEAD, detached)
//     └────── docs (the pull request head) ──────┘
//
// They pin: a pull_request run reads only the pull request's own commits; a
// merge queue run still reads its recorded base against HEAD; every doubt about
// the head (a checkout that does not merge it, a payload that cannot be read)
// widens to ALL with the reason; an unresolvable base keeps its reason.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { resolveChangedFiles, selectFamilies } from "../design-select.mjs";

const LOCK = "cinatra-dev-extensions.lock.json";
const DOC = "docs/guide.md";

// The fixture's git sees nothing of the machine it runs on: no inherited GIT_*
// variable can point it at another repository, and no user or system setting
// (a hook path, a signing rule, a default branch) applies to its commits.
const FIXTURE_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const IDENTITY = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "design-select-range-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: FIXTURE_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const write = (rel, body) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  };
  const commit = (message) => {
    git(["add", "-A"]);
    git([...IDENTITY, "commit", "-q", "-m", message]);
    return git(["rev-parse", "HEAD"]).trim();
  };

  git(["init", "-q", "-b", "main"]);
  write("README.md", "an ordinary file\n");
  const recordedBase = commit("the base commit the event recorded");

  git(["checkout", "-q", "-b", "feature"]);
  write(DOC, "the pull request's own change\n");
  const prHead = commit("the pull request: one docs file");

  git(["checkout", "-q", "main"]);
  write(LOCK, "{}\n");
  const mainTip = commit("main moves after the fork point: the extension lock");

  // The merge ref as the checkout sees it: main's NEW tip first, the head second.
  git(["checkout", "-q", "--detach", mainTip]);
  git([...IDENTITY, "merge", "-q", "--no-ff", "--no-edit", "-m", "the merge ref", prHead]);
  const mergeRef = git(["rev-parse", "HEAD"]).trim();

  // A later push to the pull request, which this checkout does NOT merge.
  git(["checkout", "-q", "feature"]);
  write("docs/later.md", "a later push\n");
  const laterHead = commit("the pull request, pushed again");
  git(["checkout", "-q", "--detach", mergeRef]);

  // Event payloads live beside the repository, never inside its working tree.
  const payload = (name, body) => {
    const file = join(root, name);
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    return file;
  };
  return { root, git, recordedBase, prHead, mainTip, mergeRef, laterHead, payload };
}

const fixture = buildFixture();
afterAll(() => rmSync(fixture.root, { recursive: true, force: true }));

const short = (sha) => sha.slice(0, 12);

/** A pull_request run in CI, handed its recorded base the way the workflow does. */
const pullRequestEnv = (overrides = {}) => ({
  CI: "true",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_REF_NAME: "42/merge",
  GITHUB_BASE_REF: "main",
  DESIGN_SELECT_DIFF_BASE: fixture.recordedBase,
  GITHUB_EVENT_PATH: fixture.payload("pull-request.json", {
    pull_request: { head: { sha: fixture.prHead }, base: { sha: fixture.recordedBase } },
  }),
  ...overrides,
});

// One family that renders one fixture page: enough to tell a skip, a narrowed
// run and the whole suite apart.
const FAMILIES = new Map([
  [
    "tests/e2e/design/alpha.spec.ts",
    new Set(["tests/e2e/design/alpha.spec.ts", "src/app/design-fixtures/alpha/page.tsx"]),
  ],
]);

describe("the fixture is the measured shape", () => {
  it("merges the pull request head into a main that moved on, and that whole range widens", () => {
    expect(fixture.git(["rev-parse", "HEAD^1"]).trim()).toBe(fixture.mainTip);
    expect(fixture.git(["rev-parse", "HEAD^2"]).trim()).toBe(fixture.prHead);
    const everything = fixture
      .git(["diff", "--name-only", fixture.recordedBase, "HEAD"])
      .split("\n")
      .filter(Boolean);
    expect(everything.sort()).toEqual([LOCK, DOC]);
    expect(selectFamilies({ changedFiles: everything, families: FAMILIES }).mode).toBe("all");
  });
});

describe("a pull_request run reads the pull request's own commits", () => {
  it("stays narrow although main changed the lock after the fork point", () => {
    const diff = resolveChangedFiles({ env: pullRequestEnv(), git: fixture.git });
    expect(diff.mode).toBe("diff");
    expect(diff.files).toEqual([DOC]);
    expect(diff.reason).toContain(`${short(fixture.recordedBase)}..${short(fixture.prHead)}`);
    expect(diff.reason).toContain("the pull request's own commits");
    expect(selectFamilies({ changedFiles: diff.files, families: FAMILIES }).mode).toBe("none");
  });

  it("outside CI, a local dry run keeps reading the checkout itself and needs no payload", () => {
    const diff = resolveChangedFiles({
      env: { GITHUB_EVENT_NAME: "pull_request", DESIGN_SELECT_DIFF_BASE: fixture.recordedBase },
      git: fixture.git,
    });
    expect(diff.mode).toBe("diff");
    expect([...diff.files].sort()).toEqual([LOCK, DOC]);
  });
});

describe("a merge queue run keeps HEAD", () => {
  it("diffs the group's recorded base against HEAD, as before", () => {
    const calls = [];
    const git = (args) => {
      calls.push(args.join(" "));
      return fixture.git(args);
    };
    const diff = resolveChangedFiles({
      env: {
        CI: "true",
        GITHUB_EVENT_NAME: "merge_group",
        GITHUB_REF_NAME: "gh-readonly-queue/main/pr-42-0000000",
        DESIGN_SELECT_DIFF_BASE: fixture.mainTip,
        GITHUB_EVENT_PATH: fixture.payload("merge-group.json", {
          merge_group: { base_sha: fixture.mainTip, head_sha: fixture.mergeRef },
        }),
      },
      git,
    });
    expect(diff.mode).toBe("diff");
    expect(diff.files).toEqual([DOC]);
    expect(calls).toContain(`merge-base ${fixture.mainTip} HEAD`);
    expect(calls).toContain(`diff --name-only ${fixture.mainTip} HEAD`);
  });
});

describe("every doubt about the head widens to ALL, with the reason", () => {
  it("when the checkout merges another head than the one the event names", () => {
    const diff = resolveChangedFiles({
      env: pullRequestEnv({
        GITHUB_EVENT_PATH: fixture.payload("later-head.json", {
          pull_request: { head: { sha: fixture.laterHead } },
        }),
      }),
      git: fixture.git,
    });
    expect(diff.mode).toBe("all");
    expect(diff.reason).toContain(short(fixture.mergeRef));
    expect(diff.reason).toContain(short(fixture.prHead));
    expect(diff.reason).toContain(short(fixture.laterHead));
  });

  it("when the checkout is not a merge commit at all", () => {
    fixture.git(["checkout", "-q", "--detach", fixture.prHead]);
    try {
      const diff = resolveChangedFiles({ env: pullRequestEnv(), git: fixture.git });
      expect(diff.mode).toBe("all");
      expect(diff.reason).toMatch(/not a two-parent merge commit/);
      expect(diff.reason).toContain(short(fixture.prHead));
    } finally {
      fixture.git(["checkout", "-q", "--detach", fixture.mergeRef]);
    }
  });

  it.each([
    ["no event payload path", () => ({ GITHUB_EVENT_PATH: undefined }), /payload is absent/],
    [
      "a payload file that does not exist",
      () => ({ GITHUB_EVENT_PATH: join(fixture.root, "missing.json") }),
      /payload could not be read/,
    ],
    [
      "a payload that is not JSON",
      () => ({ GITHUB_EVENT_PATH: fixture.payload("broken.json", "{ not json") }),
      /payload could not be read/,
    ],
    [
      "a payload that names no head",
      () => ({
        GITHUB_EVENT_PATH: fixture.payload("headless.json", { pull_request: { head: {} } }),
      }),
      /names no pull_request\.head\.sha/,
    ],
  ])("when a CI run has %s", (_label, overrides, reason) => {
    const diff = resolveChangedFiles({ env: pullRequestEnv(overrides()), git: fixture.git });
    expect(diff.mode).toBe("all");
    expect(diff.files).toEqual([]);
    expect(diff.reason).toMatch(reason);
  });
});

describe("an unresolvable recorded base keeps its reason", () => {
  it("widens to ALL with the existing reason, whatever the payload says", () => {
    const missing = "f".repeat(40);
    const diff = resolveChangedFiles({
      env: pullRequestEnv({ DESIGN_SELECT_DIFF_BASE: missing }),
      git: fixture.git,
    });
    expect(diff.mode).toBe("all");
    expect(diff.reason).toBe(`the diff base ${missing} does not resolve in this checkout`);
  });
});
