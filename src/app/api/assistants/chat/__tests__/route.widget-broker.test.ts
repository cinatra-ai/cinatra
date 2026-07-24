import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// S5 (cinatra#1221) — POST /api/assistants/chat BROKER-AUTH WIDGET branch.
//
// Ports the /api/agents/{slug}/stream dual-token FAIL-CLOSED sequence onto the
// unified assistant runtime. These tests drive the ROUTE's decision logic with
// the dependency boundaries mocked, asserting:
//   - T-cookie: no Authorization bearer → the cookie-session path is UNTOUCHED
//     (runChatTurn; NO widget consume/dispatch/principal is ever built).
//   - the happy broker path builds the correct SERVER-VERIFIED WidgetPrincipal
//     and drives runAssistantTurn WITH it (T5: platformRole floored to member).
//   - every fail-closed rung (cit_ reject / cwu_ missing / origin disagreement /
//     instance-binding / non-member / G9 agent-mismatch / grant re-assert)
//     denies with NO turn started.
//   - OPTIONS reflects CORS for a configured widget origin.
//
// The token-verify fail-closed matrix (T1), the 120 s TTL + jti (T6), the mint
// member-floor (T5 at the token), and the no-downgrade throw (T7) are proven by
// the W1 widget-mcp-actor-token + W2 host-content-editor-dispatch suites; here we
// prove the ROUTE half + that it threads the principal into the seam.
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const requireActorContext = vi.fn();
const isPlatformAdmin = vi.fn();
const resolveOrgRoleForUser = vi.fn();
const hasConfiguredLlmRuntime = vi.fn();
const runChatTurn = vi.fn();
const resolveAssistantHandles = vi.fn();
const resolveAssistantRuntimeConfigByPrincipal = vi.fn();
const runAssistantTurn = vi.fn();
const authorizeThreadForTurn = vi.fn();
const streamAgUiChatTurn = vi.fn();
const resolveWidgetStreamAgentUnion = vi.fn();
const widgetStreamRequestSource = vi.fn();
const reassertWidgetStreamGrantBeforeOboRun = vi.fn();
const resolveWidgetStreamOrigin = vi.fn();
const buildWidgetStreamCorsHeaders = vi.fn();
const consumeWidgetStreamToken = vi.fn();
const normalizeOriginStrict = vi.fn();
const consumeUserWidgetToken = vi.fn();
const resolveCanonicalInstanceForOrigin = vi.fn();
const emitWidgetAuthAudit = vi.fn();
const isSelectedAssistantVisible = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  requireActorContext: () => requireActorContext(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleForUser(...a),
}));
vi.mock("@/app/api/chat/runner", () => ({
  hasConfiguredLlmRuntime: () => hasConfiguredLlmRuntime(),
  runChatTurn: (...a: unknown[]) => runChatTurn(...a),
}));
vi.mock("@/lib/better-auth-db", () => ({
  resolveAssistantHandles: (...a: unknown[]) => resolveAssistantHandles(...a),
}));
vi.mock("@/lib/assistant-runtime/resolve-runtime-config", () => ({
  resolveAssistantRuntimeConfigByPrincipal: (...a: unknown[]) =>
    resolveAssistantRuntimeConfigByPrincipal(...a),
}));
vi.mock("@/lib/assistant-runtime/runtime", () => ({
  runAssistantTurn: (...a: unknown[]) => runAssistantTurn(...a),
}));
vi.mock("@/lib/assistant-runtime/ag-ui-stream-route", () => ({
  authorizeThreadForTurn: (...a: unknown[]) => authorizeThreadForTurn(...a),
  streamAgUiChatTurn: (...a: unknown[]) => streamAgUiChatTurn(...a),
}));
vi.mock("@/lib/widget-stream-agents.server", () => ({
  resolveWidgetStreamAgentUnion: (...a: unknown[]) => resolveWidgetStreamAgentUnion(...a),
  widgetStreamRequestSource: (...a: unknown[]) => widgetStreamRequestSource(...a),
  reassertWidgetStreamGrantBeforeOboRun: (...a: unknown[]) =>
    reassertWidgetStreamGrantBeforeOboRun(...a),
}));
vi.mock("@/lib/widget-stream-auth", () => ({
  resolveWidgetStreamOrigin: (...a: unknown[]) => resolveWidgetStreamOrigin(...a),
  buildWidgetStreamCorsHeaders: (...a: unknown[]) => buildWidgetStreamCorsHeaders(...a),
}));
vi.mock("@/lib/widget-token-broker", () => ({
  consumeWidgetStreamToken: (...a: unknown[]) => consumeWidgetStreamToken(...a),
  normalizeOriginStrict: (...a: unknown[]) => normalizeOriginStrict(...a),
}));
vi.mock("@/lib/widget-user-auth", () => ({
  consumeUserWidgetToken: (...a: unknown[]) => consumeUserWidgetToken(...a),
  resolveCanonicalInstanceForOrigin: (...a: unknown[]) => resolveCanonicalInstanceForOrigin(...a),
}));
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: (...a: unknown[]) => emitWidgetAuthAudit(...a),
}));
vi.mock("@/lib/assistant-selector-audience", () => ({
  isSelectedAssistantVisible: (...a: unknown[]) => isSelectedAssistantVisible(...a),
  // Pure caller-builders: passthrough shapes the mocked gate ignores.
  widgetSelectorCaller: (p: { userId: string; orgId: string }) => ({
    userId: p.userId,
    orgId: p.orgId,
    platformRole: "member",
  }),
  sessionSelectorCaller: (userId: string, orgId: string | null) => ({
    userId,
    orgId: orgId ?? "",
    platformRole: "member",
  }),
}));

