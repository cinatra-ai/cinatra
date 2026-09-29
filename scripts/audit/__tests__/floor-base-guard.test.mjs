// Tests for the shared floor base guard (cinatra#3832): a gate's committed
// floor is compared with the copy on the base branch, failing closed.
//
// Every comparison runs against a real git fixture (a base commit published as
// origin/main and a head commit on top), never against a mocked git.

import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  FETCHED_REF_PREFIX,
  FETCH_ATTEMPTS,
  FETCH_SWITCH_VAR,
  FETCH_TIMEOUT_MS,
  compareFloorWithBase,
  fetchBaseBranch,
  isBranchName,
  newKeys,
  raisedCounts,
  readFileAtBase,
  redactRemote,
  remoteAddressHoldsUserPart,
  reportFloorGuard,
  resolveFloorBase,
} from "../lib/floor-base-guard.mjs";
import {
  NO_PULL_REQUEST_RUN,
  PULL_REQUEST_RUN,
  UNREADABLE_BASE_RUN,
  fixtureGit,
  makeFloorRepo,
  makeOneCommitCheckout,
  withGitSpy,
} from "./floor-base-fixture.mjs";

const FLOOR = "scripts/audit/demo.floor.json";

// An address with a user part and a fake password, assembled at run time so
// the repository's secret scan never sees a credential address in the source.
const withUserPart = (user, pass, rest) => `https://${[user, pass].filter(Boolean).join(":")}@${rest}`;
const fixtures = [];
afterEach(() => {
  while (fixtures.length) fixtures.pop().cleanup();
});

function repo(baseCounts, headCounts) {
  const f = makeFloorRepo({ base: { [FLOOR]: { counts: baseCounts } }, head: { [FLOOR]: { counts: headCounts } } });
  fixtures.push(f);
  return f.root;
}

const compare = (root, headCounts, env, envVar = "DEMO_FLOOR_BASE") =>
  compareFloorWithBase({
    gate: "demo-gate",
    envVar,
    floorPath: FLOOR,
    headFloor: headCounts,
    parse: (text) => JSON.parse(text).counts,
    grown: raisedCounts,
    repoRoot: root,
    env,
  });

describe("resolveFloorBase — where the base comes from", () => {
  it("takes the gate's own variable first, then the pull request's base branch read as the remote branch", () => {
    expect(resolveFloorBase("DEMO_FLOOR_BASE", { DEMO_FLOOR_BASE: "abc123", GITHUB_BASE_REF: "main" })).toEqual({
      kind: "ref",
      ref: "abc123",
      source: "DEMO_FLOOR_BASE",
    });
    expect(resolveFloorBase("DEMO_FLOOR_BASE", { GITHUB_BASE_REF: "main" })).toEqual({
      kind: "ref",
      ref: "origin/main",
      source: "GITHUB_BASE_REF",
    });
    // An empty own variable is unset, not a base.
    expect(resolveFloorBase("DEMO_FLOOR_BASE", { DEMO_FLOOR_BASE: "", GITHUB_BASE_REF: "main" }).ref).toBe("origin/main");
  });

  it("is no base on a run that is no pull request", () => {
    expect(resolveFloorBase("DEMO_FLOOR_BASE", {})).toEqual({ kind: "none" });
    expect(resolveFloorBase("DEMO_FLOOR_BASE", { GITHUB_EVENT_NAME: "push" })).toEqual({ kind: "none" });
    expect(resolveFloorBase(undefined, { GITHUB_EVENT_NAME: "merge_group" })).toEqual({ kind: "none" });
  });

  it("fails closed on a flag-like or malformed reference, and on a pull request's run without a base branch", () => {
    expect(resolveFloorBase("DEMO_FLOOR_BASE", { DEMO_FLOOR_BASE: "--output=x" }).kind).toBe("invalid");
    expect(resolveFloorBase("DEMO_FLOOR_BASE", { GITHUB_BASE_REF: "-x" }).kind).toBe("invalid");
    expect(resolveFloorBase("DEMO_FLOOR_BASE", { GITHUB_BASE_REF: "main..x" }).kind).toBe("invalid");
    expect(resolveFloorBase("DEMO_FLOOR_BASE", { GITHUB_BASE_REF: "ma in" }).kind).toBe("invalid");
    const pr = resolveFloorBase("DEMO_FLOOR_BASE", { GITHUB_EVENT_NAME: "pull_request" });
    expect(pr.kind).toBe("invalid");
    expect(pr.reason).toMatch(/GITHUB_BASE_REF is empty/);
  });
});

