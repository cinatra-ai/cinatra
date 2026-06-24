import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";

const writeDefaultLlmProviderToDatabase = vi.fn();
const logAuditEventStrict = vi.fn();

vi.mock("@/lib/database", () => ({
  writeDefaultLlmProviderToDatabase: (p: unknown) => writeDefaultLlmProviderToDatabase(p),
}));
vi.mock("@/lib/authz/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authz/audit")>("@/lib/authz/audit");
  return { ...actual, logAuditEventStrict: (i: unknown) => logAuditEventStrict(i) };
});

import {
  updateDefaultLlmProvider,
  DefaultLlmProviderAuthzError,
  DefaultLlmProviderAuditError,
} from "../default-llm-provider-mutation";

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

describe("updateDefaultLlmProvider", () => {
  beforeEach(() => {
    logAuditEventStrict.mockResolvedValue({ id: "audit-1" });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an undefined actor (fail-closed) and does not write", async () => {
    await expect(
      updateDefaultLlmProvider({ actor: undefined, provider: "openai" }),
    ).rejects.toBeInstanceOf(DefaultLlmProviderAuthzError);
    expect(writeDefaultLlmProviderToDatabase).not.toHaveBeenCalled();
  });

  it("rejects org_admin (settings.update is not enough) and does not write", async () => {
    await expect(
      updateDefaultLlmProvider({ actor: orgAdmin(), provider: "openai" }),
    ).rejects.toBeInstanceOf(DefaultLlmProviderAuthzError);
    expect(writeDefaultLlmProviderToDatabase).not.toHaveBeenCalled();
    expect(logAuditEventStrict).not.toHaveBeenCalled();
  });

  it("platform admin: audits BEFORE writing", async () => {
    const order: string[] = [];
    logAuditEventStrict.mockImplementation(async () => {
      order.push("audit");
      return { id: "a" };
    });
    writeDefaultLlmProviderToDatabase.mockImplementation(() => order.push("write"));
    await updateDefaultLlmProvider({ actor: platformAdmin(), provider: "gemini" });
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

  it("does NOT write if the audit insert throws", async () => {
    logAuditEventStrict.mockRejectedValueOnce(new Error("db down"));
    await expect(
      updateDefaultLlmProvider({ actor: platformAdmin(), provider: "openai" }),
    ).rejects.toBeInstanceOf(DefaultLlmProviderAuditError);
    expect(writeDefaultLlmProviderToDatabase).not.toHaveBeenCalled();
  });
});
