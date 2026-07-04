import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

// The Drupal node-publish webhook receiver (drupal-module#72), the twin of
// /api/webhooks/wordpress. We keep the REAL verifyDrupalWebhookSignature (pure
// node:crypto) so the signed-payload cases exercise the actual HMAC, and stub
// only the DB-backed config read. @/lib/database is mocked so importing the real
// drupal-widget-auth module never pulls drizzle/agents.
const { readConfigMock } = vi.hoisted(() => ({ readConfigMock: vi.fn() }));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(),
  writeConnectorConfigToDatabase: vi.fn(),
}));
vi.mock("@/lib/drupal-widget-auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/drupal-widget-auth")>();
  return { ...actual, readDrupalWidgetAuthConfig: readConfigMock };
});

import { POST } from "../route";

const SECRET = "test-drupal-webhook-secret";

function sign(body: string, secret: string = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/webhooks/drupal", {
    method: "POST",
    body,
    headers,
  });
}

const validPayload = {
  event: "node_published",
  nodeId: 42,
  nodeType: "article",
  title: "Hello",
  url: "https://drupal.example/node/42",
  siteUrl: "https://drupal.example",
  issuedAt: "2026-07-04T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  readConfigMock.mockReturnValue({
    apiKey: "k",
    webhookSecret: SECRET,
    generatedAt: "2026-01-01T00:00:00Z",
  });
});

describe("POST /api/webhooks/drupal", () => {
  it("400 when no widget-auth config exists", async () => {
    readConfigMock.mockReturnValue(null);
    const body = JSON.stringify(validPayload);
    const res = await POST(post(body, { "X-Cinatra-Sig-256": sign(body) }));
    expect(res.status).toBe(400);
  });

  it("400 when the config predates the webhook contract (no webhookSecret)", async () => {
    readConfigMock.mockReturnValue({ apiKey: "k", generatedAt: "2026-01-01T00:00:00Z" });
    const body = JSON.stringify(validPayload);
    const res = await POST(post(body, { "X-Cinatra-Sig-256": sign(body) }));
    expect(res.status).toBe(400);
  });

  it("401 on a missing signature", async () => {
    const body = JSON.stringify(validPayload);
    const res = await POST(post(body));
    expect(res.status).toBe(401);
  });

  it("401 on a signature made with the wrong secret", async () => {
    const body = JSON.stringify(validPayload);
    const res = await POST(post(body, { "X-Cinatra-Sig-256": sign(body, "wrong-secret") }));
    expect(res.status).toBe(401);
  });

  it("400 on a correctly-signed but schema-invalid payload", async () => {
    // A valid signature over an off-contract event — auth passes, Zod rejects.
    const body = JSON.stringify({ ...validPayload, event: "post_published" });
    const res = await POST(post(body, { "X-Cinatra-Sig-256": sign(body) }));
    expect(res.status).toBe(400);
  });

  it("200 {ok:true} on a signed, valid node_published payload", async () => {
    const body = JSON.stringify(validPayload);
    const res = await POST(post(body, { "X-Cinatra-Sig-256": sign(body) }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("200 when the optional url is omitted", async () => {
    const { url: _omit, ...noUrl } = validPayload;
    const body = JSON.stringify(noUrl);
    const res = await POST(post(body, { "X-Cinatra-Sig-256": sign(body) }));
    expect(res.status).toBe(200);
  });
});
