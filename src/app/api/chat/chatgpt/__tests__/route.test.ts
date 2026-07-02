import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// Route-handler regression test for the Codex-bridge route. The
// authz kernel runs for real (so the platform-only gate is exercised
// end-to-end); the session, the Codex bridge spawn, and the audit sink are
// mocked so no Redis/DB/child-process is needed. Asserts: no session -> 401,
// non-platform actor -> 403, cross-origin -> 403, oversized body -> 413, and
// the Codex bridge is NEVER reached on a denial.
// ---------------------------------------------------------------------------

const getActorContext = vi.fn<() => Promise<ActorContext | undefined>>();
const callCodexCliAssistant = vi.fn();
const logAuditEventStrict = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getActorContext: () => getActorContext(),
}));
vi.mock("@/lib/codex-bridge", () => ({
  callCodexCliAssistant: (...a: unknown[]) => callCodexCliAssistant(...a),
}));
vi.mock("@/lib/authz/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authz/audit")>("@/lib/authz/audit");
  return { ...actual, logAuditEventStrict: (i: unknown) => logAuditEventStrict(i) };
});

const ENDPOINT = "https://app.test/api/chat/chatgpt";

function platformAdmin(): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "admin-1",
    organizationId: "org-1",
    platformRole: "platform_admin",
    orgRole: "member",
    authSource: "ui",
    policyVersion: "v2",
  };
}
function orgAdmin(): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-2",
    organizationId: "org-1",
    platformRole: "member",
    orgRole: "org_admin",
    authSource: "ui",
    policyVersion: "v2",
  };
}

function makeReq(bodyObj: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj),
  });
}

const VALID_BODY = { messages: [{ role: "user", content: "hello" }] };

describe("chat/chatgpt route handler (Codex bridge gate)", () => {
  beforeEach(() => {
    logAuditEventStrict.mockResolvedValue({ id: "audit-1" });
    callCodexCliAssistant.mockResolvedValue("hi there");
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("401 when unauthenticated — bridge never spawned", async () => {
    getActorContext.mockResolvedValue(undefined);
    const { POST } = await import("../route");
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(401);
    expect(callCodexCliAssistant).not.toHaveBeenCalled();
    expect(logAuditEventStrict).not.toHaveBeenCalled();
  });

  it("403 for a non-platform actor (org_admin) — bridge never spawned", async () => {
    getActorContext.mockResolvedValue(orgAdmin());
    const { POST } = await import("../route");
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(403);
    expect(callCodexCliAssistant).not.toHaveBeenCalled();
    expect(logAuditEventStrict).not.toHaveBeenCalled();
  });

  it("403 cross-origin before auth runs — bridge never spawned", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { POST } = await import("../route");
    const res = await POST(makeReq(VALID_BODY, { origin: "https://evil.test" }));
    expect(res.status).toBe(403);
    expect(getActorContext).not.toHaveBeenCalled();
    expect(callCodexCliAssistant).not.toHaveBeenCalled();
  });

  it("platform admin is allowed — audited, then bridge spawned (SSE)", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { POST } = await import("../route");
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    // Drain the stream so the start() callback runs.
    await res.text();
    expect(logAuditEventStrict).toHaveBeenCalledTimes(1);
    expect(callCodexCliAssistant).toHaveBeenCalledTimes(1);
  });

  it("503 when the pre-spawn audit write fails — bridge never spawned", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    logAuditEventStrict.mockRejectedValueOnce(new Error("db down"));
    const { POST } = await import("../route");
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(503);
    expect(callCodexCliAssistant).not.toHaveBeenCalled();
  });

  it("413 for an oversized body — bridge never spawned", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const huge = "x".repeat(40 * 1024);
    const body = JSON.stringify({ messages: [{ role: "user", content: huge }] });
    const { POST } = await import("../route");
    const res = await POST(makeReq(body));
    expect(res.status).toBe(413);
    expect(callCodexCliAssistant).not.toHaveBeenCalled();
  });
});
