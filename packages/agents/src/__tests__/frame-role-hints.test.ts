// THE FRAME'S OWN STANDING, AND WHEN IT MAY WIN (cinatra#2935, lifecycle-b W5d).
//
// A run start reads role hints from the acting frame's envelope rather than from
// a cookie session, because inside a same-origin embed the cookie may belong to
// whoever else is signed in on that browser. That is the fix. The hazard is its
// mirror image, and convergence round 1 (finding 4) caught it: the ORDINARY
// model/chat MCP envelope carries `orgId`, `orgRole` and `platformRole` and
// forwards NEITHER `teamIds` NOR `projectGrants`
// (`packages/agents/src/mcp/registry.ts`, `buildActorFromMcpContext`). Treating
// THAT envelope as authoritative would hand the kernel two empty arrays where
// the session lookup resolves the caller's real teams and project grants —
// silently denying a person whose access to an agent comes through a team or a
// project.
//
// So the rule under test is exactly: the envelope wins ONLY when it carries a
// RESOLVED standing.

import { describe, expect, it } from "vitest";

import { roleHintsFromActorEnvelope } from "../frame-role-hints";

const ORG = "org_1";

describe("roleHintsFromActorEnvelope", () => {
  it("returns the frame's standing when both membership axes are present", () => {
    expect(
      roleHintsFromActorEnvelope({
        orgId: ORG,
        orgRole: "member",
        platformRole: "member",
        teamIds: ["team_a"],
        projectGrants: [{ projectId: "prj_1", effectiveRole: "write", accessSource: "user" }],
      }),
    ).toEqual({
      platformRole: "member",
      orgRole: "member",
      actorOrganizationId: ORG,
      teamIds: ["team_a"],
      projectGrants: [{ projectId: "prj_1", effectiveRole: "write", accessSource: "user" }],
    });
  });

  it("EMPTY axes are still RESOLVED axes — a person with no teams has none", () => {
    const hints = roleHintsFromActorEnvelope({
      orgId: ORG,
      orgRole: "member",
      teamIds: [],
      projectGrants: [],
    });
    expect(hints).not.toBeNull();
    expect(hints!.teamIds).toEqual([]);
    expect(hints!.projectGrants).toEqual([]);
  });

  it("RED ON ROUND 1 — an envelope MISSING either axis yields null, never empty arrays", () => {
    // The ordinary model/chat envelope's exact shape: an org and a role, no
    // membership. It must fall through to the caller's session lookup.
    expect(
      roleHintsFromActorEnvelope({ orgId: ORG, orgRole: "member", platformRole: "member" }),
    ).toBeNull();
    expect(roleHintsFromActorEnvelope({ orgId: ORG, teamIds: ["team_a"] })).toBeNull();
    expect(roleHintsFromActorEnvelope({ orgId: ORG, projectGrants: [] })).toBeNull();
  });

  it("no org, no standing — teams and grants are resolved inside one organization", () => {
    expect(roleHintsFromActorEnvelope({ teamIds: [], projectGrants: [] })).toBeNull();
    expect(roleHintsFromActorEnvelope({ orgId: "", teamIds: [], projectGrants: [] })).toBeNull();
    expect(roleHintsFromActorEnvelope(null)).toBeNull();
    expect(roleHintsFromActorEnvelope(undefined)).toBeNull();
  });

  it("the platform tier is member unless the envelope says the exact elevated literal", () => {
    // Fail-closed on an unrecognised value: an envelope is unforgeable, but a
    // typo must not read as elevation.
    expect(
      roleHintsFromActorEnvelope({ orgId: ORG, platformRole: "platform_admin", teamIds: [], projectGrants: [] })!
        .platformRole,
    ).toBe("platform_admin");
    expect(
      roleHintsFromActorEnvelope({ orgId: ORG, platformRole: "Platform_Admin", teamIds: [], projectGrants: [] })!
        .platformRole,
    ).toBe("member");
    expect(
      roleHintsFromActorEnvelope({ orgId: ORG, teamIds: [], projectGrants: [] })!.platformRole,
    ).toBe("member");
  });
});
