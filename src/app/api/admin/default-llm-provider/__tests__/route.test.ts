import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";

const getActorContext = vi.fn<() => Promise<ActorContext | undefined>>();
const writeDefaultLlmProviderToDatabase = vi.fn();
const readDefaultLlmProviderFromDatabase = vi.fn(() => "openai");
const logAuditEventStrict = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getActorContext: () => getActorContext(),
}));
vi.mock("@/lib/database", () => ({
  writeDefaultLlmProviderToDatabase: (p: unknown) => writeDefaultLlmProviderToDatabase(p),
  readDefaultLlmProviderFromDatabase: () => readDefaultLlmProviderFromDatabase(),
}));
vi.mock("@/lib/authz/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authz/audit")>("@/lib/authz/audit");
  return { ...actual, logAuditEventStrict: (i: unknown) => logAuditEventStrict(i) };
});

const URL_ = "https://app.test/api/admin/default-llm-provider";

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

function putReq(body: unknown, headers?: Record<string, string>): Request {
  return new Request(URL_, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
}

describe("default-llm-provider PUT", () => {
  beforeEach(() => {
    logAuditEventStrict.mockResolvedValue({ id: "audit-1" });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("401 when unauthenticated", async () => {
    getActorContext.mockResolvedValue(undefined);
    const { PUT } = await import("../route");
    const res = await PUT(putReq({ provider: "openai" }));
    expect(res.status).toBe(401);
    expect(writeDefaultLlmProviderToDatabase).not.toHaveBeenCalled();
  });

  it("403 for org_admin (settings.update is NOT enough — must be platform admin)", async () => {
    getActorContext.mockResolvedValue(orgAdmin());
    const { PUT } = await import("../route");
    const res = await PUT(putReq({ provider: "openai" }));
    expect(res.status).toBe(403);
    expect(writeDefaultLlmProviderToDatabase).not.toHaveBeenCalled();
    expect(logAuditEventStrict).not.toHaveBeenCalled();
  });

  it("platform admin: writes a strict audit row BEFORE the DB write, then writes", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const order: string[] = [];
    logAuditEventStrict.mockImplementation(async () => {
      order.push("audit");
      return { id: "a" };
    });
    writeDefaultLlmProviderToDatabase.mockImplementation(() => {
      order.push("write");
    });
    const { PUT } = await import("../route");
    const res = await PUT(putReq({ provider: "gemini" }));
    expect(res.status).toBe(200);
    expect(order).toEqual(["audit", "write"]);
    expect(logAuditEventStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "settings.default_llm_provider.update",
        resourceType: "administration",
        resourceId: "llm_default_provider",
        decision: "allowed",
        metadata: expect.objectContaining({ provider: "gemini" }),
      }),
    );
  });

  it("does NOT write if the audit insert fails (503)", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    logAuditEventStrict.mockRejectedValueOnce(new Error("db down"));
    const { PUT } = await import("../route");
    const res = await PUT(putReq({ provider: "openai" }));
    expect(res.status).toBe(503);
    expect(writeDefaultLlmProviderToDatabase).not.toHaveBeenCalled();
  });

  it("400 on an invalid provider (after the platform gate passes)", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { PUT } = await import("../route");
    const res = await PUT(putReq({ provider: "anthropic" }));
    expect(res.status).toBe(400);
    expect(writeDefaultLlmProviderToDatabase).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request 403 before auth runs", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { PUT } = await import("../route");
    const res = await PUT(putReq({ provider: "openai" }, { origin: "https://evil.test" }));
    expect(res.status).toBe(403);
    expect(getActorContext).not.toHaveBeenCalled();
    expect(writeDefaultLlmProviderToDatabase).not.toHaveBeenCalled();
  });
});
