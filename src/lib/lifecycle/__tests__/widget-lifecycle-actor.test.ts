// The widget lifecycle actor (cinatra#2574, epic #2564 S8a).
//
// What these assertions are about: an actor that decides what a person on a
// public site may READ of their organization's lifecycle work. So they are
// written around the two ways that can go wrong — granting more than the person
// has (the token's grant, the org anchor) and granting less than the person has
// (the resolved team/project axes, which the runtime's degraded context drops,
// and — since cinatra#2674 removed the floor — the platform tier).

import { beforeEach, describe, expect, it, vi } from "vitest";

const consumeUserWidgetToken = vi.fn();
const resolveActorGrantsForUserInOrg = vi.fn();
const emitWidgetAuthAudit = vi.fn();

vi.mock("@/lib/widget-user-auth", () => ({
  consumeUserWidgetToken: (...args: unknown[]) => consumeUserWidgetToken(...args),
}));
vi.mock("@/lib/auth-session", () => ({
  resolveActorGrantsForUserInOrg: (...args: unknown[]) =>
    resolveActorGrantsForUserInOrg(...args),
}));
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: (...args: unknown[]) => emitWidgetAuthAudit(...args),
}));
const readUserIsPlatformAdmin = vi.fn();
vi.mock("@/lib/better-auth-db", () => ({
  readUserIsPlatformAdmin: (...args: unknown[]) => readUserIsPlatformAdmin(...args),
}));

import {
  WIDGET_LIFECYCLE_READ_REQUIRED_SCOPES,
  buildWidgetLifecycleRoleHints,
  resolveWidgetLifecycleActorContext,
  resolveWidgetLifecycleActorForFrame,
} from "../widget-lifecycle-actor";
import {
  WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
} from "@/lib/widget-lifecycle-scope";

const CLAIMS = {
  userId: "user-1",
  orgId: "org-A",
  siteId: "site-1",
  client: "wordpress",
  siteOrigin: "https://wp.test",
  agentSlug: "wordpress-content-editor",
  instanceId: "inst-1",
  jti: "jti-1",
  grantedScopes: [WIDGET_LIFECYCLE_READ_SCOPE],
};

const GRANTS = {
  orgRole: "member" as const,
  teamIds: ["team-1", "team-2"],
  teamRoles: { "team-1": "team_admin" as const, "team-2": "member" as const },
  projectGrants: [
    {
      projectId: "proj-1",
      effectiveRole: "write" as const,
      accessSource: "user" as const,
    },
  ],
};

