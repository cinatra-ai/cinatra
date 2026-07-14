import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// resolveActorIdentity composition tests
//
// resolveActorIdentity is a pure function that composes 3 identity sources into
// a COHERENT `{ userId, orgId }` pair (#1545):
//   1. cookie session (sessionUser.id)        — wins; orgId:null (transport owns
//                                                the session's activeOrganizationId)
//   2. Bearer JWT clientId → service_accounts row → { created_by, org_id }
//      — the org is composed from the SAME row (the #1545 fix: previously only
//      userId was carried and organizationId dropped, leaving Bearer callers
//      org-less so the boundary denied `not_org_member`).
//   3. localhost dev fallback (A2A_DEV_BYPASS + isLocalhostRequest) → first admin;
//      orgId:null (transport's A2A first-org fallback owns the dev org)
//
// Wired into mcpRequestContextStorage.{userId,orgId} by the transport handler in
// packages/mcp-server/src/index.tsx.
// ---------------------------------------------------------------------------

const queryMock = vi.fn();

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthPool: {
    query: (...args: unknown[]) => queryMock(...args),
  },
  betterAuthDb: {},
}));

import { resolveActorIdentity, pickServerDerivedOrgId, orgMembershipExists } from "../actor-identity";

function makeRequest(host: string = "localhost"): Request {
  return new Request(`http://${host}/api/mcp`, { method: "POST" });
}

describe("resolveActorIdentity composition", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("returns sessionUser.id with orgId:null when cookie session present (regression)", async () => {
    const identity = await resolveActorIdentity({
      sessionUser: { id: "session-user-1" },
      requestClientId: undefined,
      request: makeRequest(),
      env: { A2A_DEV_BYPASS: "true" },
      isLocalhost: true,
      readServiceAccount: async () => ({ userId: "sa-user", organizationId: "sa-org" }),
      pool: { query: queryMock as never },
    });
    // Cookie wins; the service-account is NOT consulted, and orgId stays null so
    // the transport's session.activeOrganizationId remains the coherent source.
    expect(identity).toEqual({ userId: "session-user-1", orgId: null });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("composes Bearer service-account { created_by, org_id } when the creator is a live member — the #1545 org fix", async () => {
    // The live-membership gate finds a `public.member` row for {org_id, created_by}.
    queryMock.mockResolvedValueOnce({ rows: [{ one: 1 }] });
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: "client-xyz",
      request: makeRequest(),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: async (cid: string) => {
        expect(cid).toBe("client-xyz");
        return { userId: "sa-user-42", organizationId: "sa-org-7" };
      },
      pool: { query: queryMock as never },
    });
    // BOTH ids carried from the SAME row — the org is no longer dropped.
    expect(identity).toEqual({ userId: "sa-user-42", orgId: "sa-org-7" });
    // Exactly one query: the {org_id, created_by} membership existence check.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('public."member"'),
      ["sa-org-7", "sa-user-42"],
    );
  });

  it("stays org-less when the service-account creator is NO LONGER a live org member (fail-closed, #1545 regression guard)", async () => {
    // No `public.member` row for {org_id, created_by}: the creator was removed
    // but the service_accounts row still carries the stale org_id. Composing it
    // would re-admit an ex-member and change the `not_org_member` deny contract.
    queryMock.mockResolvedValueOnce({ rows: [] });
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: "client-exmember",
      request: makeRequest("example.com"),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: async () => ({ userId: "ex-member", organizationId: "org-left" }),
      pool: { query: queryMock as never },
    });
    // userId still carried (audit/provenance); org-less → boundary denies.
    expect(identity).toEqual({ userId: "ex-member", orgId: null });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed to org-less when the membership check throws", async () => {
    queryMock.mockRejectedValueOnce(new Error("db down"));
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: "client-dberr",
      request: makeRequest("example.com"),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: async () => ({ userId: "sa-user-err", organizationId: "org-err" }),
      pool: { query: queryMock as never },
    });
    // A transient DB error must never admit an unverified org binding.
    expect(identity).toEqual({ userId: "sa-user-err", orgId: null });
  });

  it("carries orgId:null when the service-account row has a null org_id (no membership check attempted)", async () => {
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: "client-orgless",
      request: makeRequest(),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: async () => ({ userId: "sa-user-9", organizationId: null }),
      pool: { query: queryMock as never },
    });
    // Org genuinely absent → orgId:null → the boundary denies `not_org_member`
    // (no silent first-membership pick); the membership check is short-circuited.
    expect(identity).toEqual({ userId: "sa-user-9", orgId: null });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("resolves first-admin id with orgId:null when no cookie + A2A_DEV_BYPASS + localhost", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "admin-1" }] });
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: undefined,
      request: makeRequest(),
      env: { A2A_DEV_BYPASS: "true" },
      isLocalhost: true,
      readServiceAccount: async () => null,
      pool: { query: queryMock as never },
    });
    expect(identity).toEqual({ userId: "admin-1", orgId: null });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("returns { null, null } when Bearer with inactive service-account + non-localhost", async () => {
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: "client-revoked",
      request: makeRequest("example.com"),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: async () => null, // inactive returns null
      pool: { query: queryMock as never },
    });
    expect(identity).toEqual({ userId: null, orgId: null });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns { null, null } when no cookie + no token + non-localhost", async () => {
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: undefined,
      request: makeRequest("example.com"),
      env: { A2A_DEV_BYPASS: "true" },
      isLocalhost: false, // not localhost — fallback must NOT fire
      readServiceAccount: async () => null,
      pool: { query: queryMock as never },
    });
    expect(identity).toEqual({ userId: null, orgId: null });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns { null, null } when localhost + A2A_DEV_BYPASS but DB lookup throws", async () => {
    queryMock.mockRejectedValueOnce(new Error("db down"));
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: undefined,
      request: makeRequest(),
      env: { A2A_DEV_BYPASS: "true" },
      isLocalhost: true,
      readServiceAccount: async () => null,
      pool: { query: queryMock as never },
    });
    expect(identity).toEqual({ userId: null, orgId: null });
  });
});

