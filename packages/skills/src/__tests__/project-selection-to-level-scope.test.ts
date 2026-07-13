// Multi-token (level, scope) projection (cinatra#1416, AC1).
//
// The #1073 contract keeps the `(level, scope)` tuple a deterministic
// LABEL/INDEX HINT, never an enforcement source. When a personal skill is
// shared to a multi-scope UNION, the tuple must be projected deterministically:
//   - the single BROADEST granted level wins
//     (workspace > organization > team > project > personal);
//   - ties break on a stable canonical sort (lexicographic ascending);
//   - an owner-only / empty selection restores level="personal", scope=owner;
//   - `admin` never drives the label when mixed with real grants.
//
// Single-token selections must reproduce `visibilityToLevelScope` exactly so
// every pre-multi-scope writer stays behaviour-identical.

import { describe, it, expect } from "vitest";
import {
  projectSelectionToLevelScope,
  visibilityToLevelScope,
} from "../skill-packages";
import type { AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";

const OWNER = "owner-user-id";
const TEAM_A = "team:aaaaaaaa-0000-0000-0000-000000000000" as const;
const TEAM_B = "team:bbbbbbbb-0000-0000-0000-000000000000" as const;
const PROJ = "project:cccccccc-0000-0000-0000-000000000000" as const;
const ORG = "org:dddddddd-0000-0000-0000-000000000000" as const;

function project(sel: AgentAuthPolicyVisibility[]) {
  return projectSelectionToLevelScope(sel, OWNER);
}

describe("projectSelectionToLevelScope — broadest-level precedence (cinatra#1416, AC1)", () => {
  it("workspace beats every other grant", () => {
    expect(project(["workspace", ORG, TEAM_A, PROJ, "owner"])).toEqual({
      level: "workspace",
      scope: undefined,
    });
  });

  it("organization beats team/project/owner", () => {
    expect(project([ORG, TEAM_A, PROJ, "owner"])).toEqual({
      level: "organization",
      scope: "org",
    });
  });

  it("team beats project/owner", () => {
    expect(project([TEAM_A, PROJ, "owner"])).toEqual({
      level: "team",
      scope: TEAM_A.slice("team:".length),
    });
  });

  it("project beats owner", () => {
    expect(project([PROJ, "owner"])).toEqual({
      level: "project",
      scope: PROJ.slice("project:".length),
    });
  });
});

describe("projectSelectionToLevelScope — deterministic tie-break (cinatra#1416, AC1)", () => {
  it("two same-level tokens: scope is the FIRST in a stable canonical (lexicographic) sort", () => {
    // TEAM_A < TEAM_B lexicographically → TEAM_A's id regardless of input order.
    expect(project([TEAM_B, TEAM_A])).toEqual({
      level: "team",
      scope: TEAM_A.slice("team:".length),
    });
    expect(project([TEAM_A, TEAM_B])).toEqual({
      level: "team",
      scope: TEAM_A.slice("team:".length),
    });
  });
});

describe("projectSelectionToLevelScope — personal baseline (cinatra#1416, AC1)", () => {
  it("owner-only selection restores level=personal, scope=ownerUserId", () => {
    expect(project(["owner"])).toEqual({ level: "personal", scope: OWNER });
  });

  it("empty selection restores the personal baseline", () => {
    expect(project([])).toEqual({ level: "personal", scope: OWNER });
  });
});

describe("projectSelectionToLevelScope — admin never drives the label (cinatra#1416, AC1)", () => {
  it("admin-only keeps the legacy system projection", () => {
    expect(project(["admin"])).toEqual(visibilityToLevelScope("admin", OWNER));
    expect(project(["admin"])).toEqual({ level: "system", scope: undefined });
  });

  it("admin mixed with a real grant: the real grant drives the label", () => {
    expect(project(["admin", TEAM_A])).toEqual({
      level: "team",
      scope: TEAM_A.slice("team:".length),
    });
  });
});

describe("projectSelectionToLevelScope — single-token parity with visibilityToLevelScope", () => {
  for (const token of ["owner", "workspace", "admin", ORG, TEAM_A, PROJ] as const) {
    it(`single [${token}] reproduces visibilityToLevelScope`, () => {
      expect(projectSelectionToLevelScope([token], OWNER)).toEqual(
        visibilityToLevelScope(token, OWNER),
      );
    });
  }
});
