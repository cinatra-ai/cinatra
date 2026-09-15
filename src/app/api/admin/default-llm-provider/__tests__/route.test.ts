import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";

const getActorContext = vi.fn<() => Promise<ActorContext | undefined>>();
// STATEFUL default-provider seam: the S3 Administration transition verifies
// its audited write actually LANDED by re-reading the stored default, so the
// read must observe the write (a fixed "openai" would read as a silent
// non-landing and roll the transition back).
const storedDefault = { value: "openai" };
// The spy is observation-only; the STATE update lives in the factory wrapper
// below so a per-test `mockImplementation` (e.g. the audit/write ordering
// probe) can never break the read-your-write behavior the transition verifies.
const writeDefaultLlmProviderToDatabase = vi.fn();
const readDefaultLlmProviderFromDatabase = vi.fn(() => storedDefault.value);
const logAuditEventStrict = vi.fn();

// In-memory metadata rows for the provider-commit record the route's S3
// transition (cinatra#2388) fences its write through.
const metadataStore = new Map<string, string>();

vi.mock("@/lib/auth-session", () => ({
  getActorContext: () => getActorContext(),
}));
vi.mock("@/lib/database", () => ({
  writeDefaultLlmProviderToDatabase: (p: unknown) => {
    storedDefault.value = String(p);
    writeDefaultLlmProviderToDatabase(p);
  },
  readDefaultLlmProviderFromDatabase: () => readDefaultLlmProviderFromDatabase(),
  readRawMetadataStringFromDatabase: (key: string) => metadataStore.get(key) ?? null,
  writeMetadataValueIfAbsentToDatabase: (key: string, value: unknown) => {
    if (!metadataStore.has(key)) metadataStore.set(key, JSON.stringify(value));
  },
  compareAndSwapMetadataValueFromDatabase: (
    key: string,
    value: unknown,
    expectedRaw: string,
  ) => {
    if (metadataStore.get(key) !== expectedRaw) return false;
    metadataStore.set(key, JSON.stringify(value));
    return true;
  },
}));
// The transition's credential-fingerprint read (host-owned keyed digest) is
// exercised by llm-credential-fingerprint.test.ts; here it degrades to
// unreadable so no connector surface is needed.
vi.mock("@/lib/llm-credential-fingerprint", () => ({
  readLiveCredentialFingerprint: async () => ({
    status: "unreadable",
    reason: "connector-unavailable",
  }),
  liveCredentialFingerprintMatches: () => false,
}));
// The receipt seam the commit module imports (unused by the route's path).
vi.mock("@/lib/setup-readiness-saga", () => ({
  readSetupReadinessState: async () => ({ ready: false, receipt: null }),
  readSetupReadinessReceipt: () => null,
  // S4 (cinatra#2389): imported by setup-provider-commit's fresh derivation;
  // this route's own paths never reach it — shimmed per the cinatra#850
  // vi.mock-factory convention.
  areProviderReadinessInputsSatisfied: () => false,
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
    storedDefault.value = "openai";
    metadataStore.clear();
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

  // S6 UN-FENCING (cinatra#2093, epic #2086): Anthropic is `defaultCapable` and
  // is therefore ACCEPTED here. Before S6 this route hardcoded
  // ["openai","gemini"] and 400'd it — one of the four fences the ABI v2
  // `defaultCapable` flag replaces.
  it("ACCEPTS anthropic as the global default (S6 un-fencing)", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { PUT } = await import("../route");
    const res = await PUT(putReq({ provider: "anthropic" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: "anthropic" });
  });

  it("400 on an invalid provider (after the platform gate passes)", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { PUT } = await import("../route");
    // Still fail-closed on anything with no `defaultCapable` declaration.
    const res = await PUT(putReq({ provider: "mistral" }));
    expect(res.status).toBe(400);
    expect(writeDefaultLlmProviderToDatabase).not.toHaveBeenCalled();
  });

  // S3 (cinatra#2388): a provider change during a PENDING setup claim is a
  // CLASSIFIED conflict — 409 with the conflict kind, never an unclassified 500.
  it("409 (classified) while a setup claim is pending; nothing is written", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    metadataStore.set(
      "setup_provider_commit",
      JSON.stringify({
        recordVersion: 1,
        state: "claimed",
        nonce: "n1",
        provider: "openai",
        startingCredentialFingerprint: null,
        priorDefault: "openai",
        actorId: "someone",
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const { PUT } = await import("../route");
    const res = await PUT(putReq({ provider: "anthropic" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ conflict: "claim-pending" });
    expect(writeDefaultLlmProviderToDatabase).not.toHaveBeenCalled();
    expect(logAuditEventStrict).not.toHaveBeenCalled();
  });

  // S3 (cinatra#2388): the landed change also moves the COMMITMENT record.
  it("a landed change leaves a committed record matching the audited default", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { PUT } = await import("../route");
    const res = await PUT(putReq({ provider: "anthropic" }));
    expect(res.status).toBe(200);
    const record = JSON.parse(metadataStore.get("setup_provider_commit") ?? "null");
    expect(record).toMatchObject({
      state: "committed",
      provider: "anthropic",
      provenance: "administration",
    });
    expect(storedDefault.value).toBe("anthropic");
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
