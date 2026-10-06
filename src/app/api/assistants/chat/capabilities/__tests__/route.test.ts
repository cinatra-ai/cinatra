import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// GET/POST /api/assistants/chat/capabilities — Lane A broker-auth advertisement
// (cinatra#1998, epic #1216 S6). Drives the route's decision logic with the
// dependency boundaries mocked (the SAME boundaries the turn endpoint's
// route.widget-broker.test.ts mocks), asserting:
//   - the advertised auth modes now include BOTH "session" and "token-broker"
//     (so `negotiateEmbedChatContract` can reach ok:true), and renderableViews is
//     SURFACE-SCOPED — §IX's chat_thread row for a session, §IX's site_widget row
//     for the broker branch (no oracle beyond the static contract metadata; the
//     shape is fixed per surface CLASS, never per caller).
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
  it("advertises BOTH session and token-broker; the SESSION branch advertises the lifecycle views", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    const res = await GET(new Request("https://app.test/api/assistants/chat/capabilities"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth).toEqual(["session", "token-broker"]);
    // cinatra#2565 — surface-scoped: a first-party host may render the
    // lifecycle cards §IX places on the chat thread.
    expect([...body.renderableViews].sort()).toEqual([
      "artifact_review_gate",
      "trigger_schedule_proposal",
      "verification_summary",
    ]);
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

  it("cinatra#2577 (corrected): the WIDGET branch advertises the SAME set as first-party chat", async () => {
    primeHappyBroker();
    const res = await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect([...body.renderableViews].sort()).toEqual([
      "artifact_review_gate",
      "trigger_schedule_proposal",
      "verification_summary",
    ]);
  });

  it("cinatra#2577 (corrected): the two auth branches advertise the SAME lifecycle views", async () => {
    // The correction, as an equality. This assertion previously said the two
    // branches must DIFFER, which is exactly the reduced-widget premise the
    // owner rejected: a widget session is the person's own cinatra
    // authentication, so it is offered the same set.
    getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    const sessionBody = await (
      await GET(new Request("https://app.test/api/assistants/chat/capabilities"))
    ).json();
    vi.clearAllMocks();
    primeHappyBroker();
    const widgetBody = await (
      await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" }))
    ).json();
    expect([...widgetBody.renderableViews].sort()).toEqual(
      [...sessionBody.renderableViews].sort(),
    );
  });

  it("the recommendation hold is advertised to NEITHER branch — carriage, not restriction", async () => {
    // It rides an INTERRUPT, so it has no advertised viewType anywhere. Pinned
    // so this absence is never read as a surviving per-surface reduction.
    getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    const sessionBody = await (
      await GET(new Request("https://app.test/api/assistants/chat/capabilities"))
    ).json();
    vi.clearAllMocks();
    primeHappyBroker();
    const widgetBody = await (
      await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" }))
    ).json();
    expect(sessionBody.renderableViews).not.toContain("recommendation_hold");
    expect(widgetBody.renderableViews).not.toContain("recommendation_hold");
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
    // cinatra#3715 re-key: a refused caller is NEVER recorded as advertised, and
    // the refusal now writes its own line with the origin-disagreement reason.
    expect(emitWidgetAuthAudit).not.toHaveBeenCalledWith(
      "assistant_chat_capabilities_broker_advertised",
      expect.anything(),
    );
    expect(emitWidgetAuthAudit).toHaveBeenCalledTimes(1);
    expect(emitWidgetAuthAudit).toHaveBeenCalledWith(
      "assistant_chat_capabilities_broker_rejected",
      expect.objectContaining({ reason: "origin_disagreement" }),
    );
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

// cinatra#3715 — every refusal on the broker branch writes ONE widget-auth-audit
// line naming the refusal point (and, for the two consumes, the consume's own
// reason code). The caller's answer stays the one generic 401, and the line
// carries no token, hash or header value.
describe("GET — every broker refusal writes one audit line (cinatra#3715)", () => {
  const REFUSED = "assistant_chat_capabilities_broker_rejected";
  const HEADER_VALUES = ["cit_a", "cwu_b", "blog.example.com"];

  async function expectOneRefusal(res: Response, reason: string) {
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(emitWidgetAuthAudit).toHaveBeenCalledTimes(1);
    const [event, fields] = emitWidgetAuthAudit.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe(REFUSED);
    expect(fields.reason).toBe(reason);
    // Only the refusal point and the server-resolved agent — never a token, a
    // hash or a header value.
    for (const key of Object.keys(fields)) expect(["agentSlug", "reason"]).toContain(key);
    const line = JSON.stringify(fields);
    for (const value of HEADER_VALUES) expect(line).not.toContain(value);
  }

  it("the missing cwu_ user token", async () => {
    primeHappyBroker();
    await expectOneRefusal(
      await GET(brokerGet({ cit: "cit_a", origin: ORIGIN, assistant: "wordpress" })),
      "user_token_missing",
    );
  });

  it("an unknown/forged assistant handle", async () => {
    primeHappyBroker();
    resolveAssistantWidgetBinding.mockReturnValue(null);
    await expectOneRefusal(
      await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "cinatra" })),
      "widget_binding_unresolved",
    );
  });

  it("the widget-stream union not resolving", async () => {
    primeHappyBroker();
    resolveWidgetStreamAgentUnion.mockResolvedValue(null);
    await expectOneRefusal(
      await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" })),
      "agent_unresolved",
    );
  });

  it("the cit_ consume refusing, with the consume's own reason code", async () => {
    primeHappyBroker();
    consumeWidgetStreamToken.mockReturnValue({ ok: false, reason: "origin_unconfigured" });
    await expectOneRefusal(
      await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" })),
      "transport_token_rejected:origin_unconfigured",
    );
  });

  it("the cwu_ consume refusing, with the consume's own reason code", async () => {
    primeHappyBroker();
    consumeUserWidgetToken.mockReturnValue({ ok: false, reason: "site_revoked" });
    await expectOneRefusal(
      await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" })),
      "user_token_rejected:site_revoked",
    );
  });

  it("the two tokens' origins disagreeing", async () => {
    primeHappyBroker();
    consumeUserWidgetToken.mockReturnValue({
      ok: true,
      claims: { userId: "u1", orgId: "o1", siteOrigin: "https://evil.example.com", agentSlug: "wordpress-content-editor" },
    });
    await expectOneRefusal(
      await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" })),
      "origin_disagreement",
    );
  });

  it("the success still writes ONLY the advertised event", async () => {
    primeHappyBroker();
    const res = await GET(brokerGet({ cit: "cit_a", cwu: "cwu_b", origin: ORIGIN, assistant: "wordpress" }));
    expect(res.status).toBe(200);
    expect(emitWidgetAuthAudit).toHaveBeenCalledTimes(1);
    expect(emitWidgetAuthAudit.mock.calls[0][0]).toBe("assistant_chat_capabilities_broker_advertised");
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
