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

import {
  resolveActorIdentity,
  pickServerDerivedOrgId,
  orgMembershipExists,
  composeBearerActorContext,
  resolveSoleOrgMembership,
  decodeBearerSub,
} from "../actor-identity";

function makeRequest(host: string = "localhost"): Request {
  return new Request(`http://${host}/api/mcp`, { method: "POST" });
}

/** base64url-encode a JS value (JWT segment). */
function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Build a `Bearer <jwt>` header carrying the given claims. Signature-free
 * (the transport verifies BEFORE this decode runs; the tests exercise the
 * post-verify claim decode only). `authorization_code` tokens carry a `sub`
 * (the real user id) AND `azp` (the OAuth client) — both are set by default so
 * a test can assert the sub-arm wins over the azp/service-account arm.
 */
function bearerWithClaims(claims: Record<string, unknown>): string {
  const header = b64url({ alg: "none", typ: "JWT" });
  const payload = b64url(claims);
  return `Bearer ${header}.${payload}.sig`;
}

/** An authorization_code-shaped header: a human `sub` AND a client `azp`. */
function humanBearer(sub: string, azp = "human-oauth-client"): string {
  return bearerWithClaims({ sub, azp, scope: "openid" });
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

  // --- #1592: human authorization_code Bearer arm (sub-present) ------------

  it("composes { sub, sole-org } for a human authorization_code Bearer with EXACTLY ONE live membership (#1592)", async () => {
    // The sole-membership lookup finds exactly one `public.member` row.
    queryMock.mockResolvedValueOnce({ rows: [{ organizationId: "org-solo" }] });
    const readServiceAccount = vi.fn(async () => null);
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: "human-oauth-client", // azp — must NOT drive resolution
      authHeader: humanBearer("human-user-1"),
      request: makeRequest("example.com"),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: readServiceAccount as never,
      pool: { query: queryMock as never },
    });
    // userId is the verified `sub`; org is the sole live membership.
    expect(identity).toEqual({ userId: "human-user-1", orgId: "org-solo" });
    // The sub arm runs BEFORE the service-account arm: azp lookup never fires.
    expect(readServiceAccount).not.toHaveBeenCalled();
    // Exactly one query: the sole-membership lookup (LIMIT 2, WHERE userId).
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('public."member"'),
      ["human-user-1"],
    );
  });

  it("stays org-less for a human Bearer with ZERO memberships (fail-closed, #1592)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: undefined,
      authHeader: humanBearer("human-nomember"),
      request: makeRequest("example.com"),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: async () => null,
      pool: { query: queryMock as never },
    });
    // userId still carried (audit); org-less → boundary denies not_org_member.
    expect(identity).toEqual({ userId: "human-nomember", orgId: null });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("stays org-less for a human Bearer with MULTIPLE memberships — no silent first-of-many pick (#1592)", async () => {
    // >1 row: an ambiguous multi-org identity with no cookieless active-org
    // signal → org-less (mirrors the #1545 pickServerDerivedOrgId doctrine).
    queryMock.mockResolvedValueOnce({
      rows: [{ organizationId: "org-a" }, { organizationId: "org-b" }],
    });
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: undefined,
      authHeader: humanBearer("human-multi"),
      request: makeRequest("example.com"),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: async () => null,
      pool: { query: queryMock as never },
    });
    expect(identity).toEqual({ userId: "human-multi", orgId: null });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed to org-less when the human sole-membership query throws (#1592)", async () => {
    queryMock.mockRejectedValueOnce(new Error("db down"));
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: undefined,
      authHeader: humanBearer("human-dberr"),
      request: makeRequest("example.com"),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: async () => null,
      pool: { query: queryMock as never },
    });
    expect(identity).toEqual({ userId: "human-dberr", orgId: null });
  });

  it("routes a token carrying BOTH azp and sub to the human arm, never the service-account arm (#1592)", async () => {
    // The real authorization_code shape: azp (OAuth client) AND sub (user id).
    // Guards against the CLI verified-bearer branch-order defect (azp-first).
    queryMock.mockResolvedValueOnce({ rows: [{ organizationId: "org-solo" }] });
    const readServiceAccount = vi.fn(async () => ({
      userId: "SHOULD-NOT-BE-USED",
      organizationId: "SA-ORG-SHOULD-NOT-BE-USED",
    }));
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: "human-oauth-client", // the azp — a valid client id
      authHeader: humanBearer("human-both", "human-oauth-client"),
      request: makeRequest("example.com"),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: readServiceAccount as never,
      pool: { query: queryMock as never },
    });
    expect(identity).toEqual({ userId: "human-both", orgId: "org-solo" });
    expect(readServiceAccount).not.toHaveBeenCalled();
  });

  it("falls through to the service-account arm when the token has NO sub (client_credentials unaffected, #1592)", async () => {
    // A client_credentials JWT carries azp but no sub → the human arm is skipped
    // and the existing service-account resolution is unchanged.
    queryMock.mockResolvedValueOnce({ rows: [{ one: 1 }] });
    const identity = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: "machine-client",
      authHeader: bearerWithClaims({ azp: "machine-client", scope: "mcp" }),
      request: makeRequest("example.com"),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: async () => ({ userId: "sa-user", organizationId: "sa-org" }),
      pool: { query: queryMock as never },
    });
    // Resolved via the service-account arm (created_by + membership-gated org).
    expect(identity).toEqual({ userId: "sa-user", orgId: "sa-org" });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('public."member"'),
      ["sa-org", "sa-user"],
    );
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

