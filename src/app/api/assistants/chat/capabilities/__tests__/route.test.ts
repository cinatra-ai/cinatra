import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// GET/POST /api/assistants/chat/capabilities — Lane A broker-auth advertisement
// (cinatra#1998, epic #1216 S6). Drives the route's decision logic with the
// dependency boundaries mocked (the SAME boundaries the turn endpoint's
// route.widget-broker.test.ts mocks), asserting:
//   - the advertised auth modes now include BOTH "session" and "token-broker"
//     (so `negotiateEmbedChatContract` can reach ok:true), renderableViews stays
//     empty (no oracle beyond the static contract metadata).
//   - session GET/POST are byte-unchanged (401 without a session; served with).
//   - a valid cit_/cwu_ broker caller is SERVED the advertisement sessionlessly.
//   - every fail-closed rung (cwu_ missing / unknown handle / cit_ reject / cwu_
//     reject / origin disagreement / unknown agent union) 401s.
//   - a FAILED broker validation does NOT fall back to an ambient session
//     cookie (credentials:"omit" posture — no session rescue).
//
// The token-verify fail-closed matrices themselves are proven by the
// widget-token-broker / widget-user-auth suites; here we prove the ROUTE half.
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const resolveWidgetStreamAgentUnion = vi.fn();
const widgetStreamRequestSource = vi.fn();
const consumeWidgetStreamToken = vi.fn();
const normalizeOriginStrict = vi.fn();
const consumeUserWidgetToken = vi.fn();
const emitWidgetAuthAudit = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
}));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));
vi.mock("@/lib/widget-stream-agents.server", () => ({
  resolveWidgetStreamAgentUnion: (...a: unknown[]) => resolveWidgetStreamAgentUnion(...a),
  widgetStreamRequestSource: (...a: unknown[]) => widgetStreamRequestSource(...a),
}));
vi.mock("@/lib/widget-token-broker", () => ({
  consumeWidgetStreamToken: (...a: unknown[]) => consumeWidgetStreamToken(...a),
  normalizeOriginStrict: (...a: unknown[]) => normalizeOriginStrict(...a),
}));
vi.mock("@/lib/widget-user-auth", () => ({
  consumeUserWidgetToken: (...a: unknown[]) => consumeUserWidgetToken(...a),
}));
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: (...a: unknown[]) => emitWidgetAuthAudit(...a),
}));

import { GET, POST } from "../route";

const ORIGIN = "https://blog.example.com";
const WP_BINDING = { handle: "wordpress", agentSlug: "wordpress-content-editor", instancesConfigKey: "wordpress" };
const WP_ENTRY = { entry: { auth: { tokenConfigKey: "wordpress_widget_auth", instancesConfigKey: "wordpress" } } };

function brokerGet(opts: {
  cit?: string | null;
  cwu?: string | null;
  origin?: string | null;
  assistant?: string | null;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.cit) headers["Authorization"] = `Bearer ${opts.cit}`;
  if (opts.cwu) headers["X-Cinatra-Widget-User-Token"] = opts.cwu;
  if (opts.origin) headers["X-Cinatra-Widget-Origin"] = opts.origin;
  if (opts.assistant) headers["X-Cinatra-Widget-Assistant"] = opts.assistant;
  return new Request("https://app.test/api/assistants/chat/capabilities", { method: "GET", headers });
}

// A fully-valid broker caller (all rungs pass) unless a test overrides a mock.
function primeHappyBroker() {
  resolveAssistantWidgetBinding.mockReturnValue(WP_BINDING);
  widgetStreamRequestSource.mockReturnValue("src-key");
  resolveWidgetStreamAgentUnion.mockResolvedValue(WP_ENTRY);
  consumeWidgetStreamToken.mockReturnValue({ ok: true, origin: ORIGIN, sub: "u1", jti: "j1" });
  consumeUserWidgetToken.mockReturnValue({
    ok: true,
    claims: { userId: "u1", orgId: "o1", siteOrigin: ORIGIN, agentSlug: "wordpress-content-editor" },
  });
  normalizeOriginStrict.mockImplementation((v: unknown) => String(v ?? "").trim());
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue(null);
  normalizeOriginStrict.mockImplementation((v: unknown) => String(v ?? "").trim());
});

