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
const mintWidgetStreamToken = vi.fn();
const allowConnectTokenRequest = vi.fn();
const allowNamedRateLimit = vi.fn();
const emitWidgetAuthAudit = vi.fn();
const getTrustedTokenOrigins = vi.fn();

vi.mock("@/lib/widget-frame-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/widget-frame-auth")>(
    "@/lib/widget-frame-auth",
  );
  return {
    // The same-origin gate is the REAL one — it is part of what these cases test.
    resolveFrameRequestOrigin: actual.resolveFrameRequestOrigin,
    deriveFrameBinding: (...a: unknown[]) => deriveFrameBinding(...a),
  };
});
vi.mock("@/lib/widget-user-auth", () => ({
  createAuthTransaction: (...a: unknown[]) => createAuthTransaction(...a),
  redeemUserAuthCode: (...a: unknown[]) => redeemUserAuthCode(...a),
}));
vi.mock("@/lib/widget-token-broker", () => ({
  mintWidgetStreamToken: (...a: unknown[]) => mintWidgetStreamToken(...a),
}));
vi.mock("@/lib/connect-rate-limit", () => ({
  allowConnectTokenRequest: (...a: unknown[]) => allowConnectTokenRequest(...a),
  allowNamedRateLimit: (...a: unknown[]) => allowNamedRateLimit(...a),
}));
vi.mock("@/lib/connect-provisioning", () => ({ sha256Base64Url: (v: string) => `h(${v})` }));
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: (...a: unknown[]) => emitWidgetAuthAudit(...a),
}));
// cinatra#3330 — the operator-controlled canonical-origin allowlist.
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getTrustedTokenOrigins: (...a: unknown[]) => getTrustedTokenOrigins(...a),
}));
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

const SELF = "https://app.cinatra.test";
// cinatra#3330 — the saved public base origin, the address the frame is served at.
const PUBLIC_ORIGIN = "https://widget.public.test";
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
  getTrustedTokenOrigins.mockReturnValue([SELF, PUBLIC_ORIGIN]);
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

// cinatra#3330 — BOTH ROUTES BUILD THEIR PUBLIC URLS FROM THE CANONICAL ORIGIN.
//
// On a boot whose public address differs from its bind address, `request.url`
// carries the bind address. The init route's `authorizeUrl` and the token
// route's `issuerBaseUrl` must carry the canonical origin the shared gate
// matched instead — otherwise the gate would answer 200 and the frame would
// still reject an authorize URL whose origin is not its own.
describe("the frame routes agree on the canonical origin, never on request.url", () => {
  const INTERNAL = "http://127.0.0.1:3000";

  // The same POST the frame sends, as the framework presents it on such a boot:
  // an internal `request.url`, the frame's real public `Origin`.
  function internalFrameRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
    return new Request(`${INTERNAL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: PUBLIC_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        // Forged for good measure: neither is an authority.
        Host: new URL(INTERNAL).host,
        "X-Forwarded-Host": new URL(INTERNAL).host,
        "X-Forwarded-Proto": "http",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  const initBody = {
    ...SELECTORS,
    codeChallenge: "a".repeat(43),
    codeChallengeMethod: "S256",
    state: "state-value-1234",
  };
  const tokenBody = {
    ...SELECTORS,
    grantType: "authorization_code",
    code: "code-1",
    codeVerifier: "v".repeat(43),
  };

  it("init PASSES the gate and returns an authorizeUrl on the CANONICAL public origin, not on request.url", async () => {
    const res = await frameInit(internalFrameRequest("/api/widget-auth/frame/init", initBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorizeUrl).toBe(`${PUBLIC_ORIGIN}/widget-auth?txn=txn-1`);
    expect(json.authorizeUrl).not.toContain(new URL(INTERNAL).host);
  });

  it("token PASSES the gate and issues against the CANONICAL public origin, not against request.url", async () => {
    const res = await frameToken(internalFrameRequest("/api/widget-auth/frame/token", tokenBody));
    expect(res.status).toBe(200);
    expect(redeemUserAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ issuerBaseUrl: PUBLIC_ORIGIN }),
    );
    expect(mintWidgetStreamToken).toHaveBeenCalledWith(
      expect.objectContaining({ issuerBaseUrl: PUBLIC_ORIGIN }),
    );
  });

  it("the two routes agree: the init authorizeUrl origin IS the token issuer", async () => {
    const initRes = await frameInit(internalFrameRequest("/api/widget-auth/frame/init", initBody));
    const { authorizeUrl } = await initRes.json();
    await frameToken(internalFrameRequest("/api/widget-auth/frame/token", tokenBody));
    const issuer = redeemUserAuthCode.mock.calls[0][0].issuerBaseUrl;
    expect(new URL(authorizeUrl).origin).toBe(issuer);
  });

  it("a mismatching Origin still fails on BOTH routes with the audit reason unchanged", async () => {
    const initRes = await frameInit(
      internalFrameRequest("/api/widget-auth/frame/init", initBody, {
        Origin: "https://wp.example.test",
      }),
    );
    expect(initRes.status).toBe(401);
    expect(emitWidgetAuthAudit).toHaveBeenCalledWith(
      "init_failure",
      expect.objectContaining({ reason: "not_same_origin" }),
    );

    emitWidgetAuthAudit.mockClear();
    const tokenRes = await frameToken(
      internalFrameRequest("/api/widget-auth/frame/token", tokenBody, {
        Origin: "https://wp.example.test",
      }),
    );
    expect(tokenRes.status).toBe(401);
    expect(emitWidgetAuthAudit).toHaveBeenCalledWith(
      "redeem_failure",
      expect.objectContaining({ reason: "not_same_origin" }),
    );
  });

  it("a forged Host and forwarded headers naming the canonical host do NOT buy a foreign Origin either route", async () => {
    const publicHost = new URL(PUBLIC_ORIGIN).host;
    const forged = {
      Origin: "https://wp.example.test",
      Host: publicHost,
      "X-Forwarded-Host": publicHost,
      "X-Forwarded-Proto": "https",
    };
    expect(
      (await frameInit(internalFrameRequest("/api/widget-auth/frame/init", initBody, forged)))
        .status,
    ).toBe(401);
    expect(
      (await frameToken(internalFrameRequest("/api/widget-auth/frame/token", tokenBody, forged)))
        .status,
    ).toBe(401);
    expect(createAuthTransaction).not.toHaveBeenCalled();
    expect(redeemUserAuthCode).not.toHaveBeenCalled();
  });

  it("REFUSES both routes when the Origin is an allowlist member's near-miss on port or scheme", async () => {
    for (const nearMiss of ["http://widget.public.test", "https://widget.public.test:8443"]) {
      expect(
        (await frameInit(
          internalFrameRequest("/api/widget-auth/frame/init", initBody, { Origin: nearMiss }),
        )).status,
      ).toBe(401);
      expect(
        (await frameToken(
          internalFrameRequest("/api/widget-auth/frame/token", tokenBody, { Origin: nearMiss }),
        )).status,
      ).toBe(401);
    }
    expect(createAuthTransaction).not.toHaveBeenCalled();
    expect(redeemUserAuthCode).not.toHaveBeenCalled();
    expect(mintWidgetStreamToken).not.toHaveBeenCalled();
  });
});
