import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#407 — POST /api/widget-auth/token (code→user-token redeem). The
// widget-user-auth engine + rate limiter are mocked at the boundary; the
// route's auth, grant-type/agent/client checks, and generic invalid_grant
// mapping run REAL.
const {
  resolveSiteMock,
  redeemMock,
  allowRequestMock,
} = vi.hoisted(() => ({
  resolveSiteMock: vi.fn(),
  redeemMock: vi.fn(),
  allowRequestMock: vi.fn(),
}));

vi.mock("@/lib/widget-user-auth", () => ({
  resolveVerifiedSiteFromCredential: resolveSiteMock,
  redeemUserAuthCode: redeemMock,
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

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://cinatra.test/api/widget-auth/token", {
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
  grantType: "authorization_code",
  client: "wordpress",
  agentSlug: "wordpress-content-editor",
  code: "the-code",
  codeVerifier: "a".repeat(64),
};

beforeEach(() => {
  vi.clearAllMocks();
  allowRequestMock.mockReturnValue(true);
  resolveSiteMock.mockReturnValue(SITE);
  redeemMock.mockReturnValue({
    ok: true,
    token: "cwu_" + "x".repeat(43),
    tokenType: "Bearer",
    expiresIn: 900,
    scope: "wordpress-content-editor.user",
  });
});

describe("POST /api/widget-auth/token", () => {
  it("401s a missing credential", async () => {
    const res = await POST(
      new Request("https://cinatra.test/api/widget-auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: WP_ORIGIN },
        body: JSON.stringify(validBody),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("400s a non-authorization_code grant", async () => {
    const res = await POST(req({ ...validBody, grantType: "password" }));
    expect(res.status).toBe(400);
  });

  it("429s when rate-limited", async () => {
    allowRequestMock.mockReturnValue(false);
    const res = await POST(req(validBody));
    expect(res.status).toBe(429);
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

  it("400 invalid_grant on a redeem failure (generic, no oracle)", async () => {
    redeemMock.mockReturnValue({ ok: false, reason: "site_mismatch" });
    const res = await POST(req(validBody));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_grant");
  });

  it("200s with an opaque cwu_ token shape", async () => {
    const res = await POST(req(validBody));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      token: string;
      tokenType: string;
      expiresIn: number;
      scope: string;
    };
    expect(json.token).toMatch(/^cwu_[A-Za-z0-9_-]{43}$/);
    expect(json.tokenType).toBe("Bearer");
    expect(json.scope).toBe("wordpress-content-editor.user");
    // The engine received the verified site (cross-site binding is enforced there).
    expect(redeemMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: "the-code", site: SITE }),
    );
  });

  it("the cnx_ credential never appears in the response body", async () => {
    const res = await POST(req(validBody));
    const text = await res.text();
    expect(text).not.toContain("cnx_site_secret");
  });
});
