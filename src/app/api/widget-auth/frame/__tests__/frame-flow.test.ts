import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#2674 (epic #2564 S8e) — THE FRAME-OWNED SIGN-IN, server side.
//
// Two routes, one property: the credential is minted for the Cinatra frame and
// reaches nothing else. The derivation is mocked at its own boundary (it has its
// own suite); everything these cases exercise — the same-origin gate, the
// generic refusals, the pair mint, the both-or-nothing rule — runs real.

const deriveFrameBinding = vi.fn();
const createAuthTransaction = vi.fn();
const redeemUserAuthCode = vi.fn();
const renewUserWidgetToken = vi.fn();
const mintWidgetTokenScope = vi.fn();
const mintWidgetTokenAudience = vi.fn();
const mintWidgetStreamToken = vi.fn();
const allowConnectTokenRequest = vi.fn();
const allowNamedRateLimit = vi.fn();

vi.mock("@/lib/widget-frame-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/widget-frame-auth")>(
    "@/lib/widget-frame-auth",
  );
  return {
    // The same-origin gate is the REAL one — it is part of what these cases test.
    isSameOriginFrameRequest: actual.isSameOriginFrameRequest,
    deriveFrameBinding: (...a: unknown[]) => deriveFrameBinding(...a),
  };
});
vi.mock("@/lib/widget-user-auth", () => ({
  createAuthTransaction: (...a: unknown[]) => createAuthTransaction(...a),
  redeemUserAuthCode: (...a: unknown[]) => redeemUserAuthCode(...a),
  renewUserWidgetToken: (...a: unknown[]) => renewUserWidgetToken(...a),
}));
// The two GRANT-COMPOSING mints. They are mocked here for one reason only: so
// the renewal arm below can assert that the route never reaches either of them.
vi.mock("@/lib/widget-lifecycle-scope", async () => {
  const actual = await vi.importActual<typeof import("@/lib/widget-lifecycle-scope")>(
    "@/lib/widget-lifecycle-scope",
  );
  return {
    ...actual,
    mintWidgetTokenScope: (...a: unknown[]) => mintWidgetTokenScope(...a),
    mintWidgetTokenAudience: (...a: unknown[]) => mintWidgetTokenAudience(...a),
  };
});
vi.mock("@/lib/widget-token-broker", () => ({
  mintWidgetStreamToken: (...a: unknown[]) => mintWidgetStreamToken(...a),
}));
vi.mock("@/lib/connect-rate-limit", () => ({
  allowConnectTokenRequest: (...a: unknown[]) => allowConnectTokenRequest(...a),
  allowNamedRateLimit: (...a: unknown[]) => allowNamedRateLimit(...a),
}));
vi.mock("@/lib/connect-provisioning", () => ({ sha256Base64Url: (v: string) => `h(${v})` }));
vi.mock("@/lib/widget-auth-audit", () => ({ emitWidgetAuthAudit: vi.fn() }));
vi.mock("@/lib/widget-stream-agents.server", () => ({
  // Keyed on the DERIVED slug: the routes never receive one from the caller.
  resolveWidgetStreamAgentUnion: async (slug: string) =>
    slug === "wordpress-content-editor"
      ? {
          entry: {
            auth: { instancesConfigKey: "wordpress", tokenConfigKey: "wordpress_widget_auth" },
          },
        }
      : null,
}));

import { POST as frameInit } from "../init/route";
import { POST as frameToken } from "../token/route";
import { POST as frameRenew, WIDGET_USER_TOKEN_HEADER } from "../renew/route";

const SELF = "https://app.cinatra.test";
const SITE = {
  siteId: "site-1",
  client: "wordpress",
  orgId: "org-A",
  siteOrigin: "https://wp.example.test",
  credentialVersion: 3,
};

const AGENT_SLUG = "wordpress-content-editor";
const SELECTORS = { assistant: "wordpress", instanceId: "inst-1" };

function frameRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${SELF}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: SELF,
      "Sec-Fetch-Site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  allowConnectTokenRequest.mockReturnValue(true);
  allowNamedRateLimit.mockReturnValue(true);
  deriveFrameBinding.mockReturnValue({
    ok: true,
    binding: {
      site: SITE,
      instanceId: "inst-1",
      agentSlug: AGENT_SLUG,
      instancesConfigKey: "wordpress",
    },
  });
  createAuthTransaction.mockReturnValue({ ok: true, txnId: "txn-1", instanceId: "inst-1" });
  redeemUserAuthCode.mockReturnValue({
    ok: true,
    token: "cwu_the_user_bearer",
    tokenType: "Bearer",
    expiresIn: 900,
    scope: "wordpress-content-editor.user lifecycle.read",
  });
  renewUserWidgetToken.mockReturnValue({
    ok: true,
    token: "cwu_the_successor_bearer",
    tokenType: "Bearer",
    expiresIn: 900,
    scope: "wordpress-content-editor.user lifecycle.read",
  });
  mintWidgetStreamToken.mockReturnValue({
    token: "cit_the_site_transport",
    tokenType: "Bearer",
    expiresIn: 600,
    expiresAt: "2026-08-12T00:00:00.000Z",
    scope: "wordpress-content-editor.stream",
  });
});