describe("compareFloorWithBase — against a git fixture", () => {
  it("a raised floor FAILS: a raised count and a new key are growth", () => {
    const head = { a: 3, b: 1 };
    const root = repo({ a: 2 }, head);
    const r = compare(root, head, PULL_REQUEST_RUN);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("grew");
    expect(r.growth).toEqual(["a (2 -> 3)", "b (0 -> 1)"]);
    expect(r.lines[0]).toMatch(/demo-gate\] FAIL — the floor scripts\/audit\/demo\.floor\.json GREW against the base "origin\/main"/);
  });

  it("a lowered floor PASSES: a lowered count and a removed stale key are not growth", () => {
    const head = { a: 1 };
    const root = repo({ a: 2, gone: 4 }, head);
    const r = compare(root, head, PULL_REQUEST_RUN);
    expect(r).toMatchObject({ ok: true, status: "held", ref: "origin/main" });
    expect(r.lines).toHaveLength(1);
  });

  it("the gate's own variable names the base (a push run's previous tip)", () => {
    const head = { a: 3 };
    const root = repo({ a: 2 }, head);
    const r = compare(root, head, { DEMO_FLOOR_BASE: "HEAD~1" });
    expect(r.status).toBe("grew");
    expect(r.ref).toBe("HEAD~1");
  });

  it("a base that cannot be read on a pull request's run FAILS with its reason", () => {
    const head = { a: 1 };
    const root = repo({ a: 2 }, head);
    const r = compare(root, head, UNREADABLE_BASE_RUN);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toMatch(/cannot be compared with the base: the base "origin\/no-such-base-3832" did not resolve/);
    expect(r.lines[0]).toMatch(/Failing closed/);
  });

  it("a floor file that is not on the base, or does not parse there, FAILS with its reason", () => {
    const f = makeFloorRepo({ base: { "README.md": "x\n" }, head: { [FLOOR]: { counts: {} } } });
    fixtures.push(f);
    let r = compare(f.root, {}, PULL_REQUEST_RUN);
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toMatch(/scripts\/audit\/demo\.floor\.json is not on the base "origin\/main"/);

    const g = makeFloorRepo({ base: { [FLOOR]: "{ not json" }, head: { [FLOOR]: { counts: {} } } });
    fixtures.push(g);
    r = compare(g.root, {}, PULL_REQUEST_RUN);
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toMatch(/is not a readable floor/);
  });

  it("no pull request PASSES with its one line, and never reads git", () => {
    const r = compare("/nonexistent-3832", { a: 99 }, NO_PULL_REQUEST_RUN);
    expect(r).toMatchObject({ ok: true, status: "no-base" });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/no pull request and no base named \(DEMO_FLOOR_BASE unset\)/);
  });

  it("readFileAtBase reads the base copy of a file", () => {
    const f = makeFloorRepo({ base: { [FLOOR]: "base\n" }, head: { [FLOOR]: "head\n" } });
    fixtures.push(f);
    expect(readFileAtBase(f.root, "origin/main", FLOOR)).toEqual({ ok: true, text: "base\n" });
  });
});