import { POST, OPTIONS } from "../route";
import { verifyWidgetChatResumeToken } from "@/lib/widget-chat-resume-token";

const ORIGIN = "https://blog.example.com";
const WP_ENTRY = {
  entry: { auth: { tokenConfigKey: "wordpress_widget_auth", instancesConfigKey: "wordpress" } },
};

function widgetReq(opts: {
  origin?: string | null;
  widgetOrigin?: string | null;
  cit?: string | null;
  cwu?: string | null;
  body?: unknown;
}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== null) headers["Origin"] = opts.origin ?? ORIGIN;
  // Post-S5 the embed forwards the CMS site origin here (the browser Origin is the
  // same-origin Cinatra app). Default it to the same value the tokens bind to.
  if (opts.widgetOrigin !== null) headers["X-Cinatra-Widget-Origin"] = opts.widgetOrigin ?? ORIGIN;
  if (opts.cit) headers["Authorization"] = `Bearer ${opts.cit}`;
  if (opts.cwu) headers["X-Cinatra-Widget-User-Token"] = opts.cwu;
  return new Request("https://app.test/api/assistants/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(
      opts.body ?? { threadId: "th-1", messages: [{ role: "user", content: "edit the intro" }], assistant: "wordpress" },
    ),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hasConfiguredLlmRuntime.mockResolvedValue(true);
  widgetStreamRequestSource.mockReturnValue("src-key");
  resolveWidgetStreamAgentUnion.mockResolvedValue(WP_ENTRY);
  resolveWidgetStreamOrigin.mockReturnValue(ORIGIN);
  buildWidgetStreamCorsHeaders.mockReturnValue({ "Access-Control-Allow-Origin": ORIGIN });
  consumeWidgetStreamToken.mockReturnValue({ ok: true, sub: null, jti: "j1", origin: ORIGIN });
  consumeUserWidgetToken.mockReturnValue({
    ok: true,
    claims: {
      userId: "user-7",
      orgId: "org-3",
      siteId: "site-1",
      client: "wordpress",
      siteOrigin: ORIGIN,
      agentSlug: "wordpress-content-editor",
      instanceId: "inst-42",
      jti: "u1",
    },
  });
  normalizeOriginStrict.mockImplementation((o: string | null) => (o ?? "").toLowerCase());
  resolveCanonicalInstanceForOrigin.mockReturnValue("inst-42");
  resolveOrgRoleForUser.mockResolvedValue("member");
  reassertWidgetStreamGrantBeforeOboRun.mockResolvedValue(true);
  authorizeThreadForTurn.mockReturnValue({ ok: true, mirrorOrgId: null, needsStructuredRow: true });
  resolveAssistantHandles.mockResolvedValue(new Map([["wordpress", "wp-principal"]]));
  resolveAssistantRuntimeConfigByPrincipal.mockResolvedValue({
    ok: true,
    runtimeConfig: { systemSkillId: "@cinatra-ai/chat:wordpress-authoring-core" },
  });
  streamAgUiChatTurn.mockResolvedValue(new Response("ok", { status: 200 }));
  // AC#3: the verified end user is IN the assistant's audience by default.
  isSelectedAssistantVisible.mockResolvedValue(true);
  // Cookie-path defaults (for the T-cookie test).
  getAuthSession.mockResolvedValue({ user: { id: "cookie-user" }, session: { activeOrganizationId: "org-1" } });
  requireActorContext.mockResolvedValue({ principalType: "HumanUser", principalId: "cookie-user" });
  isPlatformAdmin.mockReturnValue(false);
});