function call() {
  return resolveWidgetLifecycleActorContext({
    token: "cwu_whatever",
    agentSlug: "wordpress-content-editor",
    requestOrigin: "https://wp.test",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  consumeUserWidgetToken.mockReturnValue({ ok: true, claims: CLAIMS });
  resolveActorGrantsForUserInOrg.mockResolvedValue(GRANTS);
  readUserIsPlatformAdmin.mockResolvedValue(false);
});

describe("the token gate", () => {
  it("consumes at the LIFECYCLE audience and REQUIRES the lifecycle scope", () => {
    void call();
    expect(consumeUserWidgetToken).toHaveBeenCalledWith(
      expect.objectContaining({
        routePath: WIDGET_LIFECYCLE_READ_ROUTE_PATH,
        requiredScopes: WIDGET_LIFECYCLE_READ_REQUIRED_SCOPES,
        agentSlug: "wordpress-content-editor",
        requestOrigin: "https://wp.test",
      }),
    );
    expect(WIDGET_LIFECYCLE_READ_REQUIRED_SCOPES).toEqual([
      WIDGET_LIFECYCLE_READ_SCOPE,
    ]);
  });

  it("AC-1 at the seam: a token the verifier refuses yields NO actor", async () => {
    consumeUserWidgetToken.mockReturnValue({ ok: false, reason: "scope_mismatch" });
    await expect(call()).resolves.toEqual({ ok: false, reason: "token_rejected" });
    // And nothing downstream ran — a refused token never touches a standing
    // read, let alone a row.
    expect(resolveActorGrantsForUserInOrg).not.toHaveBeenCalled();
  });

  it("refuses a validated token with no principal or no org binding", async () => {
    consumeUserWidgetToken.mockReturnValue({
      ok: true,
      claims: { ...CLAIMS, orgId: "" },
    });
    await expect(call()).resolves.toEqual({ ok: false, reason: "unbound_principal" });
    expect(resolveActorGrantsForUserInOrg).not.toHaveBeenCalled();
  });
});

describe("the live standing", () => {
  it("resolves in the TOKEN's org — never a session's active org", async () => {
    await call();
    expect(resolveActorGrantsForUserInOrg).toHaveBeenCalledWith("user-1", "org-A");
  });

  it("ONE resolution: membership IS the resolved org role, with no reconciliation", async () => {
    // codex round 0, finding 2 — a separate membership pre-check plus a grant
    // resolution is two observations of a changing fact, and preferring either
    // keeps the more generous one across a demotion. There is exactly one read
    // and no fallback: no org role means not a member.
    expect(resolveActorGrantsForUserInOrg).toHaveBeenCalledTimes(0);
    await call();
    expect(resolveActorGrantsForUserInOrg).toHaveBeenCalledTimes(1);

    resolveActorGrantsForUserInOrg.mockResolvedValue({
      // Membership gone, but the grants a stale read might still return.
      teamIds: ["team-1"],
      projectGrants: [{ projectId: "p", effectiveRole: "admin", accessSource: "user" }],
    });
    await expect(call()).resolves.toEqual({ ok: false, reason: "not_org_member" });
  });
});

describe("the constructed actor", () => {
  it("carries the FULL resolved axes — the degraded context's empty ones would hide rows", async () => {
    const r = await call();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actorCtx.orgId).toBe("org-A");
    expect(r.actorCtx.actor).toMatchObject({
      actorType: "human",
      userId: "user-1",
      orgId: "org-A",
    });
    expect(r.actorCtx.roleHints).toMatchObject({
      orgRole: "member",
      teamIds: GRANTS.teamIds,
      teamRoles: GRANTS.teamRoles,
      projectGrants: GRANTS.projectGrants,
      actorOrganizationId: "org-A",
    });
  });

  it("cinatra#2674: CARRIES the platform tier — a platform admin keeps it here", async () => {
    // The floor S8a imposed is gone, together with its justification (the site's
    // possession of the widget bearer). The tier is resolved LIVE, like every
    // other axis, and it is the person's real one.
    readUserIsPlatformAdmin.mockResolvedValue(true);
    const r = await call();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actorCtx.roleHints?.platformRole).toBe("platform_admin");
    // …and it was resolved for the TOKEN's principal, not for anybody else.
    expect(readUserIsPlatformAdmin).toHaveBeenCalledWith("user-1");
  });

  it("an ordinary member is NOT elevated — removing the floor granted nobody anything", async () => {
    readUserIsPlatformAdmin.mockResolvedValue(false);
    const r = await call();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actorCtx.roleHints?.platformRole).toBe("member");
  });

  it("fails CLOSED to `member` when the tier cannot be read", async () => {
    // `readUserIsPlatformAdmin` swallows its own read errors and answers false;
    // this pins the consequence at this layer — an unreadable tier narrows.
    readUserIsPlatformAdmin.mockResolvedValue(false);
    const hinted = buildWidgetLifecycleRoleHints({ orgId: "org-A", orgRole: "org_owner" });
    expect(hinted.platformRole).toBe("member");
  });

  it("omits an axis the lineage did not resolve rather than forcing an under-grant", () => {
    const hints = buildWidgetLifecycleRoleHints({ orgId: "org-A" });
    expect(hints).toEqual({ platformRole: "member", actorOrganizationId: "org-A" });
    expect("teamRoles" in hints).toBe(false);
    expect("projectGrants" in hints).toBe(false);
  });
});

describe("the audit trail", () => {
  it("records the authorization with the consented grant, and no secret", async () => {
    await call();
    const [event, fields] = emitWidgetAuthAudit.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    expect(event).toBe("widget_lifecycle_read_authorized");
    expect(fields).toMatchObject({
      actor: "user-1",
      orgId: "org-A",
      grantedScopes: WIDGET_LIFECYCLE_READ_SCOPE,
    });
    expect(JSON.stringify(fields)).not.toContain("cwu_");
  });

  it("records a reason-coded rejection that names no row", async () => {
    consumeUserWidgetToken.mockReturnValue({ ok: false, reason: "aud_mismatch" });
    await call();
    const [event, fields] = emitWidgetAuthAudit.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    expect(event).toBe("widget_lifecycle_read_rejected");
    expect(fields.reason).toBe("aud_mismatch");
    expect(JSON.stringify(fields)).not.toContain("cwu_");
  });
});

