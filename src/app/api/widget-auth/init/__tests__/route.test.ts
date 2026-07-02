import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#407 — POST /api/widget-auth/init. The widget-user-auth engine + the
// rate limiter are mocked at the boundary; the route's auth-before-parse order,
// agent/client matching, and status mapping run REAL. The generated agent map
// is mocked as data.
const {
  resolveSiteMock,
  createTxnMock,
  allowRequestMock,
} = vi.hoisted(() => ({
  resolveSiteMock: vi.fn(),
  createTxnMock: vi.fn(),
  allowRequestMock: vi.fn(),
}));

vi.mock("@/lib/widget-user-auth", () => ({
  resolveVerifiedSiteFromCredential: resolveSiteMock,
  createAuthTransaction: createTxnMock,
}));
vi.mock("@/lib/connect-rate-limit", () => ({
  allowConnectTokenRequest: allowRequestMock,
}));
vi.mock("@/lib/connect-provisioning", () => ({
  sha256Base64Url: (v: string) => `hash(${v})`,
}));
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: vi.fn(),
}));
vi.mock("@/lib/generated/extensions.server", () => ({
  GENERATED_WIDGET_STREAM_AGENTS: {
    "wordpress-content-editor": {
      load: async () => ({}),
      packageName: "@cinatra-ai/wordpress-mcp-connector",
      factory: "createWordPressWidgetChatTool",
      label: "WordPress",
      subjectNoun: "post",
      skillCapability: "widget-chat.wordpress-content-editor",
      contextFields: [],
      auth: {
        tokenConfigKey: "wordpress_widget_auth",
        instancesConfigKey: "wordpress",
        requiredInstanceFields: ["id", "name", "username", "applicationPassword"],
      },
    },
  },
}));

import { POST } from "../route";

const WP_ORIGIN = "https://wp.test";
const SITE = {
  siteId: "11111111-1111-1111-1111-111111111111",
  client: "wordpress",
  orgId: "org-A",
  siteOrigin: WP_ORIGIN,
  credentialVersion: 1,
};
const CHALLENGE = "a".repeat(43);
const STATE = "state-abcdefgh";

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://cinatra.test/api/widget-auth/init", {
    method: "POST",
    headers: {
      Authorization: "Bearer cnx_site_secret",
      "Content-Type": "application/json",
      Origin: WP_ORIGIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  client: "wordpress",
  agentSlug: "wordpress-content-editor",
  codeChallenge: CHALLENGE,
  codeChallengeMethod: "S256",
  state: STATE,
};

beforeEach(() => {
  vi.clearAllMocks();
  allowRequestMock.mockReturnValue(true);
  resolveSiteMock.mockReturnValue(SITE);
  createTxnMock.mockReturnValue({ ok: true, txnId: "txn-123", instanceId: "inst-1" });
});

describe("POST /api/widget-auth/init", () => {
  it("401s a missing credential (before body parse)", async () => {
    const res = await POST(
      new Request("https://cinatra.test/api/widget-auth/init", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: WP_ORIGIN },
        body: "{ not json",
      }),
    );
    expect(res.status).toBe(401);
    expect(resolveSiteMock).not.toHaveBeenCalled();
  });

  it("429s when rate-limited", async () => {
    allowRequestMock.mockReturnValue(false);
    const res = await POST(req(validBody));
    expect(res.status).toBe(429);
  });

  it("400s a non-S256 challenge method", async () => {
    const res = await POST(req({ ...validBody, codeChallengeMethod: "plain" }));
    expect(res.status).toBe(400);
  });

  it("404s an unknown agent slug", async () => {
    const res = await POST(req({ ...validBody, agentSlug: "nope" }));
    expect(res.status).toBe(404);
  });

  it("400s a client that does not match the agent's client", async () => {
    const res = await POST(req({ ...validBody, client: "drupal" }));
    expect(res.status).toBe(400);
  });

  it("401s an invalid cnx_ credential", async () => {
    resolveSiteMock.mockReturnValue(null);
    const res = await POST(req(validBody));
    expect(res.status).toBe(401);
  });

  it("409s when the origin has no single canonical instance (instance_unresolved)", async () => {
    createTxnMock.mockReturnValue({ ok: false, reason: "instance_unresolved" });
    const res = await POST(req(validBody));
    expect(res.status).toBe(409);
  });

  it("400s an invalid challenge/state from the engine", async () => {
    createTxnMock.mockReturnValue({ ok: false, reason: "invalid_code_challenge" });
    const res = await POST(req(validBody));
    expect(res.status).toBe(400);
  });

  it("200s with { txnId, authorizeUrl } on the SAME instance origin", async () => {
    const res = await POST(req(validBody));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { txnId: string; authorizeUrl: string; instanceId: string };
    expect(json.txnId).toBe("txn-123");
    expect(json.authorizeUrl).toBe("https://cinatra.test/widget-auth?txn=txn-123");
    expect(json.instanceId).toBe("inst-1");
    // The engine received the verified site + the claimed instance (here none).
    expect(createTxnMock).toHaveBeenCalledWith(
      expect.objectContaining({ site: SITE, agentSlug: "wordpress-content-editor", codeChallenge: CHALLENGE, state: STATE }),
    );
  });

  it("the cnx_ credential never appears in the response body", async () => {
    const res = await POST(req(validBody));
    const text = await res.text();
    expect(text).not.toContain("cnx_site_secret");
  });
});