describe("POST /api/widget-auth/frame/init", () => {
  const body = {
    ...SELECTORS,
    codeChallenge: "a".repeat(43),
    codeChallengeMethod: "S256",
    state: "state-value-1234",
  };

  it("starts a transaction with NO credential presented and returns no secret", async () => {
    const res = await frameInit(frameRequest("/api/widget-auth/frame/init", body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      txnId: "txn-1",
      authorizeUrl: `${SELF}/widget-auth?txn=txn-1`,
      instanceId: "inst-1",
    });
    // Nothing bearer-shaped in the response, at all.
    expect(JSON.stringify(json)).not.toMatch(/cwu_|cit_|cnx_/);
  });

  it("pins the transaction to the SERVER-DERIVED site, instance AND agent, not to caller values", async () => {
    await frameInit(
      frameRequest("/api/widget-auth/frame/init", {
        ...body,
        siteId: "site-1",
        // codex round 0, finding 1: an agent named in the body is not read at all.
        agentSlug: "some-other-agent",
      }),
    );
    expect(createAuthTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        site: SITE,
        claimedInstanceId: "inst-1",
        agentSlug: AGENT_SLUG,
      }),
    );
    // The deriver was asked only about the assistant + instance.
    expect(deriveFrameBinding).toHaveBeenCalledWith(
      expect.objectContaining({ assistant: "wordpress", instanceId: "inst-1" }),
    );
    expect(deriveFrameBinding.mock.calls[0][0]).not.toHaveProperty("agentSlug");
  });

  it("REFUSES when the DERIVED agent does not resolve to an entry with the same connector key", async () => {
    deriveFrameBinding.mockReturnValue({
      ok: true,
      binding: {
        site: SITE,
        instanceId: "inst-1",
        agentSlug: "an-agent-that-does-not-exist",
        instancesConfigKey: "wordpress",
      },
    });
    const res = await frameInit(frameRequest("/api/widget-auth/frame/init", body));
    expect(res.status).toBe(400);
    expect(createAuthTransaction).not.toHaveBeenCalled();
  });

  it("REFUSES a cross-origin caller before reading the body", async () => {
    const res = await frameInit(
      frameRequest("/api/widget-auth/frame/init", body, { Origin: "https://wp.example.test" }),
    );
    expect(res.status).toBe(401);
    expect(createAuthTransaction).not.toHaveBeenCalled();
  });

  it("REFUSES a Sec-Fetch-Site that is not same-origin", async () => {
    const res = await frameInit(
      frameRequest("/api/widget-auth/frame/init", body, { "Sec-Fetch-Site": "cross-site" }),
    );
    expect(res.status).toBe(401);
  });

  it("answers ONE generic shape for every derivation failure — no configuration oracle", async () => {
    const bodies: string[] = [];
    for (const reason of [
      "unknown_assistant",
      "site_unresolved",
      "site_ambiguous",
      "instance_mismatch",
      "selector_mismatch",
    ]) {
      deriveFrameBinding.mockReturnValue({ ok: false, reason });
      const res = await frameInit(frameRequest("/api/widget-auth/frame/init", body));
      expect(res.status).toBe(400);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("rate-limits on TWO INDEPENDENT keys — the caller's IP and the SERVER-DERIVED site", async () => {
    // codex confirming round: the first key must be per-IP, never a constant —
    // a constant in the pair helper's code slot would have been a GLOBAL 5/min
    // cap on frame sign-ins that one caller could exhaust for every site.
    await frameInit(frameRequest("/api/widget-auth/frame/init", body));
    const keys = allowNamedRateLimit.mock.calls.map((c) => (c[0] as { key: string }).key);
    expect(keys.some((k) => k.startsWith("frame-init-ip:"))).toBe(true);
    expect(keys).toContain(`frame-init-site:${SITE.siteId}`);
    // Neither key is a constant shared across callers or sites.
    for (const key of keys) expect(key).toMatch(/:.+$/);
  });

  it("REFUSES when the per-site key is exhausted, without minting a transaction", async () => {
    allowNamedRateLimit.mockImplementation((input: { key: string }) =>
      !input.key.startsWith("frame-init-site:"),
    );
    const res = await frameInit(frameRequest("/api/widget-auth/frame/init", body));
    expect(res.status).toBe(429);
    expect(createAuthTransaction).not.toHaveBeenCalled();
  });

  it("rejects a PKCE method other than S256", async () => {
    const res = await frameInit(
      frameRequest("/api/widget-auth/frame/init", { ...body, codeChallengeMethod: "plain" }),
    );
    expect(res.status).toBe(400);
    expect(createAuthTransaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/widget-auth/frame/token", () => {
  const body = {
    ...SELECTORS,
    grantType: "authorization_code",
    code: "an-authorization-code",
    codeVerifier: "v".repeat(64),
  };

  it("returns the pair to the FRAME, and emits no CORS header any other origin could read it through", async () => {
    const res = await frameToken(frameRequest("/api/widget-auth/frame/token", body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.userToken).toBe("cwu_the_user_bearer");
    expect(json.transportToken).toBe("cit_the_site_transport");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("mints the transport token for the SERVER-DERIVED site and agent, bound to its credential generation", async () => {
    await frameToken(
      frameRequest("/api/widget-auth/frame/token", { ...body, agentSlug: "some-other-agent" }),
    );
    expect(mintWidgetStreamToken).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSlug: AGENT_SLUG,
        origin: SITE.siteOrigin,
        connectSite: { siteId: SITE.siteId, credentialVersion: SITE.credentialVersion },
      }),
    );
  });

  it("redeems against the DERIVED site — the cross-site binding gate is unchanged", async () => {
    await frameToken(frameRequest("/api/widget-auth/frame/token", body));
    expect(redeemUserAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ site: SITE, codeVerifier: body.codeVerifier }),
    );
  });

  it("BOTH OR NOTHING: a failed transport mint returns no user bearer either", async () => {
    mintWidgetStreamToken.mockReturnValue(null);
    const res = await frameToken(frameRequest("/api/widget-auth/frame/token", body));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("cwu_");
  });

  it("REFUSES a cross-origin caller", async () => {
    const res = await frameToken(
      frameRequest("/api/widget-auth/frame/token", body, { Origin: "https://wp.example.test" }),
    );
    expect(res.status).toBe(401);
    expect(redeemUserAuthCode).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain("cwu_");
  });

  it("answers a generic invalid_grant on every redeem failure", async () => {
    const bodies: string[] = [];
    for (const reason of ["invalid_grant", "site_mismatch"]) {
      redeemUserAuthCode.mockReturnValue({ ok: false, reason });
      const res = await frameToken(frameRequest("/api/widget-auth/frame/token", body));
      expect(res.status).toBe(400);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("refuses a grant type other than authorization_code", async () => {
    const res = await frameToken(
      frameRequest("/api/widget-auth/frame/token", { ...body, grantType: "password" }),
    );
    expect(res.status).toBe(400);
    expect(redeemUserAuthCode).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#3051 — POST /api/widget-auth/frame/renew
//
// The road that keeps an ALREADY-OPEN column working. It is the mint's road
// walked a second time, so the properties worth asserting are the same ones:
// the frame and nobody else reaches it, the server decides the binding, the
// credential travels where a credential should, both halves or neither, and one
// refusal shape for every reason.
// ---------------------------------------------------------------------------
describe("POST /api/widget-auth/frame/renew", () => {
  const body = { ...SELECTORS, grantType: "widget_token_renewal" };
  const HELD = "cwu_the_held_bearer";

  function renewRequest(
    overrides: { body?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    return frameRequest("/api/widget-auth/frame/renew", overrides.body ?? body, {
      [WIDGET_USER_TOKEN_HEADER]: HELD,
      ...overrides.headers,
    });
  }

  it("returns the FRESH PAIR to the frame, through no other origin", async () => {
    const res = await frameRenew(renewRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.userToken).toBe("cwu_the_successor_bearer");
    expect(json.transportToken).toBe("cit_the_site_transport");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("renews against the SERVER-DERIVED site, origin and agent, whatever the caller names", async () => {
    await frameRenew(
      renewRequest({
        body: { ...body, siteId: "some-other-site", origin: "https://not.ours.test", agentSlug: "some-other-agent" },
      }),
    );
    expect(renewUserWidgetToken).toHaveBeenCalledWith({
      token: HELD,
      agentSlug: AGENT_SLUG,
      requestOrigin: SITE.siteOrigin,
    });
    // The transport half is minted for that same derived site and generation.
    expect(mintWidgetStreamToken).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSlug: AGENT_SLUG,
        origin: SITE.siteOrigin,
        connectSite: { siteId: SITE.siteId, credentialVersion: SITE.credentialVersion },
      }),
    );
  });

  it("reads the bearer from the HEADER — a bearer in the body is not a bearer", async () => {
    const res = await frameRenew(
      frameRequest("/api/widget-auth/frame/renew", { ...body, userToken: "cwu_in_the_body" }),
    );
    expect(res.status).toBe(400);
    expect(renewUserWidgetToken).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain("cwu_");
  });

  it("BOTH OR NOTHING: a failed transport mint returns no user bearer either — and never SPENDS the held one", async () => {
    mintWidgetStreamToken.mockReturnValue(null);
    const res = await frameRenew(renewRequest());
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("cwu_");
    // The convergence round's second finding: the rotation deletes the bearer
    // the frame is holding, so a transport mint that failed AFTER it would leave
    // the column with a credential that no longer exists and no pair to replace
    // it. The half that can fail cheaply is minted FIRST, so a refusal here has
    // spent nothing at all.
    expect(renewUserWidgetToken).not.toHaveBeenCalled();
  });

  it("REFUSES a cross-origin caller before the module is asked anything", async () => {
    const res = await frameRenew(
      renewRequest({ headers: { Origin: "https://wp.example.test" } }),
    );
    expect(res.status).toBe(401);
    expect(renewUserWidgetToken).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain("cwu_");
  });

  it("answers ONE generic shape for every reason the module can refuse for", async () => {
    const bodies: string[] = [];
    for (const reason of [
      "not_cwu_token",
      "not_found",
      "expired",
      "agent_mismatch",
      "origin_mismatch",
      "session_revoked",
      "site_revoked",
      // The racer that lost: two presentations of one bearer, one successor.
      "already_rotated",
    ]) {
      renewUserWidgetToken.mockReturnValue({ ok: false, reason });
      const res = await frameRenew(renewRequest());
      expect(res.status).toBe(400);
      bodies.push(await res.text());
    }
    // A signed-out person and an unknown bearer must be indistinguishable from
    // here: the reason reaches the audit trail and nothing else.
    expect(new Set(bodies).size).toBe(1);
  });

  it("refuses a grant type other than widget_token_renewal, before the module is asked", async () => {
    const res = await frameRenew(
      renewRequest({ body: { ...body, grantType: "authorization_code" } }),
    );
    expect(res.status).toBe(400);
    expect(renewUserWidgetToken).not.toHaveBeenCalled();
  });

  it("rate-limits on the bearer's HASH, never on the bearer itself", async () => {
    await frameRenew(renewRequest());
    const [charged] = allowConnectTokenRequest.mock.calls.at(-1) as [
      { ip: string; codeKey: string },
    ];
    // The key is what the HASHER answered, never the value handed to it. (The
    // hasher is doubled as `h(x)` in this suite, so the double's answer is what
    // the assertion names; the point is that the route passes the digest and
    // does not key the bucket on the credential.)
    expect(charged.codeKey).toBe(`h(${HELD})`);
    expect(charged.codeKey).not.toBe(HELD);
  });

  it("composes NO grant of its own — neither grant-composing mint is reached", async () => {
    await frameRenew(renewRequest());
    // The successor's claims are copied off the row the module reads. A route
    // that could compose a scope or an audience here would be a route through
    // which a renewal could be wider than the sign-in that authorized it.
    expect(mintWidgetTokenScope).not.toHaveBeenCalled();
    expect(mintWidgetTokenAudience).not.toHaveBeenCalled();
  });
});