// ---------------------------------------------------------------------------
// pickServerDerivedOrgId — the transport's Bearer-org precedence + coherence
// gate (#1545). Pins the exact composition order and the fail-closed absence,
// so the deny contracts for org-less identities stay unchanged before + after.
// ---------------------------------------------------------------------------
describe("pickServerDerivedOrgId precedence + coherence", () => {
  it("adopts the service-account org when no higher-precedence org resolved (the fix)", () => {
    const org = pickServerDerivedOrgId({
      currentOrgId: null,
      actorIdentity: { userId: "sa-user-42", orgId: "sa-org-7" },
      resolvedUserId: "sa-user-42",
    });
    expect(org).toBe("sa-org-7");
  });

  it("never overrides an already-resolved org (delegated OBO / cookie / trusted-dev win)", () => {
    const org = pickServerDerivedOrgId({
      // e.g. delegatedActor.orgId or session.activeOrganizationId already set.
      currentOrgId: "higher-precedence-org",
      actorIdentity: { userId: "sa-user-42", orgId: "sa-org-7" },
      resolvedUserId: "sa-user-42",
    });
    expect(org).toBe("higher-precedence-org");
  });

  it("refuses an org NOT coherently paired with the resolved userId (never cross-pairs)", () => {
    const org = pickServerDerivedOrgId({
      currentOrgId: null,
      actorIdentity: { userId: "sa-user-42", orgId: "sa-org-7" },
      // resolvedUserId came from delegated/trusted-dev, not this service account.
      resolvedUserId: "delegated-human-user",
    });
    expect(org).toBeNull();
  });

  it("stays org-less (fail-closed) for an identity with no server-derivable org", () => {
    expect(
      pickServerDerivedOrgId({
        currentOrgId: null,
        actorIdentity: { userId: "sa-user-9", orgId: null },
        resolvedUserId: "sa-user-9",
      }),
    ).toBeNull();
  });

  it("stays org-less when there is no actor identity at all (unauthenticated)", () => {
    expect(
      pickServerDerivedOrgId({
        currentOrgId: null,
        actorIdentity: null,
        resolvedUserId: null,
      }),
    ).toBeNull();
  });

  it("does not adopt an org paired with a null userId", () => {
    expect(
      pickServerDerivedOrgId({
        currentOrgId: null,
        actorIdentity: { userId: null, orgId: "orphan-org" },
        resolvedUserId: null,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// orgMembershipExists — the live-membership gate (#1545). Queries the exact
// {organizationId, userId} pair and fails CLOSED on error.
// ---------------------------------------------------------------------------
describe("orgMembershipExists live-membership gate", () => {
  const q = vi.fn();
  beforeEach(() => q.mockReset());

  it("returns true when a member row exists (queries the exact pair)", async () => {
    q.mockResolvedValueOnce({ rows: [{ one: 1 }] });
    const ok = await orgMembershipExists({
      orgId: "org-1",
      userId: "user-1",
      pool: { query: q as never },
    });
    expect(ok).toBe(true);
    expect(q).toHaveBeenCalledWith(expect.stringContaining('public."member"'), ["org-1", "user-1"]);
  });

  it("returns false when no member row exists", async () => {
    q.mockResolvedValueOnce({ rows: [] });
    expect(
      await orgMembershipExists({ orgId: "org-1", userId: "gone", pool: { query: q as never } }),
    ).toBe(false);
  });

  it("fails closed (false) when the query throws", async () => {
    q.mockRejectedValueOnce(new Error("db down"));
    expect(
      await orgMembershipExists({ orgId: "org-1", userId: "user-1", pool: { query: q as never } }),
    ).toBe(false);
  });
});