describe("T-cookie — no Authorization bearer keeps the cookie-session path byte-identical", () => {
  it("routes a session request to runChatTurn and NEVER touches a widget dependency", async () => {
    const req = new Request("https://app.test/api/assistants/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "th-1", messages: [{ role: "user", content: "hi" }] }),
    });
    await POST(req);
    expect(getAuthSession).toHaveBeenCalledTimes(1);
    expect(streamAgUiChatTurn).toHaveBeenCalledTimes(1);
    // No widget-branch dependency is consulted on the cookie path.
    expect(consumeWidgetStreamToken).not.toHaveBeenCalled();
    expect(consumeUserWidgetToken).not.toHaveBeenCalled();
    expect(resolveWidgetStreamAgentUnion).not.toHaveBeenCalled();
    expect(runAssistantTurn).not.toHaveBeenCalled();
  });

  it("a non-cit_ bearer is NOT treated as a widget request (falls to the cookie path)", async () => {
    const req = new Request("https://app.test/api/assistants/chat", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer sometoken" },
      body: JSON.stringify({ threadId: "th-1", messages: [{ role: "user", content: "hi" }] }),
    });
    await POST(req);
    expect(consumeWidgetStreamToken).not.toHaveBeenCalled();
    expect(getAuthSession).toHaveBeenCalledTimes(1);
  });
});

