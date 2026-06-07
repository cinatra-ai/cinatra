/**
 * POST /api/test-delivery/send route tests.
 *
 * Mocks @/lib/auth-session, @/lib/database, and @/lib/trigger-email-send-use-cases
 * so the route can be exercised without network or DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next/headers is referenced transitively; stub it so the route handler can
// import its module graph without a real Next.js request context.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  getCampaignFromDatabase: vi.fn(),
}));

vi.mock("@/lib/trigger-email-send-use-cases", () => ({
  createTriggerEmailSendUseCases: vi.fn(),
}));

import { POST } from "../route";
import { getAuthSession } from "@/lib/auth-session";
import { getCampaignFromDatabase } from "@/lib/database";
import { createTriggerEmailSendUseCases } from "@/lib/trigger-email-send-use-cases";

const ALLOWED_ORIGIN = "http://localhost:3000";

function buildRequest(body: unknown, opts: { origin?: string | null } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== null) {
    headers.origin = opts.origin ?? ALLOWED_ORIGIN;
  }
  return new Request("http://localhost:3000/api/test-delivery/send", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validBody = {
  campaignId: "c1",
  recipientEmail: "to@example.com",
  selectionMode: "random_initial" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BETTER_AUTH_URL = ALLOWED_ORIGIN;
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/test-delivery/send", () => {
  it("returns 403 when origin is not allowed", async () => {
    const req = buildRequest(validBody, { origin: "http://evil.example.com" });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({ ok: false, error: "Forbidden" });
  });

  it("returns 401 when getAuthSession returns null", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(buildRequest(validBody));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "Unauthorized" });
  });

  // session.user?.id may be undefined; the route must reject explicitly
  // rather than forwarding userId:undefined to sendGmailMessage.
  it("returns 401 when session is present but user.id is missing", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: {},
      session: { id: "s1", activeOrganizationId: "org1" },
    });
    const res = await POST(buildRequest(validBody));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("returns 403 when session has no activeOrganizationId", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u1" },
      session: { id: "s1", activeOrganizationId: null },
    });
    const res = await POST(buildRequest(validBody));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "No active organization" });
  });

  it("returns 400 on invalid JSON body", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u1" },
      session: { id: "s1", activeOrganizationId: "org1" },
    });
    const req = buildRequest("not-json{", {});
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "Invalid JSON body" });
  });

  it("returns 400 on zod-invalid body (missing campaignId)", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u1" },
      session: { id: "s1", activeOrganizationId: "org1" },
    });
    const res = await POST(
      buildRequest({ recipientEmail: "to@x.com", selectionMode: "random_initial" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "Invalid request body" });
  });

  it("returns 404 when getCampaignFromDatabase returns null", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u1" },
      session: { id: "s1", activeOrganizationId: "org1" },
    });
    (getCampaignFromDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(buildRequest(validBody));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "Campaign not found" });
  });

  it("returns 200 { ok: true, sentTo } on successful send", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u1" },
      session: { id: "s1", activeOrganizationId: "org1" },
    });
    (getCampaignFromDatabase as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
    const sendTestEmail = vi.fn().mockResolvedValue({ ok: true, sentCount: 1 });
    (createTriggerEmailSendUseCases as ReturnType<typeof vi.fn>).mockReturnValue({
      sendTestEmail,
      startInitialSend: vi.fn(),
      getInitialSendStatus: vi.fn(),
      cancelInitialSend: vi.fn(),
      runInitialSendWorker: vi.fn(),
      processDueFollowUps: vi.fn(),
    });
    const res = await POST(buildRequest(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sentTo: "to@example.com" });
    expect(sendTestEmail).toHaveBeenCalledTimes(1);
  });

  it("returns 500 with sanitized 'Send failed' when use-cases throws", async () => {
    (getAuthSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u1" },
      session: { id: "s1", activeOrganizationId: "org1" },
    });
    (getCampaignFromDatabase as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1" });
    const sendTestEmail = vi.fn().mockRejectedValue(new Error("transport boom"));
    (createTriggerEmailSendUseCases as ReturnType<typeof vi.fn>).mockReturnValue({
      sendTestEmail,
      startInitialSend: vi.fn(),
      getInitialSendStatus: vi.fn(),
      cancelInitialSend: vi.fn(),
      runInitialSendWorker: vi.fn(),
      processDueFollowUps: vi.fn(),
    });
    // Suppress the route's console.warn during the failing path so vitest output stays clean.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(buildRequest(validBody));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "Send failed" });
    warnSpy.mockRestore();
  });
});