// ---------------------------------------------------------------------------
// resolveSoleOrgMembership — the human arm's server-derived org (#1592).
// Composes the org ONLY on EXACTLY ONE live `public.member` row (deterministic
// sole membership); 0 or >1 rows → org-less (no silent first-of-many pick);
// fails CLOSED on error. Queries by userId with LIMIT 2 (enough to detect >1).
// ---------------------------------------------------------------------------
describe("resolveSoleOrgMembership sole-membership gate", () => {
  const q = vi.fn();
  beforeEach(() => q.mockReset());

  it("returns the org when EXACTLY one membership row exists (queries userId, LIMIT 2)", async () => {
    q.mockResolvedValueOnce({ rows: [{ organizationId: "org-solo" }] });
    const org = await resolveSoleOrgMembership({
      userId: "user-1",
      pool: { query: q as never },
    });
    expect(org).toBe("org-solo");
    expect(q).toHaveBeenCalledWith(
      expect.stringContaining('public."member"'),
      ["user-1"],
    );
    expect(q).toHaveBeenCalledWith(expect.stringContaining("LIMIT 2"), ["user-1"]);
  });

  it("returns null when NO membership row exists (0 rows)", async () => {
    q.mockResolvedValueOnce({ rows: [] });
    expect(
      await resolveSoleOrgMembership({ userId: "gone", pool: { query: q as never } }),
    ).toBeNull();
  });

  it("returns null when MULTIPLE membership rows exist (no silent pick)", async () => {
    q.mockResolvedValueOnce({
      rows: [{ organizationId: "org-a" }, { organizationId: "org-b" }],
    });
    expect(
      await resolveSoleOrgMembership({ userId: "multi", pool: { query: q as never } }),
    ).toBeNull();
  });

  it("returns null when the sole row has a null organizationId", async () => {
    q.mockResolvedValueOnce({ rows: [{ organizationId: null }] });
    expect(
      await resolveSoleOrgMembership({ userId: "user-1", pool: { query: q as never } }),
    ).toBeNull();
  });

  it("fails closed (null) when the query throws", async () => {
    q.mockRejectedValueOnce(new Error("db down"));
    expect(
      await resolveSoleOrgMembership({ userId: "user-1", pool: { query: q as never } }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decodeBearerSub — the grant-type discriminator (#1592). Returns the `sub`
// claim (the human user id) ONLY; undefined for a client_credentials token
// (no sub) or any malformed input. `azp` is deliberately NOT consulted (it is
// set for BOTH grants and cannot discriminate).
// ---------------------------------------------------------------------------
describe("decodeBearerSub", () => {
  it("returns the sub claim for a human authorization_code token (with azp present)", () => {
    expect(decodeBearerSub(humanBearer("human-1", "some-client"))).toBe("human-1");
  });

  it("returns the sub even without the `Bearer ` prefix", () => {
    const withPrefix = humanBearer("human-2");
    expect(decodeBearerSub(withPrefix.slice("Bearer ".length))).toBe("human-2");
  });

  it("returns undefined for a client_credentials token (azp only, no sub)", () => {
    expect(decodeBearerSub(bearerWithClaims({ azp: "machine", scope: "mcp" }))).toBeUndefined();
  });

  it("returns undefined when sub is not a string", () => {
    expect(decodeBearerSub(bearerWithClaims({ sub: 12345 }))).toBeUndefined();
  });

  it("returns undefined for a non-3-part token", () => {
    expect(decodeBearerSub("Bearer not.a.jwt.token")).toBeUndefined();
    expect(decodeBearerSub("Bearer opaque-token")).toBeUndefined();
  });

  it("returns undefined for null / undefined / empty header", () => {
    expect(decodeBearerSub(null)).toBeUndefined();
    expect(decodeBearerSub(undefined)).toBeUndefined();
    expect(decodeBearerSub("Bearer ")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// composeBearerActorContext — the transport-level composition (#1545). Wraps
// resolveActorIdentity + pickServerDerivedOrgId and preserves the exact
// delegated/trusted-dev short-circuit (no DB read for those callers), so the
// Bearer service-account org is only consulted when neither applies and never
// overrides a higher-precedence org.
// ---------------------------------------------------------------------------
describe("composeBearerActorContext", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("short-circuits on a delegated OBO userId — no DB read, higher-precedence org preserved", async () => {
    const readServiceAccount = vi.fn(async () => ({ userId: "sa", organizationId: "sa-org" }));
    const ctx = await composeBearerActorContext({
      currentOrgId: "obo-org", // delegated OBO org already resolved (precedence #1)
      delegatedUserId: "human-chat-user",
      trustedDevAdminUserId: null,
      sessionUser: undefined,
      requestClientId: "client-xyz",
      request: makeRequest(),
      a2aDevBypass: "false",
      isLocalhost: false,
      readServiceAccount: readServiceAccount as never,
      pool: { query: queryMock as never },
    });
    expect(ctx).toEqual({ resolvedUserId: "human-chat-user", resolvedOrgId: "obo-org" });
    // resolveActorIdentity is NOT consulted for a delegated caller.
    expect(readServiceAccount).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("short-circuits on a trusted-dev admin userId — no DB read, coherent org preserved", async () => {
    const readServiceAccount = vi.fn(async () => null);
    const ctx = await composeBearerActorContext({
      currentOrgId: "trusted-dev-org", // trusted-dev coherent pair already set (precedence #3)
      delegatedUserId: null,
      trustedDevAdminUserId: "dev-admin",
      sessionUser: undefined,
      requestClientId: undefined,
      request: makeRequest(),
      a2aDevBypass: "true",
      isLocalhost: true,
      readServiceAccount: readServiceAccount as never,
      pool: { query: queryMock as never },
    });
    expect(ctx).toEqual({ resolvedUserId: "dev-admin", resolvedOrgId: "trusted-dev-org" });
    expect(readServiceAccount).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("composes the verified-Bearer service-account org when no higher-precedence org and creator is a live member (the #1545 fix)", async () => {
    // Live-membership gate finds a public.member row for {org_id, created_by}.
    queryMock.mockResolvedValueOnce({ rows: [{ one: 1 }] });
    const ctx = await composeBearerActorContext({
      currentOrgId: null,
      delegatedUserId: null,
      trustedDevAdminUserId: null,
      sessionUser: undefined,
      requestClientId: "client-xyz",
      request: makeRequest("example.com"),
      a2aDevBypass: "false",
      isLocalhost: false,
      readServiceAccount: (async () => ({ userId: "sa-user-42", organizationId: "sa-org-7" })) as never,
      pool: { query: queryMock as never },
    });
    expect(ctx).toEqual({ resolvedUserId: "sa-user-42", resolvedOrgId: "sa-org-7" });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("never overrides a higher-precedence org even when the service-account arm resolves one", async () => {
    // No delegated/trusted-dev, so resolveActorIdentity IS consulted and would
    // resolve sa-org-7 — but a cookie/OBO org already occupies currentOrgId.
    queryMock.mockResolvedValueOnce({ rows: [{ one: 1 }] });
    const ctx = await composeBearerActorContext({
      currentOrgId: "cookie-active-org", // precedence #2 already set
      delegatedUserId: null,
      trustedDevAdminUserId: null,
      sessionUser: undefined,
      requestClientId: "client-xyz",
      request: makeRequest("example.com"),
      a2aDevBypass: "false",
      isLocalhost: false,
      readServiceAccount: (async () => ({ userId: "sa-user-42", organizationId: "sa-org-7" })) as never,
      pool: { query: queryMock as never },
    });
    // userId comes from the resolved service-account identity; org stays the
    // higher-precedence one (server-derived Bearer org never overrides it).
    expect(ctx).toEqual({ resolvedUserId: "sa-user-42", resolvedOrgId: "cookie-active-org" });
  });

  it("stays fully org-less + user-less for an unauthenticated caller (fail-closed)", async () => {
    const ctx = await composeBearerActorContext({
      currentOrgId: null,
      delegatedUserId: null,
      trustedDevAdminUserId: null,
      sessionUser: undefined,
      requestClientId: undefined,
      request: makeRequest("example.com"),
      a2aDevBypass: "true",
      isLocalhost: false, // not localhost — dev fallback must not fire
      readServiceAccount: (async () => null) as never,
      pool: { query: queryMock as never },
    });
    expect(ctx).toEqual({ resolvedUserId: null, resolvedOrgId: null });
    expect(queryMock).not.toHaveBeenCalled();
  });

  // --- #1592: human authorization_code composition through the same gate ----

  it("composes the human authorization_code { sub, sole-org } through pickServerDerivedOrgId (#1592)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ organizationId: "org-solo" }] });
    const ctx = await composeBearerActorContext({
      currentOrgId: null,
      delegatedUserId: null,
      trustedDevAdminUserId: null,
      sessionUser: undefined,
      requestClientId: "human-oauth-client",
      authHeader: humanBearer("human-user-1"),
      request: makeRequest("example.com"),
      a2aDevBypass: "false",
      isLocalhost: false,
      readServiceAccount: (async () => null) as never,
      pool: { query: queryMock as never },
    });
    expect(ctx).toEqual({ resolvedUserId: "human-user-1", resolvedOrgId: "org-solo" });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("never overrides a higher-precedence org for a human Bearer (cookie/OBO org wins; #1592)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ organizationId: "org-solo" }] });
    const ctx = await composeBearerActorContext({
      currentOrgId: "cookie-active-org", // precedence #2 already set
      delegatedUserId: null,
      trustedDevAdminUserId: null,
      sessionUser: undefined,
      requestClientId: "human-oauth-client",
      authHeader: humanBearer("human-user-1"),
      request: makeRequest("example.com"),
      a2aDevBypass: "false",
      isLocalhost: false,
      readServiceAccount: (async () => null) as never,
      pool: { query: queryMock as never },
    });
    // userId comes from the human sub; org stays the higher-precedence one.
    expect(ctx).toEqual({ resolvedUserId: "human-user-1", resolvedOrgId: "cookie-active-org" });
  });

  it("suppresses the human arm for a delegated OBO caller — no DB read, OBO identity wins (#1592)", async () => {
    // The transport passes authHeader:null for a delegated token; even if a raw
    // header leaked through, delegatedUserId short-circuits resolveActorIdentity.
    const ctx = await composeBearerActorContext({
      currentOrgId: "obo-org",
      delegatedUserId: "human-chat-user",
      trustedDevAdminUserId: null,
      sessionUser: undefined,
      requestClientId: undefined,
      authHeader: null,
      request: makeRequest(),
      a2aDevBypass: "false",
      isLocalhost: false,
      readServiceAccount: (async () => null) as never,
      pool: { query: queryMock as never },
    });
    expect(ctx).toEqual({ resolvedUserId: "human-chat-user", resolvedOrgId: "obo-org" });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
