// The widget lifecycle actor (cinatra#2574, epic #2564 S8a).
//
// What these assertions are about: an actor that decides what a person on a
// public site may READ of their organization's lifecycle work. So they are
// written around the two ways that can go wrong — granting more than the person
// has (the token's grant, the platform floor, the org anchor) and granting less
// than the person has (the resolved team/project axes, which the runtime's
// degraded context drops).

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

import {
  WIDGET_LIFECYCLE_READ_REQUIRED_SCOPES,
  buildWidgetLifecycleRoleHints,
  resolveWidgetLifecycleActorContext,
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

  it("FLOORS the platform tier — a platform admin gets no elevated standing here", async () => {
    // The floor is unconditional: nothing in the token, the claims or the
    // resolved grants can raise it, because the resolver never asks for it.
    const r = await call();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actorCtx.roleHints?.platformRole).toBe("member");

    const hinted = buildWidgetLifecycleRoleHints({
      orgId: "org-A",
      orgRole: "org_owner",
      // Even if a caller hands it a bundle that came from a platform admin, the
      // assembled hints carry the floor.
    });
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
