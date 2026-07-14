/**
 * Pure unit tests for the #1508 selection-hydration helpers
 * (cinatra#1509 §4.1, codex F5).
 *
 * The contract under test:
 *  - the hydration input set is CLOSED and server-derived: team ids from the
 *    project's stored access expression + its team-level project_access rows,
 *    nothing else (no user/org/workspace principals, no client-supplied ids);
 *  - merging never displaces or renames the viewer's own team entries and
 *    never introduces duplicates.
 */
import { describe, it, expect } from "vitest";
import {
  collectAccessStateTeamIds,
  mergeResolvedTeams,
} from "../access-team-hydration";

describe("collectAccessStateTeamIds", () => {
  it("collects the team id from a team:<id> access expression", () => {
    expect(collectAccessStateTeamIds("team:team-x", [])).toEqual(["team-x"]);
  });

  it("ignores non-team access expressions (owner / org:<id> / workspace)", () => {
    expect(collectAccessStateTeamIds("owner", [])).toEqual([]);
    expect(collectAccessStateTeamIds("org:org-1", [])).toEqual([]);
    expect(collectAccessStateTeamIds("workspace", [])).toEqual([]);
  });

  it("collects team-level project_access rows and ignores every other level", () => {
    const rows = [
      { principalLevel: "team", principalId: "team-a" },
      { principalLevel: "user", principalId: "user-1" },
      { principalLevel: "organization", principalId: "org-1" },
      { principalLevel: "workspace", principalId: "__workspace__" },
      { principalLevel: "team", principalId: "team-b" },
    ];
    expect(collectAccessStateTeamIds("owner", rows)).toEqual(["team-a", "team-b"]);
  });

  it("dedupes ids appearing in both the expression and the rows", () => {
    const rows = [
      { principalLevel: "team", principalId: "team-x" },
      { principalLevel: "team", principalId: "team-x" },
    ];
    expect(collectAccessStateTeamIds("team:team-x", rows)).toEqual(["team-x"]);
  });

  it("drops blank ids", () => {
    const rows = [{ principalLevel: "team", principalId: "   " }];
    expect(collectAccessStateTeamIds("team:", rows)).toEqual([]);
  });
});

describe("mergeResolvedTeams", () => {
  it("appends resolved entries after the viewer's teams", () => {
    const merged = mergeResolvedTeams(
      [{ id: "t1", name: "Revenue" }],
      [{ id: "t2", name: "Growth" }],
    );
    expect(merged).toEqual([
      { id: "t1", name: "Revenue" },
      { id: "t2", name: "Growth" },
    ]);
  });

  it("keeps the viewer's entry (name + position) on id conflicts", () => {
    const merged = mergeResolvedTeams(
      [{ id: "t1", name: "Revenue" }],
      [{ id: "t1", name: "Stale Name" }],
    );
    expect(merged).toEqual([{ id: "t1", name: "Revenue" }]);
  });

  it("never duplicates a resolved entry", () => {
    const merged = mergeResolvedTeams(
      [],
      [
        { id: "t2", name: "Growth" },
        { id: "t2", name: "Growth" },
      ],
    );
    expect(merged).toEqual([{ id: "t2", name: "Growth" }]);
  });

  it("returns the viewer's teams untouched when nothing resolved", () => {
    const viewer = [
      { id: "t1", name: "Revenue" },
      { id: "t2", name: "Engineering" },
    ];
    expect(mergeResolvedTeams(viewer, [])).toEqual(viewer);
  });
});