describe("broker-auth happy path — builds the WidgetPrincipal and drives the seam", () => {
  it("threads a SERVER-VERIFIED principal into runAssistantTurn (platformRole floored to member — T5)", async () => {
    const res = await POST(widgetReq({ cit: "cit_abc", cwu: "cwu_xyz" }));
    expect(res.status).toBe(200);
    // The cit_ token is consumed at the UNIFIED chat aud, not the stream path.
    expect(consumeWidgetStreamToken).toHaveBeenCalledWith(
      expect.objectContaining({ agentSlug: "wordpress-content-editor", routePath: "/api/assistants/chat" }),
    );
    expect(consumeUserWidgetToken).toHaveBeenCalledWith(
      expect.objectContaining({ agentSlug: "wordpress-content-editor", routePath: "/api/assistants/chat" }),
    );
    // Thread authz UNCHANGED, driven by the widget user (non-admin, own org).
    expect(authorizeThreadForTurn).toHaveBeenCalledWith({
      threadId: "th-1",
      callerId: "user-7",
      isAdmin: false,
      sessionOrgId: "org-3",
    });
    // The producer is captured; invoke it to inspect the runAssistantTurn args.
    const producer = streamAgUiChatTurn.mock.calls[0][0].runProducer;
    const send = vi.fn();
    await producer(send, undefined);
    expect(runAssistantTurn).toHaveBeenCalledTimes(1);
    const [cfg, args] = runAssistantTurn.mock.calls[0];
    expect(cfg).toEqual({ systemSkillId: "@cinatra-ai/chat:wordpress-authoring-core" });
    expect(args.platformRole).toBe("member");
    expect(args.userId).toBe("user-7");
    expect(args.sessionOrgId).toBe("org-3");
    expect(args.actorContext.platformRole).toBe("member");
    expect(args.widgetPrincipal).toEqual({
      kind: "public_site_widget",
      userId: "user-7",
      orgId: "org-3",
      instanceId: "inst-42", // the server-derived canonical RE-PIN
      verifiedOrigin: ORIGIN,
      assistantHandle: "wordpress",
      instancesConfigKey: "wordpress",
    });
    // CORS reflected onto the streamed response for the cross-origin widget.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it("consumes BOTH tokens against the FORWARDED CMS origin, not the same-origin embed browser Origin (S5 iframe turn)", async () => {
    // The embed iframe is SAME-ORIGIN to the Cinatra app, so the browser `Origin`
    // is the Cinatra app origin — never the CMS site origin the cit_/cwu_ tokens
    // were minted against. That origin arrives on X-Cinatra-Widget-Origin, and
    // BOTH consumes must validate the token binding against it (mirrors the
    // capabilities route). Regression guard for the origin_mismatch the S5 iframe
    // cutover otherwise 401s on.
    const res = await POST(
      widgetReq({ origin: "https://app.test", widgetOrigin: ORIGIN, cit: "cit_abc", cwu: "cwu_xyz" }),
    );
    expect(res.status).toBe(200);
    expect(consumeWidgetStreamToken).toHaveBeenCalledWith(
      expect.objectContaining({ requestOrigin: ORIGIN }),
    );
    expect(consumeUserWidgetToken).toHaveBeenCalledWith(
      expect.objectContaining({ requestOrigin: ORIGIN }),
    );
  });

  it("supplies a mintResumeToken callback that mints a RUN-BOUND resume token from the server-verified principal (S5 #1221)", async () => {
    const priorSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "test-secret-broker-mint";
    try {
      await POST(widgetReq({ cit: "cit_abc", cwu: "cwu_xyz" }));
      const mint = streamAgUiChatTurn.mock.calls[0][0].mintResumeToken as
        | ((runId: string) => string | null)
        | undefined;
      expect(typeof mint).toBe("function");
      // The harness will call it with the freshly-minted runId; the token is
      // run-bound and verifies at the resume seam ONLY for that run.
      const token = mint!("run-from-harness");
      expect(token).toBeTruthy();
      const good = verifyWidgetChatResumeToken({
        authHeader: `Bearer ${token}`,
        expectedRunId: "run-from-harness",
      });
      expect(good).toMatchObject({
        userId: "user-7",
        orgId: "org-3",
        instanceId: "inst-42", // the server-derived canonical RE-PIN
        kind: "wordpress",
        runId: "run-from-harness",
        platformRole: "member",
      });
      // Cross-run: the SAME token does not verify for a different run.
      expect(
        verifyWidgetChatResumeToken({
          authHeader: `Bearer ${token}`,
          expectedRunId: "a-different-run",
        }),
      ).toBeNull();
    } finally {
      if (priorSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = priorSecret;
    }
  });
});

describe("broker-auth fail-closed rungs — deny with NO turn started", () => {
  async function expectDenied(res: Response, status: number) {
    expect(res.status).toBe(status);
    expect(streamAgUiChatTurn).not.toHaveBeenCalled();
    expect(runAssistantTurn).not.toHaveBeenCalled();
  }

  it("403s a cit_ token presented for a NON-widget assistant handle", async () => {
    const res = await POST(
      widgetReq({ cit: "cit_abc", cwu: "cwu_xyz", body: { threadId: "t", messages: [{ role: "user", content: "x" }], assistant: "cinatra" } }),
    );
    await expectDenied(res, 403);
    expect(consumeWidgetStreamToken).not.toHaveBeenCalled();
  });

  it("401s a rejected cit_ token", async () => {
    consumeWidgetStreamToken.mockReturnValue({ ok: false, reason: "aud_mismatch" });
    await expectDenied(await POST(widgetReq({ cit: "cit_abc", cwu: "cwu_xyz" })), 401);
    expect(consumeUserWidgetToken).not.toHaveBeenCalled();
  });

  it("G9: a wordpress cit_ presented under assistant:'drupal' fails agent_mismatch at consume (401)", async () => {
    consumeWidgetStreamToken.mockReturnValue({ ok: false, reason: "agent_mismatch" });
    const res = await POST(
      widgetReq({ cit: "cit_abc", cwu: "cwu_xyz", body: { threadId: "t", messages: [{ role: "user", content: "x" }], assistant: "drupal" } }),
    );
    await expectDenied(res, 401);
    // The drupal binding was resolved (consume attempted against drupal-content-editor).
    expect(consumeWidgetStreamToken).toHaveBeenCalledWith(
      expect.objectContaining({ agentSlug: "drupal-content-editor" }),
    );
  });

  it("401s a missing cwu_ token with the re-login header", async () => {
    const res = await POST(widgetReq({ cit: "cit_abc", cwu: null }));
    await expectDenied(res, 401);
    expect(res.headers.get("X-Cinatra-Widget-Auth")).toBe("required");
    expect(consumeUserWidgetToken).not.toHaveBeenCalled();
  });

  it("401s on origin disagreement between the two tokens", async () => {
    consumeUserWidgetToken.mockReturnValue({
      ok: true,
      claims: { userId: "u", orgId: "o", siteId: "s", client: "wordpress", siteOrigin: "https://other.example.com", agentSlug: "wordpress-content-editor", instanceId: "inst-42", jti: "u1" },
    });
    await expectDenied(await POST(widgetReq({ cit: "cit_abc", cwu: "cwu_xyz" })), 401);
  });

  it("401s when the canonical origin re-pin fails (instance_binding_failed)", async () => {
    resolveCanonicalInstanceForOrigin.mockReturnValue(null);
    await expectDenied(await POST(widgetReq({ cit: "cit_abc", cwu: "cwu_xyz" })), 401);
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
  });

  it("401s when the re-pinned instance disagrees with the claim", async () => {
    resolveCanonicalInstanceForOrigin.mockReturnValue("inst-DIFFERENT");
    await expectDenied(await POST(widgetReq({ cit: "cit_abc", cwu: "cwu_xyz" })), 401);
  });

  it("401s a non-member (live membership re-check fails)", async () => {
    resolveOrgRoleForUser.mockResolvedValue(null);
    await expectDenied(await POST(widgetReq({ cit: "cit_abc", cwu: "cwu_xyz" })), 401);
    expect(reassertWidgetStreamGrantBeforeOboRun).not.toHaveBeenCalled();
  });

  it("404s (opaque) when the point-of-use grant re-assert fails before the run", async () => {
    reassertWidgetStreamGrantBeforeOboRun.mockResolvedValue(false);
    await expectDenied(await POST(widgetReq({ cit: "cit_abc", cwu: "cwu_xyz" })), 404);
  });

  it("404s an unresolvable widget-stream union", async () => {
    resolveWidgetStreamAgentUnion.mockResolvedValue(null);
    await expectDenied(await POST(widgetReq({ cit: "cit_abc", cwu: "cwu_xyz" })), 404);
  });
});

// AC#3 — site auth is NOT the installation's audience. A verified end user who is
// OUT of the assistant's audience is 404-hidden after the full dual-token sequence
// passes; an in-audience user runs the unchanged protocol.
describe("AC#3 audience closure — the verified end user must be in-audience", () => {
  it("404-hides an out-of-audience end user (valid site auth, NO turn started)", async () => {
    isSelectedAssistantVisible.mockResolvedValue(false);
    const res = await POST(widgetReq({ cit: "cit_abc", cwu: "cwu_xyz" }));
    expect(res.status).toBe(404);
    // The audience gate was consulted with the VERIFIED end user (floored member).
    expect(isSelectedAssistantVisible).toHaveBeenCalledWith(
      "wp-principal",
      expect.objectContaining({ userId: "user-7", orgId: "org-3", platformRole: "member" }),
    );
    // Opaque 404 — no run, no config resolution.
    expect(streamAgUiChatTurn).not.toHaveBeenCalled();
    expect(runAssistantTurn).not.toHaveBeenCalled();
    expect(resolveAssistantRuntimeConfigByPrincipal).not.toHaveBeenCalled();
    // A scrubbed audit line is emitted server-side.
    expect(emitWidgetAuthAudit).toHaveBeenCalledWith(
      "assistant_chat_widget_out_of_audience",
      expect.objectContaining({ actor: "user-7", orgId: "org-3" }),
    );
    // CORS still reflected on the deny.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("an in-audience end user runs the unchanged protocol (200, turn started)", async () => {
    isSelectedAssistantVisible.mockResolvedValue(true);
    const res = await POST(widgetReq({ cit: "cit_abc", cwu: "cwu_xyz" }));
    expect(res.status).toBe(200);
    expect(streamAgUiChatTurn).toHaveBeenCalledTimes(1);
    expect(isSelectedAssistantVisible).toHaveBeenCalledTimes(1);
  });
});

describe("OPTIONS — CORS preflight for the widget branch", () => {
  it("reflects the configured origin", async () => {
    const res = await OPTIONS(new Request("https://app.test/api/assistants/chat", { method: "OPTIONS", headers: { Origin: ORIGIN } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("403s a preflight with no Origin", async () => {
    const res = await OPTIONS(new Request("https://app.test/api/assistants/chat", { method: "OPTIONS" }));
    expect(res.status).toBe(403);
  });

  it("403s an origin matching no widget binding", async () => {
    resolveWidgetStreamOrigin.mockReturnValue(null);
    const res = await OPTIONS(new Request("https://app.test/api/assistants/chat", { method: "OPTIONS", headers: { Origin: "https://evil.test" } }));
    expect(res.status).toBe(403);
  });
});
