// The run-scope snapshot (cinatra#2813 S1, epic #2812).
//
// A run's applicable assignment scopes are decided ONCE, at creation, and never
// again. The reason is not tidiness: a thread's project can be changed by a
// person after the fact, so reading scope at delivery time would silently
// re-point a running agent at a different set of assignments. The snapshot is
// therefore versioned, immutable, and — when it is missing or unreadable —
// falls back to the NARROWEST possible answer rather than guessing.
import { describe, expect, it } from "vitest";

import {
  ASSIGNMENT_SCOPE_SNAPSHOT_VERSION,
  AssignmentScopeSnapshotError,
  assignmentScopeFallback,
  buildAssignmentScopeSnapshot,
  parseAssignmentScopeSnapshot,
  readAssignmentScopeSnapshot,
} from "../assignment-scope-snapshot";

const ORG = "org_1";

describe("assignment-scope snapshot — build", () => {
  it("stamps the version", () => {
    const snap = buildAssignmentScopeSnapshot({ orgId: ORG });
    expect(snap.v).toBe(ASSIGNMENT_SCOPE_SNAPSHOT_VERSION);
    expect(ASSIGNMENT_SCOPE_SNAPSHOT_VERSION).toBe(1);
  });

  it("sorts and deduplicates the team ids", () => {
    const snap = buildAssignmentScopeSnapshot({
      orgId: ORG,
      teamIds: ["t_c", "t_a", "t_b", "t_a", " t_b "],
    });
    expect(snap.teamIds).toEqual(["t_a", "t_b", "t_c"]);
  });

  it("keeps the optional layers off when they are absent", () => {
    const snap = buildAssignmentScopeSnapshot({ orgId: ORG });
    expect(snap.projectId).toBeUndefined();
    expect(snap.originatingHumanUserId).toBeUndefined();
    expect(snap.teamIds).toEqual([]);
  });

  it("carries the project and the originating human when supplied", () => {
    const snap = buildAssignmentScopeSnapshot({
      orgId: ORG,
      projectId: "p_1",
      originatingHumanUserId: "u_1",
      projectOrgId: ORG,
    });
    expect(snap.projectId).toBe("p_1");
    expect(snap.originatingHumanUserId).toBe("u_1");
  });

  it("refuses a snapshot with no organization — the scope has no floor without one", () => {
    expect(() => buildAssignmentScopeSnapshot({ orgId: "  " })).toThrow(
      AssignmentScopeSnapshotError,
    );
  });

  it("refuses a project belonging to ANOTHER organization", () => {
    expect(() =>
      buildAssignmentScopeSnapshot({ orgId: ORG, projectId: "p_1", projectOrgId: "org_2" }),
    ).toThrow(AssignmentScopeSnapshotError);
  });

  it("refuses a team belonging to ANOTHER organization", () => {
    expect(() =>
      buildAssignmentScopeSnapshot({
        orgId: ORG,
        teamIds: ["t_1"],
        teamOrgIds: { t_1: "org_2" },
      }),
    ).toThrow(AssignmentScopeSnapshotError);
  });
});

describe("assignment-scope snapshot — parse", () => {
  it("round-trips through JSON", () => {
    const snap = buildAssignmentScopeSnapshot({ orgId: ORG, teamIds: ["t_1"], projectId: "p_1" });
    expect(parseAssignmentScopeSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });

  it("treats an UNKNOWN version as absent", () => {
    expect(parseAssignmentScopeSnapshot({ v: 2, orgId: ORG, teamIds: [] })).toBeNull();
    expect(parseAssignmentScopeSnapshot({ v: 0, orgId: ORG, teamIds: [] })).toBeNull();
  });

  it("treats a malformed payload as absent", () => {
    expect(parseAssignmentScopeSnapshot(null)).toBeNull();
    expect(parseAssignmentScopeSnapshot("not json at all")).toBeNull();
    expect(parseAssignmentScopeSnapshot({ v: 1 })).toBeNull();
    expect(parseAssignmentScopeSnapshot({ v: 1, orgId: "", teamIds: [] })).toBeNull();
    expect(parseAssignmentScopeSnapshot({ v: 1, orgId: ORG, teamIds: "t_1" })).toBeNull();
  });

  it("accepts the JSON TEXT form as well as the parsed object", () => {
    const snap = buildAssignmentScopeSnapshot({ orgId: ORG });
    expect(parseAssignmentScopeSnapshot(JSON.stringify(snap))).toEqual(snap);
  });
});

describe("assignment-scope snapshot — the SOLE legacy fallback", () => {
  it("is workspace plus the instance's durable organization, and nothing else", () => {
    const fallback = assignmentScopeFallback("org_durable");
    expect(fallback).toEqual({ v: 1, orgId: "org_durable", teamIds: [] });
    expect(fallback.projectId).toBeUndefined();
    expect(fallback.originatingHumanUserId).toBeUndefined();
  });

  it.each([
    ["absent", null],
    ["malformed", { nonsense: true }],
    ["an unknown version", { v: 7, orgId: "org_x", teamIds: ["t"] }],
  ])("reading a %s snapshot yields the fallback, never the persisted layers", (_name, raw) => {
    const resolved = readAssignmentScopeSnapshot(raw, { durableOrgId: "org_durable" });
    expect(resolved.usedFallback).toBe(true);
    expect(resolved.snapshot).toEqual({ v: 1, orgId: "org_durable", teamIds: [] });
  });

  it("a readable snapshot is used as written", () => {
    const snap = buildAssignmentScopeSnapshot({ orgId: ORG, projectId: "p_1", teamIds: ["t_1"] });
    const resolved = readAssignmentScopeSnapshot(snap, { durableOrgId: "org_durable" });
    expect(resolved.usedFallback).toBe(false);
    expect(resolved.snapshot).toEqual(snap);
  });

  it("refuses to invent a fallback with no durable organization (fail closed)", () => {
    expect(() => readAssignmentScopeSnapshot(null, { durableOrgId: "" })).toThrow(
      AssignmentScopeSnapshotError,
    );
  });
});

// ── a wrong optional layer is malformed, never silently absent ────────────
describe("assignment-scope snapshot — malformed optional layers", () => {
  it.each([
    ["a non-string projectId", { v: 1, orgId: "org_1", teamIds: [], projectId: {} }],
    ["a numeric projectId", { v: 1, orgId: "org_1", teamIds: [], projectId: 7 }],
    [
      "a non-string originatingHumanUserId",
      { v: 1, orgId: "org_1", teamIds: [], originatingHumanUserId: ["u"] },
    ],
  ])("treats %s as malformed rather than dropping the layer", (_name, raw) => {
    expect(parseAssignmentScopeSnapshot(raw)).toBeNull();
    const resolved = readAssignmentScopeSnapshot(raw, { durableOrgId: "org_durable" });
    // The fallback, and the auditor is TOLD the payload was not readable.
    expect(resolved.usedFallback).toBe(true);
    expect(resolved.snapshot).toEqual({ v: 1, orgId: "org_durable", teamIds: [] });
  });

  it("still accepts an explicitly null optional layer as simply absent", () => {
    const parsed = parseAssignmentScopeSnapshot({
      v: 1,
      orgId: "org_1",
      teamIds: [],
      projectId: null,
      originatingHumanUserId: null,
    });
    expect(parsed).toEqual({ v: 1, orgId: "org_1", teamIds: [] });
  });
});
