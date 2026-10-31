import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#4217 — POST /api/widget-auth/frame/renew, server side.
//
// The frame renews the pair it holds by presenting its CURRENT `cwu_` in the
// header it already sends on every broker call. Without a valid current token
// there is no renewal: nothing is minted, and the answer is the same generic
// refusal every other frame-auth failure gets. The token verdict is mocked at its
// own boundary (widget-user-auth.test.ts proves it); the same-origin gate, the
// header read, the order of the two mints and the refusals run real here.
//
// RED ON MAIN: the route file src/app/api/widget-auth/frame/renew/route.ts does
// not exist at main (the frame has /init and /token only — frame/token/route.ts:1-202
// and its header comment), so the import below fails and the suite cannot load.

const deriveFrameBinding = vi.fn();
const renewUserWidgetToken = vi.fn();
const mintWidgetStreamToken = vi.fn();
const allowConnectTokenRequest = vi.fn();
const allowNamedRateLimit = vi.fn();
const emitWidgetAuthAudit = vi.fn();
const getTrustedTokenOrigins = vi.fn();
const resolveWidgetStreamAgentUnion = vi.fn();
const KNOWN_AGENT = async (slug: string) =>
  slug === "wordpress-content-editor"
    ? {
        entry: {
          auth: { instancesConfigKey: "wordpress", tokenConfigKey: "wordpress_widget_auth" },
        },
      }
    : null;

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
  renewUserWidgetToken: (...a: unknown[]) => renewUserWidgetToken(...a),
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
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getTrustedTokenOrigins: (...a: unknown[]) => getTrustedTokenOrigins(...a),
}));
vi.mock("@/lib/widget-stream-agents.server", () => ({
  resolveWidgetStreamAgentUnion: (...a: unknown[]) => resolveWidgetStreamAgentUnion(...a),
}));

import { POST as frameRenew } from "../renew/route";

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
const RENEW_PATH = "/api/widget-auth/frame/renew";
const CURRENT = "cwu_the_current_bearer";

function frameRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${SELF}${RENEW_PATH}`, {
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
  getTrustedTokenOrigins.mockReturnValue([SELF]);
  resolveWidgetStreamAgentUnion.mockImplementation(KNOWN_AGENT);
  deriveFrameBinding.mockReturnValue({
    ok: true,
    binding: {
      site: SITE,
      instanceId: "inst-1",
      agentSlug: AGENT_SLUG,
      instancesConfigKey: "wordpress",
    },
  });
  renewUserWidgetToken.mockReturnValue({
    ok: true,
    token: "cwu_the_renewed_bearer",
    tokenType: "Bearer",
    expiresIn: 900,
    sessionExpiresIn: 27_000,
    scope: "wordpress-content-editor.user lifecycle.read",
    userId: "user-1",
  });
  mintWidgetStreamToken.mockReturnValue({
    token: "cit_the_site_transport",
    tokenType: "Bearer",
    expiresIn: 300,
    expiresAt: "2026-08-12T00:00:00.000Z",
    scope: "wordpress-content-editor.stream",
  });
});

describe("POST /api/widget-auth/frame/renew (cinatra#4217)", () => {
  // (d) Acceptance 2, fourth item.
  it("a renewal request without a valid current token is refused", async () => {
    // Control: WITH the current token the frame gets a new pair, user token first.
    const ok = await frameRenew(frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      userToken: "cwu_the_renewed_bearer",
      transportToken: "cit_the_site_transport",
      tokenType: "Bearer",
      expiresIn: 300,
      userExpiresIn: 900,
      sessionExpiresIn: 27_000,
      scope: "wordpress-content-editor.user lifecycle.read",
    });
    expect(renewUserWidgetToken).toHaveBeenCalledWith({
      token: CURRENT,
      agentSlug: AGENT_SLUG,
      site: SITE,
    });
    expect(renewUserWidgetToken.mock.invocationCallOrder[0]).toBeLessThan(
      mintWidgetStreamToken.mock.invocationCallOrder[0],
    );

    // [label, request, arrange, whether the token verifier is asked at all]
    const refusals: Array<[string, Request, () => void, boolean]> = [
      ["no current token at all", frameRequest(SELECTORS), () => {}, false],
      [
        "a token carried in the body instead of the header",
        frameRequest({ ...SELECTORS, userToken: CURRENT }),
        () => {},
        false,
      ],
      [
        "a blank header",
        frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": "   " }),
        () => {},
        false,
      ],
      [
        "a token the verifier refuses (expired, revoked, spent or foreign)",
        frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT }),
        () => renewUserWidgetToken.mockReturnValueOnce({ ok: false, reason: "expired" }),
        true,
      ],
    ];
    for (const [label, request, arrange, asksVerifier] of refusals) {
      // Calls only; the defaults set in beforeEach stay in place.
      vi.clearAllMocks();
      arrange();
      const res = await frameRenew(request);
      expect(res.status, label).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text), label).toEqual({ error: "invalid_grant" });
      expect(text, `${label}: no bearer in the answer`).not.toMatch(/cwu_|cit_|cnx_/);
      expect(mintWidgetStreamToken, `${label}: no transport token minted`).not.toHaveBeenCalled();
      expect(
        emitWidgetAuthAudit.mock.calls.some(([event]) => event === "renew_failure"),
        `${label}: the refusal is audited`,
      ).toBe(true);
      // No header, no renewal: a body field is never read as a credential.
      expect(renewUserWidgetToken, `${label}: verifier asked`).toHaveBeenCalledTimes(
        asksVerifier ? 1 : 0,
      );
    }
  });
});

describe("the renewal's rate limit (cinatra#4217)", () => {
  it("is charged to the sign-in's own buckets, keyed on the token's hash", async () => {
    const ok = await frameRenew(
      frameRequest(SELECTORS, {
        "X-Cinatra-Widget-User-Token": CURRENT,
        "X-Forwarded-For": "2001:db8::7",
      }),
    );
    expect(ok.status).toBe(200);
    // sha256Base64Url is mocked as h(v): the token bucket is keyed on the hash.
    expect(allowConnectTokenRequest).toHaveBeenCalledTimes(1);
    expect(allowConnectTokenRequest).toHaveBeenCalledWith({
      ip: "2001:db8::7",
      codeKey: `h(${CURRENT})`,
    });
    expect(allowNamedRateLimit, "no bucket of the renewal's own").not.toHaveBeenCalled();
  });

  it("an exhausted bucket refuses with 429 before the token is verified, renewed or minted", async () => {
    allowConnectTokenRequest.mockReturnValue(false);
    const refused = await frameRenew(frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "invalid_grant" });
    expect(renewUserWidgetToken).not.toHaveBeenCalled();
    expect(mintWidgetStreamToken).not.toHaveBeenCalled();
    expect(
      emitWidgetAuthAudit.mock.calls.some(([event]) => event === "renew_failure"),
      "the refusal is audited",
    ).toBe(true);
  });
});

// cinatra#4217 — a malformed body is refused BEFORE the limiter.
// RED BEFORE THE CURE: the object guard read `typeof parsed !== "object"`, and a
// JSON array is an object to `typeof`, so `[]` passed it, spent the shared
// limiter's quota and went on to the binding.
describe("a malformed body (cinatra#4217)", () => {
  function rawRequest(raw: string) {
    return new Request(`${SELF}${RENEW_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: SELF,
        "Sec-Fetch-Site": "same-origin",
        "X-Cinatra-Widget-User-Token": CURRENT,
      },
      body: raw,
    });
  }

  it.each([
    ["an empty JSON array", "[]"],
    ["an array that holds the selectors", JSON.stringify([SELECTORS])],
    ["a JSON string", JSON.stringify("wordpress")],
    ["a JSON number", "42"],
    ["JSON null", "null"],
    ["text that is not JSON", "not json"],
  ])("%s is refused with 400 and spends no limiter quota", async (label, raw) => {
    const res = await frameRenew(rawRequest(raw));
    expect(res.status, label).toBe(400);
    expect(await res.json(), label).toEqual({ error: "invalid_grant" });
    expect(allowConnectTokenRequest, `${label}: the limiter is not charged`).not.toHaveBeenCalled();
    expect(deriveFrameBinding, `${label}: the binding is not derived`).not.toHaveBeenCalled();
    expect(renewUserWidgetToken, `${label}: nothing is renewed`).not.toHaveBeenCalled();
    expect(mintWidgetStreamToken, `${label}: nothing is minted`).not.toHaveBeenCalled();
    expect(
      emitWidgetAuthAudit.mock.calls.some(
        ([event, fields]) =>
          event === "renew_failure" && (fields as { reason?: string }).reason === "invalid_body",
      ),
      `${label}: the refusal is audited as an invalid body`,
    ).toBe(true);
  });
});

