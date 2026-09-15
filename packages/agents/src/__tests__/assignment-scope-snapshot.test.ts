// The run-scope snapshot (cinatra#2813 S1, epic #2812).
//
// A run's applicable assignment scopes are decided ONCE, at creation, and never
// again. The reason is not tidiness: a thread's project can be changed by a
// person after the fact, so reading scope at delivery time would silently
// re-point a running agent at a different set of assignments. The snapshot is
// therefore versioned, immutable, and — when it is missing or unreadable —
// falls back to the NARROWEST possible answer rather than guessing.
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASSIGNMENT_SCOPE_SNAPSHOT_VERSION,
  assertAssignmentScopeSnapshotNotMutated,
  AssignmentScopeSnapshotError,
  assignmentScopeFallback,
  buildAssignmentScopeSnapshot,
  buildRunCreationAssignmentScopeSnapshot,
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

// The immutability guard is only an invariant if an update path actually calls
// it. Its own doc says "every update path calls this before it builds its SET
// list" — this suite holds that sentence to the source.
describe("assignment-scope snapshot — the immutability guard", () => {
  it("throws for either spelling of the field and passes an ordinary patch", () => {
    expect(() => assertAssignmentScopeSnapshotNotMutated({ error: "boom" })).not.toThrow();
    expect(() =>
      assertAssignmentScopeSnapshotNotMutated({ assignmentScopeSnapshot: "{}" }),
    ).toThrow(/IMMUTABLE/);
    expect(() =>
      assertAssignmentScopeSnapshotNotMutated({ assignment_scope_snapshot: "{}" }),
    ).toThrow(/IMMUTABLE/);
    // hasOwnProperty, not truthiness: an explicit undefined is still a writer
    // naming the column.
    expect(() =>
      assertAssignmentScopeSnapshotNotMutated({ assignmentScopeSnapshot: undefined }),
    ).toThrow(/IMMUTABLE/);
  });

  it("is called by the generic run-meta patch path", () => {
    const storeSource = readFileSync(
      resolve(fileURLToPath(import.meta.url), "../../store.ts"),
      "utf8",
    );
    const body = storeSource.slice(storeSource.indexOf("export async function updateAgentRunMeta"));
    const end = body.indexOf("\nexport ", 1);
    expect(body.slice(0, end)).toContain("assertAssignmentScopeSnapshotNotMutated(");
  });
});

// THE RUN-CREATION DERIVATION, as a named seam of this module.
//
// `createAgentRun` and `createAgentRunPendingInput` derived the identical
// snapshot from the identical three fields, each carrying its own copy of the
// reasoning. Two copies of one authority rule is one copy too many: a fix
// applied to one of them leaves the other deciding differently. The derivation
// lives HERE, beside the builder it wraps, and the store calls it.
describe("assignment-scope snapshot — the run-creation derivation", () => {
  it("carries the org, the project and the actor's teams", () => {
    const snap = buildRunCreationAssignmentScopeSnapshot({
      orgId: ORG,
      projectId: "proj_1",
      scopeActor: {
        principalType: "HumanUser",
        principalId: "user_1",
        teamIds: ["t_b", "t_a"],
      },
    });
    expect(snap).toEqual({
      v: ASSIGNMENT_SCOPE_SNAPSHOT_VERSION,
      orgId: ORG,
      projectId: "proj_1",
      teamIds: ["t_a", "t_b"],
      originatingHumanUserId: "user_1",
    });
  });

  it("stamps the originating human ONLY for a HumanUser scope actor", () => {
    // A schedule, a trigger or an orchestrator child keeps a human OWNER, and
    // stamping that owner here would give a headless run a personal assignment
    // layer nobody granted it.
    for (const principalType of [
      "ServiceAccount",
      "InternalWorker",
      "ExternalA2AAgent",
      "System",
    ]) {
      const snap = buildRunCreationAssignmentScopeSnapshot({
        orgId: ORG,
        scopeActor: { principalType, principalId: "svc_1", teamIds: ["t_a"] },
      });
      expect(snap.originatingHumanUserId).toBeUndefined();
      // The team layer is the actor's own and survives; only the personal tier
      // is withheld.
      expect(snap.teamIds).toEqual(["t_a"]);
    }
  });

  it("has no project and no personal tier when the run carries neither", () => {
    const snap = buildRunCreationAssignmentScopeSnapshot({
      orgId: ORG,
      projectId: null,
      scopeActor: null,
    });
    expect(snap).toEqual({
      v: ASSIGNMENT_SCOPE_SNAPSHOT_VERSION,
      orgId: ORG,
      teamIds: [],
    });
  });

  it("refuses a run with no organization", () => {
    expect(() => buildRunCreationAssignmentScopeSnapshot({ orgId: "   " })).toThrow(
      AssignmentScopeSnapshotError,
    );
  });

  it("is what BOTH run-creation paths call — the derivation is not re-inlined", () => {
    const storeSource = readFileSync(
      resolve(fileURLToPath(import.meta.url), "../../store.ts"),
      "utf8",
    );
    for (const entry of [
      "export async function createAgentRun(",
      "export async function createAgentRunPendingInput(",
    ]) {
      const start = storeSource.indexOf(entry);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = storeSource.slice(start);
      expect(body.slice(0, body.indexOf("\nexport ", 1))).toContain(
        "buildRunCreationAssignmentScopeSnapshot(",
      );
    }
    // The low-level builder is reached THROUGH the seam. A re-inlined
    // `buildAssignmentScopeSnapshot({ ... })` at a call site is the exact
    // duplication this seam exists to end.
    expect(storeSource).not.toContain("buildAssignmentScopeSnapshot({");
  });
});