// ---------------------------------------------------------------------------
// The MCP-FRAME entry (cinatra#2577, epic #2564 S8d).
//
// The `cwu_` does not cross the MCP boundary; the widget OBO token does, and it
// carries the grant as a signed claim the route minted from that same `cwu_`
// consume. So step 1 of the ladder is satisfied by a different signed artifact
// and steps 2 and 3 are literally the same code. What these assertions pin is
// that "different artifact" did not quietly become "weaker actor": the live
// standing is still resolved, the platform floor still holds, and a membership
// that has since gone still refuses.
// ---------------------------------------------------------------------------

describe("the MCP-frame entry", () => {
  const FRAME = { userId: "user-1", orgId: "org-A", kind: "wordpress" };

  it("never touches the cwu_ verifier — there is no token on this path", () => {
    void resolveWidgetLifecycleActorForFrame(FRAME);
    expect(consumeUserWidgetToken).not.toHaveBeenCalled();
  });

  it("resolves the live standing in the FRAME's org", async () => {
    await resolveWidgetLifecycleActorForFrame(FRAME);
    expect(resolveActorGrantsForUserInOrg).toHaveBeenCalledWith("user-1", "org-A");
  });

  it("produces the SAME actor the token entry does for the same person", async () => {
    // The property that keeps the two surfaces from drifting: one reader, one
    // standing, whichever door they came through.
    const viaToken = await call();
    const viaFrame = await resolveWidgetLifecycleActorForFrame(FRAME);
    expect(viaToken.ok && viaFrame.ok).toBe(true);
    if (!viaToken.ok || !viaFrame.ok) return;
    expect(viaFrame.actorCtx).toEqual(viaToken.actorCtx);
  });

  it("carries the resolved team + project axes, not an empty floor", async () => {
    const result = await resolveWidgetLifecycleActorForFrame(FRAME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actorCtx.roleHints?.teamIds).toEqual(GRANTS.teamIds);
    expect(result.actorCtx.roleHints?.projectGrants).toEqual(GRANTS.projectGrants);
  });

  it("keeps the PLATFORM floor — a platform admin reads as a member here", async () => {
    resolveActorGrantsForUserInOrg.mockResolvedValue({
      ...GRANTS,
      orgRole: "org_owner" as const,
    });
    const result = await resolveWidgetLifecycleActorForFrame(FRAME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actorCtx.roleHints?.platformRole).toBe("member");
    // The ORG standing is the person's real one — the floor is platform-only.
    expect(result.actorCtx.roleHints?.orgRole).toBe("org_owner");
  });

  it("refuses when membership is gone (revoked between consent and this read)", async () => {
    resolveActorGrantsForUserInOrg.mockResolvedValue({ orgRole: undefined });
    const result = await resolveWidgetLifecycleActorForFrame(FRAME);
    expect(result).toEqual({ ok: false, reason: "not_org_member" });
    expect(emitWidgetAuthAudit).toHaveBeenCalledWith(
      "widget_lifecycle_read_rejected",
      expect.objectContaining({ reason: "not_org_member" }),
    );
  });

  it.each([
    { userId: "", orgId: "org-A" },
    { userId: "user-1", orgId: "" },
  ])("refuses a frame with no attributable principal (%o)", async (partial) => {
    const result = await resolveWidgetLifecycleActorForFrame({ ...FRAME, ...partial });
    expect(result).toEqual({ ok: false, reason: "unbound_principal" });
    expect(resolveActorGrantsForUserInOrg).not.toHaveBeenCalled();
  });

  it("audits an authorized frame read", async () => {
    await resolveWidgetLifecycleActorForFrame(FRAME);
    expect(emitWidgetAuthAudit).toHaveBeenCalledWith(
      "widget_lifecycle_read_authorized",
      expect.objectContaining({ actor: "user-1", orgId: "org-A" }),
    );
  });
});