// cinatra#4217 r4 — forensics. RED BEFORE r4: renew_success named no person, so
// an investigation could not follow one sign-in's renewals in the audit trail.
describe("the renewal's audit (cinatra#4217)", () => {
  it("renew_success names the person whose chain was renewed, and carries no token", async () => {
    const ok = await frameRenew(frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT }));
    expect(ok.status).toBe(200);
    const success = emitWidgetAuthAudit.mock.calls.filter(([event]) => event === "renew_success");
    expect(success).toHaveLength(1);
    const fields = success[0]![1] as Record<string, unknown>;
    expect(fields.actor, "the verified user id").toBe("user-1");
    expect(fields.siteId).toBe(SITE.siteId);
    // Never the presented or the renewed bearer, a transport token, a hash or a jti.
    const line = JSON.stringify(emitWidgetAuthAudit.mock.calls);
    expect(line).not.toMatch(/cwu_|cit_|cnx_/);
    expect(line).not.toContain(`h(${CURRENT})`);
    expect(Object.keys(fields)).not.toContain("jti");
  });
});

// cinatra#4217 — every refusal branch of the route, each with its own audit
// reason, and none of them hands out a bearer.
describe("the route's other refusals (cinatra#4217)", () => {
  async function expectRefused(res: Response, status: number, reason: string): Promise<unknown> {
    expect(res.status, reason).toBe(status);
    const text = await res.text();
    expect(text, `${reason}: no bearer in the answer`).not.toMatch(/cwu_|cit_|cnx_/);
    expect(
      emitWidgetAuthAudit.mock.calls.some(
        ([event, fields]) =>
          event === "renew_failure" && (fields as { reason?: string }).reason === reason,
      ),
      `${reason}: audited with its reason`,
    ).toBe(true);
    expect(
      emitWidgetAuthAudit.mock.calls.some(([event]) => event === "renew_success"),
      `${reason}: no success is audited`,
    ).toBe(false);
    return JSON.parse(text);
  }

  it.each([
    ["an Origin that is not this instance", { Origin: "https://wp.example.test" }],
    ["a Sec-Fetch-Site that is not same-origin", { "Sec-Fetch-Site": "cross-site" }],
  ])("%s is refused with 401 before anything is read or charged", async (_label, headers) => {
    const res = await frameRenew(
      frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT, ...headers }),
    );
    expect(await expectRefused(res, 401, "not_same_origin")).toEqual({ error: "Unauthorized" });
    expect(allowConnectTokenRequest).not.toHaveBeenCalled();
    expect(deriveFrameBinding).not.toHaveBeenCalled();
    expect(renewUserWidgetToken).not.toHaveBeenCalled();
    expect(mintWidgetStreamToken).not.toHaveBeenCalled();
  });

  it("a binding the server cannot derive is refused with 400, and nothing is renewed", async () => {
    deriveFrameBinding.mockReturnValue({ ok: false, reason: "site_unresolved" });
    const res = await frameRenew(frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT }));
    expect(await expectRefused(res, 400, "site_unresolved")).toEqual({ error: "invalid_grant" });
    expect(renewUserWidgetToken).not.toHaveBeenCalled();
    expect(mintWidgetStreamToken).not.toHaveBeenCalled();
  });

  it.each([
    ["an agent that does not resolve", "some-other-agent", "wordpress"],
    ["an agent whose connector key differs from the binding's", AGENT_SLUG, "drupal"],
  ])("%s is refused with 400, and nothing is renewed", async (_label, agentSlug, instancesConfigKey) => {
    deriveFrameBinding.mockReturnValue({
      ok: true,
      binding: { site: SITE, instanceId: "inst-1", agentSlug, instancesConfigKey },
    });
    const res = await frameRenew(frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT }));
    expect(await expectRefused(res, 400, "unknown_agent")).toEqual({ error: "invalid_grant" });
    expect(renewUserWidgetToken).not.toHaveBeenCalled();
    expect(mintWidgetStreamToken).not.toHaveBeenCalled();
  });

  it("a transport mint that fails after the renewal refuses the whole renewal and hands out neither token", async () => {
    mintWidgetStreamToken.mockReturnValue(null);
    const res = await frameRenew(frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT }));
    expect(await expectRefused(res, 400, "transport_mint_failed")).toEqual({ error: "invalid_grant" });
    expect(renewUserWidgetToken, "the user token was renewed first").toHaveBeenCalledTimes(1);
  });

  // cinatra#4217 fold 3 — the branches the official review named untested. Not
  // red before fold 3: the route already behaved so; these cases pin it.

  // A throw is not caught by the route: the request fails (the framework
  // answers 500, which the frame maps to renew_failed and its sign-in card).
  // What matters is what did NOT happen: nothing after the throw ran, and no
  // token reached a response or an audit line.
  it.each([
    ["the agent lookup", () => resolveWidgetStreamAgentUnion.mockRejectedValue(new Error("registry down"))],
    ["the user-token renewal", () => renewUserWidgetToken.mockImplementation(() => { throw new Error("db down"); })],
    ["the transport mint", () => mintWidgetStreamToken.mockImplementation(() => { throw new Error("db down"); })],
  ])("a throw in %s fails the request and hands out no token", async (label, breakIt) => {
    breakIt();
    await expect(
      frameRenew(frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT })),
    ).rejects.toThrow();
    if (label === "the agent lookup") expect(renewUserWidgetToken, "nothing renewed").not.toHaveBeenCalled();
    if (label !== "the transport mint") expect(mintWidgetStreamToken, "nothing minted").not.toHaveBeenCalled();
    const audits = JSON.stringify(emitWidgetAuthAudit.mock.calls);
    expect(audits).not.toContain("renew_success");
    expect(audits).not.toContain("cwu_");
    expect(audits).not.toContain("cit_");
  });

  it("C29: advertises the SHORTER life when the renewed user token ends before the transport token", async () => {
    renewUserWidgetToken.mockReturnValue({
      ok: true,
      token: "cwu_the_renewed_bearer",
      tokenType: "Bearer",
      expiresIn: 120, // the session cap is near
      sessionExpiresIn: 120,
      scope: "wordpress-content-editor.user lifecycle.read",
      userId: "user-1",
    });
    const res = await frameRenew(frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { expiresIn: number }).expiresIn).toBe(120);
  });
});