describe("growth meanings and printing", () => {
  it("newKeys is the set difference, raisedCounts a new key or a raised count", () => {
    expect(newKeys(["a", "b"], ["b", "c", "c"])).toEqual(["c"]);
    expect(newKeys(["a", "b"], ["a"])).toEqual([]);
    expect(raisedCounts({ a: 2 }, { a: 2, b: 0 })).toEqual([]);
    expect(raisedCounts({ a: 2 }, { a: 1 })).toEqual([]);
  });

  it("reportFloorGuard prints a pass to stdout and a failure to stderr", () => {
    const out = { log: [], error: [] };
    const sink = { log: (l) => out.log.push(l), error: (l) => out.error.push(l) };
    expect(reportFloorGuard({ ok: true, lines: ["fine"] }, sink)).toBe(true);
    expect(reportFloorGuard({ ok: false, lines: ["bad", "  + x"] }, sink)).toBe(false);
    expect(out).toEqual({ log: ["fine"], error: ["bad", "  + x"] });
  });
});

// A base that is already in the checkout is read as before: no fetch, and the
// same lines, byte for byte.
describe("a base in the checkout — nothing is fetched", () => {
  it("answers as before, with no git fetch", () => {
    const head = { a: 3 };
    let root = repo({ a: 2 }, head);
    let { result: r, calls } = withGitSpy(() => compare(root, head, PULL_REQUEST_RUN));
    expect(calls.filter((c) => /(^| )fetch /.test(c))).toEqual([]);
    expect(Object.keys(r).sort()).toEqual(["baseFloor", "growth", "lines", "ok", "ref", "status"]);
    expect(r.lines).toEqual([
      '[demo-gate] FAIL — the floor scripts/audit/demo.floor.json GREW against the base "origin/main" ' +
        "(a floor only shrinks; no pull request raises it in its own change):",
      "  + a (2 -> 3)",
    ]);

    root = repo({ a: 2 }, { a: 1 });
    ({ result: r, calls } = withGitSpy(() => compare(root, { a: 1 }, PULL_REQUEST_RUN)));
    expect(calls.filter((c) => /(^| )fetch /.test(c))).toEqual([]);
    expect(r.lines).toEqual([
      '[demo-gate] floor base guard: scripts/audit/demo.floor.json does not grow against the base "origin/main".',
    ]);
  });
});

