/**
 * Behavioral unit tests for the pure multi-scope selection logic backing the
 * checkbox access picker (cinatra#1072, multi-scope W3). Unlike the source-text
 * contract tests elsewhere in this repo, these exercise the REAL toggle +
 * implication functions (no DOM needed — the logic is pure).
 *
 * Locks epic #1069 rules 2-4 at the unit level:
 *   - rule 2: no upward collapse (explicit teams never become org:)
 *   - rule 3: downward implication is display-only; projects never implied by
 *     org/team; explicit tokens persist under an implier and release when it is
 *     unchecked
 *   - rule 4: normalization invariants (workspace-collapse, owner-strip-mixed,
 *     non-empty floor) + owner/workspace exclusivity in the toggle
 */
import { describe, it, expect } from "vitest";
import {
  type AvailableScopes,
  accessRowState,
  toggleAccessSelection,
} from "@/components/access-scope";

const SCOPES: AvailableScopes = {
  orgs: [
    {
      id: "org-acme",
      name: "Acme",
      teams: [
        { id: "team-rev", name: "Revenue" },
        { id: "team-eng", name: "Engineering" },
      ],
    },
    { id: "org-beta", name: "Beta", teams: [{ id: "team-ops", name: "Ops" }] },
  ],
  projects: [{ id: "proj-atlas", name: "Atlas" }],
  canGrantWorkspace: true,
};

describe("toggleAccessSelection", () => {
  it("checking a scope from owner-only replaces owner (owner-strip-when-mixed)", () => {
    expect(toggleAccessSelection("team:team-rev", ["owner"])).toEqual(["team:team-rev"]);
  });

  it("adds a second scope preserving first-seen order (no collapse)", () => {
    expect(toggleAccessSelection("org:org-acme", ["team:team-rev"])).toEqual([
      "team:team-rev",
      "org:org-acme",
    ]);
  });

  it("removes a scope, keeping the rest", () => {
    expect(
      toggleAccessSelection("team:team-rev", ["team:team-rev", "org:org-acme"]),
    ).toEqual(["org:org-acme"]);
  });

  it("removing the last scope falls back to owner (non-empty floor)", () => {
    expect(toggleAccessSelection("team:team-rev", ["team:team-rev"])).toEqual(["owner"]);
  });

  it("owner is EXCLUSIVE — clicking it collapses to owner-only (clear-to-owner)", () => {
    expect(
      toggleAccessSelection("owner", ["team:team-rev", "org:org-acme", "admin"]),
    ).toEqual(["owner"]);
  });

  it("workspace is EXCLUSIVE — checking it collapses to workspace-only", () => {
    expect(toggleAccessSelection("workspace", ["team:team-rev", "admin"])).toEqual([
      "workspace",
    ]);
  });

  it("unchecking workspace falls back to owner", () => {
    expect(toggleAccessSelection("workspace", ["workspace"])).toEqual(["owner"]);
  });

  it("admin is MIXABLE — never stripped from a union", () => {
    expect(toggleAccessSelection("admin", ["team:team-rev"])).toEqual([
      "team:team-rev",
      "admin",
    ]);
    expect(toggleAccessSelection("team:team-eng", ["admin"])).toEqual([
      "admin",
      "team:team-eng",
    ]);
  });

  it("NO upward collapse — checking every team of an org keeps team tokens", () => {
    const next = toggleAccessSelection("team:team-eng", ["team:team-rev"]);
    expect(next).toEqual(["team:team-rev", "team:team-eng"]);
    expect(next).not.toContain("org:org-acme");
  });

  it("unchecking an org releases ONLY implied teams; an explicitly-checked team persists", () => {
    // team-rev is BOTH explicit and org-implied; team-eng is only implied.
    expect(
      toggleAccessSelection("org:org-acme", ["org:org-acme", "team:team-rev"]),
    ).toEqual(["team:team-rev"]);
  });
});

describe("accessRowState", () => {
  it("marks an explicitly-checked scope checked + enabled", () => {
    expect(accessRowState("team:team-rev", ["team:team-rev"], SCOPES)).toEqual({
      checked: true,
      impliedDisabled: false,
    });
  });

  it("a checked org implies its OWN team rows (checked + disabled + note)", () => {
    expect(accessRowState("team:team-rev", ["org:org-acme"], SCOPES)).toEqual({
      checked: true,
      impliedDisabled: true,
      impliedNote: "Included via Acme",
    });
  });

  it("a checked org does NOT imply another org's team", () => {
    expect(accessRowState("team:team-ops", ["org:org-acme"], SCOPES)).toEqual({
      checked: false,
      impliedDisabled: false,
    });
  });

  it("projects are NEVER implied by an org/team check (rule 3)", () => {
    expect(accessRowState("project:proj-atlas", ["org:org-acme"], SCOPES)).toEqual({
      checked: false,
      impliedDisabled: false,
    });
  });

  it("workspace implies every scope row (org/team/project/admin)", () => {
    for (const v of ["org:org-acme", "team:team-rev", "project:proj-atlas", "admin"]) {
      expect(accessRowState(v, ["workspace"], SCOPES)).toEqual({
        checked: true,
        impliedDisabled: true,
        impliedNote: "Included via Workspace: All",
      });
    }
  });

  it("owner is disabled (not checked) under workspace — the narrowing floor", () => {
    expect(accessRowState("owner", ["workspace"], SCOPES)).toEqual({
      checked: false,
      impliedDisabled: true,
    });
  });

  it("owner is checked but DISABLED (the floor) when it is the sole selection", () => {
    // The floor cannot be unchecked — clicking it would be a no-op, so it is
    // rendered non-interactive until a broader scope is also selected.
    expect(accessRowState("owner", ["owner"], SCOPES)).toEqual({
      checked: true,
      impliedDisabled: true,
    });
  });

  it("owner is ENABLED + unchecked (clear-to-owner affordance) once a scope is selected", () => {
    expect(accessRowState("owner", ["team:team-rev"], SCOPES)).toEqual({
      checked: false,
      impliedDisabled: false,
    });
  });

  it("an explicit team under a checked org shows implied (display) yet persists underneath", () => {
    // Display: implied wins (checked + disabled + note)...
    expect(
      accessRowState("team:team-rev", ["org:org-acme", "team:team-rev"], SCOPES),
    ).toEqual({
      checked: true,
      impliedDisabled: true,
      impliedNote: "Included via Acme",
    });
    // ...but the token is still in the stored selection, so releasing the org
    // restores it (covered by the toggle release test above).
  });

  it("the workspace row itself is checked + enabled when selected", () => {
    expect(accessRowState("workspace", ["workspace"], SCOPES)).toEqual({
      checked: true,
      impliedDisabled: false,
    });
  });
});