// cinatra#4217 — the per-address bucket is keyed on the hop the platform
// appended to X-Forwarded-For (the LAST one). RED BEFORE: the route keyed it on
// the FIRST hop, which the caller writes, so a forged hop could fill another
// address's bucket and a rotated one escaped the caller's own.
describe("a forged X-Forwarded-For hop (cinatra#4217)", () => {
  const CLIENT = "2001:db8::9";
  const VICTIM = "2001:db8::5";

  it("two requests with different forged first hops from one client charge one address", async () => {
    for (const forged of ["2001:db8::a1", "2001:db8::a2, 2001:db8::a3"]) {
      const res = await frameRenew(
        frameRequest(SELECTORS, {
          "X-Cinatra-Widget-User-Token": CURRENT,
          "X-Forwarded-For": `${forged}, ${CLIENT}`,
        }),
      );
      expect(res.status).toBe(200);
    }
    const ips = allowConnectTokenRequest.mock.calls.map((c) => (c[0] as { ip: string }).ip);
    expect(ips).toEqual([CLIENT, CLIENT]);
  });

  it("a forged hop naming another address never charges that address", async () => {
    allowConnectTokenRequest.mockReturnValue(false);
    const res = await frameRenew(
      frameRequest(SELECTORS, {
        "X-Cinatra-Widget-User-Token": CURRENT,
        "X-Forwarded-For": `${VICTIM}, ${CLIENT}`,
      }),
    );
    expect(res.status).toBe(429);
    const ips = allowConnectTokenRequest.mock.calls.map((c) => (c[0] as { ip: string }).ip);
    expect(ips).toEqual([CLIENT]);
    expect(JSON.stringify(emitWidgetAuthAudit.mock.calls)).not.toContain(VICTIM);
  });
});