// cinatra#3832, the second leg: a workflow whose checkout takes ONE commit has
// no base branch in it. The guard fetches the base branch itself, one commit
// deep, from the checkout's own remote, into a reference of its own.
describe("the base fetched in a checkout of one commit", () => {
  function checkout(baseCounts, headCounts) {
    const f = makeOneCommitCheckout({
      base: { [FLOOR]: { counts: baseCounts } },
      head: { [FLOOR]: { counts: headCounts } },
    });
    fixtures.push(f);
    return f;
  }
  const refsOf = (root) =>
    fixtureGit(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).trim().split("\n").sort();
  const fetchCalls = (calls) => calls.filter((c) => /(^| )fetch /.test(c));

  it("the fixture is a checkout of one commit without the base branch", () => {
    const f = checkout({ a: 2 }, { a: 3 });
    expect(() => fixtureGit(f.root, ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"])).toThrow();
    expect(fixtureGit(f.root, ["rev-parse", "--is-shallow-repository"]).trim()).toBe("true");
  });

  it("fetches the base one commit deep into a reference of its own and FAILS a raised floor", () => {
    const f = checkout({ a: 2 }, { a: 3 });
    const before = refsOf(f.root);
    const { result: r, calls } = withGitSpy(() => compare(f.root, { a: 3 }, PULL_REQUEST_RUN));
    expect(r.ok).toBe(false);
    expect(r.status).toBe("grew");
    expect(r.growth).toEqual(["a (2 -> 3)"]);
    expect(r.ref).toBe(`${FETCHED_REF_PREFIX}main`);
    expect(r.fetched).toEqual({ remote: "origin", branch: "main" });
    expect(r.lines[0]).toBe(
      '[demo-gate] FAIL — the floor scripts/audit/demo.floor.json GREW against the base "origin/main" ' +
        '(fetched one commit deep from the remote "origin") ' +
        "(a floor only shrinks; no pull request raises it in its own change):",
    );
    const fetches = fetchCalls(calls);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatch(/ fetch --depth=1 --no-tags /);
    expect(fetches[0]).toContain(`origin +refs/heads/main:${FETCHED_REF_PREFIX}main`);
    // No branch of the checkout was written; only the guard's own reference.
    expect(refsOf(f.root)).toEqual(before);
    expect(fixtureGit(f.root, ["for-each-ref", "--format=%(refname)", FETCHED_REF_PREFIX]).trim()).toBe(
      `${FETCHED_REF_PREFIX}main`,
    );
  });

  it("a lowered floor PASSES after the fetch", () => {
    const f = checkout({ a: 2, gone: 1 }, { a: 1 });
    const r = compare(f.root, { a: 1 }, PULL_REQUEST_RUN);
    expect(r).toMatchObject({ ok: true, status: "held", ref: `${FETCHED_REF_PREFIX}main` });
    expect(r.lines).toEqual([
      '[demo-gate] floor base guard: scripts/audit/demo.floor.json does not grow against the base "origin/main" ' +
        '(fetched one commit deep from the remote "origin").',
    ]);
  });

  it("a remote that does not answer FAILS the gate with its reason after two attempts", () => {
    const f = checkout({ a: 2 }, { a: 1 });
    fixtureGit(f.root, ["remote", "set-url", "origin", `${f.bare}-no-such-remote-3832`]);
    const { result: r, calls } = withGitSpy(() => compare(f.root, { a: 1 }, PULL_REQUEST_RUN));
    expect(r.ok).toBe(false);
    expect(r.status).toBe("unreadable");
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/cannot be compared with the base: the base "origin\/main" did not resolve/);
    expect(r.lines[0]).toMatch(/fetching the branch "main" from the remote "origin" failed after 2 attempts/);
    expect(r.lines[0]).toMatch(/Failing closed\.$/);
    expect(fetchCalls(calls)).toHaveLength(FETCH_ATTEMPTS);
    expect(FETCH_ATTEMPTS).toBe(2);
  });

  it("a base branch name of a wrong form FAILS before any git process starts", () => {
    const f = checkout({ a: 2 }, { a: 1 });
    for (const name of ["-x", "--upload-pack=x", "main..x", "ma in", "main:refs/heads/x", "a*"]) {
      const { result: r, calls } = withGitSpy(() =>
        compare(f.root, { a: 1 }, { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: name }),
      );
      expect(r.status, name).toBe("unreadable");
      expect(r.lines[0], name).toMatch(/is not a branch name/);
      expect(calls, name).toEqual([]);
    }
    const { result, calls } = withGitSpy(() => fetchBaseBranch({ repoRoot: f.root, remote: "origin", branch: "-x" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/is not a branch name/);
    expect(calls).toEqual([]);
  });

  it("isBranchName takes letters, digits, dot, dash, underscore and slash, no leading dash and no '..'", () => {
    for (const ok of ["main", "release/1.2", "feature_x-y", "a/b/c"]) expect(isBranchName(ok), ok).toBe(true);
    for (const bad of ["", "-main", "a..b", "a b", "a:b", "a*", "a~1", "a^", "a@{1}", "a\\b", 7, undefined]) {
      expect(isBranchName(bad), String(bad)).toBe(false);
    }
  });

  it("with the fetch switched off, a missing base FAILS closed without a fetch", () => {
    const f = checkout({ a: 2 }, { a: 1 });
    const { result: r, calls } = withGitSpy(() =>
      compare(f.root, { a: 1 }, { ...PULL_REQUEST_RUN, [FETCH_SWITCH_VAR]: "0" }),
    );
    expect(r.status).toBe("unreadable");
    expect(r.lines[0]).toMatch(/did not resolve .*fetching the base is switched off \(FLOOR_BASE_FETCH=0\)/);
    expect(fetchCalls(calls)).toEqual([]);
  });

  it("a base named by the gate's own variable is never fetched", () => {
    const f = checkout({ a: 2 }, { a: 1 });
    const { result: r, calls } = withGitSpy(() => compare(f.root, { a: 1 }, { DEMO_FLOOR_BASE: "origin/main" }));
    expect(r.status).toBe("unreadable");
    expect(r.lines).toEqual([
      "[demo-gate] FAIL — the floor scripts/audit/demo.floor.json cannot be compared with the base: " +
        'the base "origin/main" did not resolve (a shallow checkout, or the base branch was not fetched). Failing closed.',
    ]);
    expect(fetchCalls(calls)).toEqual([]);
  });

  it("a remote whose address holds a user part is named by its name only in every printed line", () => {
    const secret = withUserPart("someone", "pw-3832", "example.invalid/remote.git");
    const f = checkout({ a: 2 }, { a: 3 });
    fixtureGit(f.root, ["remote", "set-url", "origin", secret]);
    // The address is rewritten to the local bare repository, so no network is used.
    fixtureGit(f.root, ["config", `url.${pathToFileURL(f.bare).href}.insteadOf`, secret]);
    let r = compare(f.root, { a: 3 }, PULL_REQUEST_RUN);
    expect(r.status).toBe("grew");
    let text = r.lines.join("\n");
    expect(text).toContain('the remote "origin"');
    expect(text).not.toMatch(/someone|pw-3832|example\.invalid/);

    fixtureGit(f.root, ["config", "--unset-all", `url.${pathToFileURL(f.bare).href}.insteadOf`]);
    fixtureGit(f.root, ["config", `url.${pathToFileURL(`${f.bare}-gone`).href}.insteadOf`, secret]);
    r = compare(f.root, { a: 3 }, PULL_REQUEST_RUN);
    expect(r.status).toBe("unreadable");
    text = r.lines.join("\n");
    expect(text).toMatch(/the remote "origin" failed after 2 attempts/);
    expect(text).not.toMatch(/someone|pw-3832|example\.invalid/);
  });

  it("remoteAddressHoldsUserPart and redactRemote keep a credential out of a printed line", () => {
    expect(remoteAddressHoldsUserPart(withUserPart("someone", "pw-3832", "example.invalid/r.git"))).toBe(true);
    expect(remoteAddressHoldsUserPart(withUserPart("token", "", "example.invalid/r.git"))).toBe(true);
    expect(remoteAddressHoldsUserPart("ssh://git@example.invalid/r.git")).toBe(true);
    expect(remoteAddressHoldsUserPart("git@example.invalid:r.git")).toBe(true);
    expect(remoteAddressHoldsUserPart("https://example.invalid/r.git")).toBe(false);
    expect(remoteAddressHoldsUserPart("file:///srv/r.git")).toBe(false);
    expect(remoteAddressHoldsUserPart("/srv/r.git")).toBe(false);

    const url = withUserPart("someone", "pw-3832", "example.invalid/remote.git");
    const other = withUserPart("other", "pw-other", "elsewhere.invalid/x");
    const said = redactRemote(`fatal: unable to access '${url}/': could not resolve host; also ${other}`, {
      name: "origin",
      url,
    });
    expect(said).toContain('the remote "origin"');
    expect(said).toContain("https://elsewhere.invalid/x");
    expect(said).not.toMatch(/someone|pw-3832|other|pw-other/);
  });

  it("a remote that hangs is stopped at the timeout, twice, and FAILS the gate with its reason", () => {
    expect(FETCH_TIMEOUT_MS).toBe(30_000);
    const f = checkout({ a: 2 }, { a: 1 });
    // The ext transport runs a local command in place of a remote: here one
    // that never answers within the (shortened) timeout.
    fixtureGit(f.root, ["config", "protocol.ext.allow", "always"]);
    fixtureGit(f.root, ["remote", "set-url", "origin", "ext::sleep 3"]);
    const started = Date.now();
    const r = fetchBaseBranch({ repoRoot: f.root, remote: "origin", branch: "main", timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.reason).toMatch(/timed out after 0\.3 s/);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