describe("GET — advertised capabilities shape", () => {
  it("advertises BOTH session and token-broker, renderableViews empty (session caller)", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    const res = await GET(new Request("https://app.test/api/assistants/chat/capabilities"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth).toEqual(["session", "token-broker"]);
    expect(body.renderableViews).toEqual([]);
    expect(body.transport).toBe("sse");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("401s a sessionless non-broker caller (no bearer)", async () => {
    const res = await GET(new Request("https://app.test/api/assistants/chat/capabilities"));
    expect(res.status).toBe(401);
  });
});

describe("GET — broker-auth advertisement (Lane A)", () => {
  it("serves the advertisement to a valid sessionless cit_/cwu_ caller", async () => {
    primeHappyBroker();
    const res = await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth).toContain("token-broker");
    // The cit_ consume verifies against the TURN aud (not the capabilities path).
    expect(consumeWidgetStreamToken).toHaveBeenCalledWith(
      expect.objectContaining({ token: "cit_a", agentSlug: "wordpress-content-editor", requestOrigin: ORIGIN }),
    );
    expect(emitWidgetAuthAudit).toHaveBeenCalledWith(
      "assistant_chat_capabilities_broker_advertised",
      expect.objectContaining({ agentSlug: "wordpress-content-editor" }),
    );
  });

  it("401s when the cwu_ user token is missing (no anonymous broker read)", async () => {
    primeHappyBroker();
    const res = await GET(brokerGet({ cit: "cit_a", origin: ORIGIN, assistant: "wordpress" }));
    expect(res.status).toBe(401);
    expect(consumeWidgetStreamToken).not.toHaveBeenCalled();
  });

  it("401s an unknown/forged assistant handle", async () => {
    primeHappyBroker();
    resolveAssistantWidgetBinding.mockReturnValue(null);
    const res = await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "cinatra" }));
    expect(res.status).toBe(401);
  });

  it("401s when the widget-stream union does not resolve", async () => {
    primeHappyBroker();
    resolveWidgetStreamAgentUnion.mockResolvedValue(null);
    const res = await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" }));
    expect(res.status).toBe(401);
  });

  it("401s when the cit_ token is rejected", async () => {
    primeHappyBroker();
    consumeWidgetStreamToken.mockReturnValue({ ok: false, reason: "origin_mismatch" });
    const res = await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" }));
    expect(res.status).toBe(401);
    expect(consumeUserWidgetToken).not.toHaveBeenCalled();
  });

  it("401s when the cwu_ token is rejected", async () => {
    primeHappyBroker();
    consumeUserWidgetToken.mockReturnValue({ ok: false, reason: "site_revoked" });
    const res = await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" }));
    expect(res.status).toBe(401);
  });

  it("401s on two-token origin disagreement (cit_ origin != cwu_ site origin)", async () => {
    primeHappyBroker();
    consumeUserWidgetToken.mockReturnValue({
      ok: true,
      claims: { userId: "u1", orgId: "o1", siteOrigin: "https://evil.example.com", agentSlug: "wordpress-content-editor" },
    });
    const res = await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" }));
    expect(res.status).toBe(401);
    expect(emitWidgetAuthAudit).not.toHaveBeenCalled();
  });

  it("does NOT fall back to an ambient session when broker validation fails (credentials:omit posture)", async () => {
    primeHappyBroker();
    getAuthSession.mockResolvedValue({ user: { id: "u1" } }); // a cookie IS present
    consumeWidgetStreamToken.mockReturnValue({ ok: false, reason: "expired" });
    const res = await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" }));
    expect(res.status).toBe(401); // the cookie must NOT rescue the failed broker read
    expect(getAuthSession).not.toHaveBeenCalled(); // the broker branch never even reads the session
  });
});

describe("POST — first-party /chat handshake stays session-gated", () => {
  it("401s a sessionless POST", async () => {
    const res = await POST(
      new Request("https://app.test/api/assistants/chat/capabilities", {
        method: "POST",
        body: JSON.stringify({ supportedContracts: ["1.0.0"], authMode: "session" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("negotiates ok for a session client (both auth modes now advertised)", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    const res = await POST(
      new Request("https://app.test/api/assistants/chat/capabilities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ supportedContracts: ["1.0.0"], authMode: "session" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.authMode).toBe("session");
  });
});