// ---------------------------------------------------------------------------
// cinatra#4217 rebuild — the 409 refusal and the advertised lives. Each title
// names its census row of the rebuild spec.
// RED AT a246d839: every refusal of the claim answered 400, and the answer
// carried neither userExpiresIn nor sessionExpiresIn.
// ---------------------------------------------------------------------------
describe("the rebuild's refusal classes and lives (cinatra#4217)", () => {
  it("R1: a verified token with no more than G left answers 409 and stays valid for a chat turn", async () => {
    renewUserWidgetToken.mockReturnValue({ ok: false, reason: "not_renewable" });
    const res = await frameRenew(frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT }));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "not_renewable" });
    expect(text, "no bearer in the answer").not.toMatch(/cwu_|cit_|cnx_/);
    // The claim found nothing: nothing was spent and nothing minted, so the
    // presented token still verifies for a chat turn (widget-user-auth.test.ts
    // proves the token row is untouched).
    expect(renewUserWidgetToken).toHaveBeenCalledTimes(1);
    expect(mintWidgetStreamToken).not.toHaveBeenCalled();
    expect(
      emitWidgetAuthAudit.mock.calls.some(
        ([event, fields]) => event === "renew_failure" && (fields as { reason?: string }).reason === "not_renewable",
      ),
    ).toBe(true);
  });

  it("C14: every other refusal of a token is 400, never 409", async () => {
    for (const reason of ["expired", "not_found", "session_revoked", "site_revoked", "aud_mismatch", "origin_mismatch", "site_mismatch"]) {
      vi.clearAllMocks();
      renewUserWidgetToken.mockReturnValueOnce({ ok: false, reason });
      const res = await frameRenew(frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT }));
      expect(res.status, reason).toBe(400);
      expect(await res.json(), reason).toEqual({ error: "invalid_grant" });
      expect(mintWidgetStreamToken, reason).not.toHaveBeenCalled();
    }
  });

  it("C25b: userExpiresIn equals the renewed user life, and expiresIn is min(user, transport)", async () => {
    for (const [user, transport, pair] of [
      [900, 300, 300],
      [250, 300, 250],
      [299, 299, 299],
    ] as const) {
      vi.clearAllMocks();
      renewUserWidgetToken.mockReturnValueOnce({
        ok: true,
        token: "cwu_the_renewed_bearer",
        tokenType: "Bearer",
        expiresIn: user,
        sessionExpiresIn: 4_000,
        scope: "wordpress-content-editor.user lifecycle.read",
        userId: "user-1",
      });
      mintWidgetStreamToken.mockReturnValueOnce({
        token: "cit_the_site_transport",
        tokenType: "Bearer",
        expiresIn: transport,
        expiresAt: "2026-08-12T00:00:00.000Z",
        scope: "wordpress-content-editor.stream",
      });
      const res = await frameRenew(frameRequest(SELECTORS, { "X-Cinatra-Widget-User-Token": CURRENT }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.expiresIn, `user ${user}, transport ${transport}`).toBe(pair);
      expect(body.userExpiresIn).toBe(user);
      expect(body.sessionExpiresIn).toBe(4_000);
    }
  });
});
