// Tests for the shared floor base guard (cinatra#3832): a gate's committed
// floor is compared with the copy on the base branch, failing closed.
//
// Every comparison runs against a real git fixture (a base commit published as
// origin/main and a head commit on top), never against a mocked git.

import { afterEach, describe, expect, it } from "vitest";
import {
  compareFloorWithBase,
  newKeys,
  raisedCounts,
  readFileAtBase,
  reportFloorGuard,
  resolveFloorBase,
} from "../lib/floor-base-guard.mjs";
import {
  NO_PULL_REQUEST_RUN,
  PULL_REQUEST_RUN,
  UNREADABLE_BASE_RUN,
  makeFloorRepo,
} from "./floor-base-fixture.mjs";

const FLOOR = "scripts/audit/demo.floor.json";
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
