// Multi-scope access W4 (#1073): requireResourceAccess evaluates the canonical
// accessPolicy union ANY-MATCH when the ref carries `policy`. A single-token
// policy is behaviour-identical to the legacy (level, scope) gate; a multi-token
// policy admits an actor matching ANY token (OR-visibility) — the projection the
// (level, scope) tuple cannot represent.

import { describe, it, expect } from "vitest";
import type { ActorContext } from "@/lib/authz";
import { requireResourceAccess, buildSkillResourceRef } from "../auth-policy";
import type { AgentAuthPolicy } from "../auth-policy";

function actor(over: Partial<ActorContext>): ActorContext {
  return {
    platformRole: "member",
    principalId: "user-1",
    ...over,
  } as unknown as ActorContext;
}

function policy(tokens: AgentAuthPolicy["runListVisibility"]): AgentAuthPolicy {
  return {
    runListVisibility: tokens,
    runDataVisibility: tokens,
    runExecuteVisibility: tokens,
    allowRunSharing: false,
  };
}

const T1 = "team:11111111-1111-1111-1111-111111111111" as const;
const P2 = "project:22222222-2222-2222-2222-222222222222" as const;
const ORG = "org:33333333-3333-3333-3333-333333333333" as const;

describe("requireResourceAccess — canonical multi-scope policy (W4)", () => {
  describe("OR-policy [team:t1, project:p2]", () => {
    const ref = buildSkillResourceRef({
      id: "@pkg/s",
      level: "team",
      scope: "11111111-1111-1111-1111-111111111111",
      accessPolicy: policy([T1, P2]),
    });

    it("admits a member of team t1 (first token)", () => {
      expect(() =>
        requireResourceAccess(
          actor({ teamIds: ["11111111-1111-1111-1111-111111111111"], projectIds: [] }),
          ref,
        ),
      ).not.toThrow();
    });

    it("admits a member of project p2 (second token) — the tuple could not", () => {
      expect(() =>
        requireResourceAccess(
          actor({ teamIds: [], projectIds: ["22222222-2222-2222-2222-222222222222"] }),
          ref,
        ),
      ).not.toThrow();
    });

    it("denies an actor in neither scope", () => {
      expect(() =>
        requireResourceAccess(
          actor({ teamIds: ["other-team"], projectIds: ["other-project"] }),
          ref,
        ),
      ).toThrow(expect.objectContaining({ statusCode: 403, reason: "forbidden" }));
    });
  });

  describe("single-token policy is behaviour-identical to the legacy tuple", () => {
    it("org:<id> admits the owning-org actor and denies a cross-org actor", () => {
      const ref = buildSkillResourceRef({
        id: "@pkg/s",
        level: "organization",
        scope: "33333333-3333-3333-3333-333333333333",
        accessPolicy: policy([ORG]),
      });
      expect(() =>
        requireResourceAccess(
          actor({ organizationId: "33333333-3333-3333-3333-333333333333" }),
          ref,
        ),
      ).not.toThrow();
      expect(() =>
        requireResourceAccess(actor({ organizationId: "other-org" }), ref),
      ).toThrow(expect.objectContaining({ statusCode: 403 }));
    });

    it("owner token admits the resource owner only", () => {
      const ref = buildSkillResourceRef({
        id: "@pkg/s",
        level: "personal",
        scope: "user-1",
        accessPolicy: policy(["owner"]),
      });
      expect(() => requireResourceAccess(actor({ principalId: "user-1" }), ref)).not.toThrow();
      expect(() => requireResourceAccess(actor({ principalId: "user-2" }), ref)).toThrow(
        expect.objectContaining({ statusCode: 403 }),
      );
    });
  });

  describe("structural gates still win over the policy union", () => {
    it("platform_admin bypasses the policy union", () => {
      const ref = buildSkillResourceRef({
        id: "@pkg/s",
        level: "team",
        scope: "11111111-1111-1111-1111-111111111111",
        accessPolicy: policy([T1]),
      });
      expect(() =>
        requireResourceAccess(actor({ platformRole: "platform_admin", teamIds: [] }), ref),
      ).not.toThrow();
    });

    it("system-level stays 404-hidden even with a policy present", () => {
      const ref = buildSkillResourceRef({
        id: "@pkg/s",
        level: "system",
        scope: undefined,
        accessPolicy: policy([T1]),
      });
      expect(() =>
        requireResourceAccess(
          actor({ teamIds: ["11111111-1111-1111-1111-111111111111"] }),
          ref,
        ),
      ).toThrow(expect.objectContaining({ statusCode: 404, reason: "hidden" }));
    });
  });

  describe("workspace token", () => {
    const ref = buildSkillResourceRef({
      id: "@pkg/s",
      level: "workspace",
      scope: undefined,
      accessPolicy: policy(["workspace"]),
    });
    it("admits any authenticated workspace principal on read", () => {
      expect(() =>
        requireResourceAccess(actor({ organizationId: "org-x", principalId: "user-1" }), ref),
      ).not.toThrow();
    });
    it("denies a manage attempt by a non-admin workspace user", () => {
      expect(() =>
        requireResourceAccess(
          actor({ organizationId: "org-x", principalId: "user-1", orgRole: "member" }),
          ref,
          "manage",
        ),
      ).toThrow(expect.objectContaining({ statusCode: 403 }));
    });
    it("admits an org_admin manage attempt", () => {
      expect(() =>
        requireResourceAccess(
          actor({ organizationId: "org-x", principalId: "user-1", orgRole: "org_admin" }),
          ref,
          "manage",
        ),
      ).not.toThrow();
    });
  });

  describe("admin token is platform-admin-only (no org_admin over-grant vs the legacy tuple)", () => {
    it("['admin'] denies a non-platform org_admin on manage (legacy projected level:system → hidden)", () => {
      const ref = buildSkillResourceRef({
        id: "@pkg/s",
        level: "system",
        scope: undefined,
        accessPolicy: policy(["admin"]),
      });
      // system-hidden fires first (level:system) → 404 for the non-platform admin.
      expect(() =>
        requireResourceAccess(
          actor({ orgRole: "org_admin", organizationId: "org-x" }),
          ref,
          "manage",
        ),
      ).toThrow(expect.objectContaining({ statusCode: 404 }));
    });

    it("['team:t1','admin'] denies a cross-org org_admin who is not in team t1", () => {
      // level projected from the first token (team) → not system-hidden, so the
      // policy branch runs; the admin token must NOT admit the foreign org admin.
      const ref = buildSkillResourceRef({
        id: "@pkg/s",
        level: "team",
        scope: "11111111-1111-1111-1111-111111111111",
        accessPolicy: policy([T1, "admin"]),
      });
      expect(() =>
        requireResourceAccess(
          actor({ orgRole: "org_admin", organizationId: "other-org", teamIds: [], projectIds: [] }),
          ref,
          "manage",
        ),
      ).toThrow(expect.objectContaining({ statusCode: 403 }));
      // …but a member of t1 is still admitted (the union's other token).
      expect(() =>
        requireResourceAccess(
          actor({ teamIds: ["11111111-1111-1111-1111-111111111111"] }),
          ref,
        ),
      ).not.toThrow();
    });
  });

  it("falls back to the (level, scope) tuple when no policy is present (registry / un-migrated rows)", () => {
    const ref = buildSkillResourceRef({
      id: "@pkg/s",
      level: "team",
      scope: "11111111-1111-1111-1111-111111111111",
      // no accessPolicy → policy undefined → tuple branch
    });
    expect(ref.policy).toBeUndefined();
    expect(() =>
      requireResourceAccess(
        actor({ teamIds: ["11111111-1111-1111-1111-111111111111"] }),
        ref,
      ),
    ).not.toThrow();
    expect(() =>
      requireResourceAccess(actor({ teamIds: ["other"] }), ref),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});
