// Tests for `requestRemoteAccessAction`.
//
// Covers: 201 happy path (Nango-write-before-enqueue ordering, Idempotency-Key
// header, BullMQ enqueue with bare jobId `registry-poll:{requestId}` under the
// initial-enqueue contract), three 409 paths (namespace_taken /
// request_in_flight / idempotency_conflict), error paths (network throw, 5xx,
// Nango unavailable), validation, and Idempotency-Key day-bucket determinism.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({
    user: { id: "user-1", email: "operator@example.com" },
  })),
  requireAuthSession: vi.fn(async () => ({
    user: { id: "user-1", email: "operator@example.com" },
  })),
}));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
  writeInstanceIdentity: vi.fn(),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
}));
vi.mock("@/lib/instance-secrets", () => ({
  encryptSecret: vi.fn((s: string) => ({ ciphertext: "enc:" + s, iv: "iv-stub" })),
}));
vi.mock("@/lib/registry-credentials", () => ({
  writeRegistryCredential: vi.fn(),
  deleteRegistryCredential: vi.fn(),
  readRegistryCredential: vi.fn(),
}));
vi.mock("@/lib/redact-sensitive", () => ({
  redactSensitive: vi.fn((v: unknown) => v),
}));
vi.mock("@/lib/background-jobs", () => ({
  BACKGROUND_JOB_NAMES: { REGISTRY_POLL: "registry-poll" },
  enqueueBackgroundJob: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const err = new Error("REDIRECT:" + url);
    (err as unknown as { __isRedirect: true }).__isRedirect = true;
    throw err;
  }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { requestRemoteAccessAction } from "@/app/configuration/network/actions";
import { readInstanceIdentity, writeInstanceIdentity } from "@/lib/instance-identity-store";
import {
  writeRegistryCredential,
  deleteRegistryCredential,
} from "@/lib/registry-credentials";
import { enqueueBackgroundJob } from "@/lib/background-jobs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

function buildFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function buildValidFormData(overrides: Record<string, string> = {}): FormData {
  return buildFormData({
    contactEmail: "operator@example.com",
    ...overrides,
  });
}

function mockFetchResponse(status: number, body: unknown, headers: Record<string, string> = {}): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  ) as unknown as typeof fetch;
}

async function captureRedirect(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
  } catch (err) {
    const e = err as { __isRedirect?: true; message?: string };
    if (e.__isRedirect && typeof e.message === "string" && e.message.startsWith("REDIRECT:")) {
      return e.message.slice("REDIRECT:".length);
    }
    throw err;
  }
  return null;
}

function setIdentityWithNamespace(): void {
  vi.mocked(readInstanceIdentity).mockReturnValue({
    instanceNamespace: "test-ns",
    instanceDisplayName: "Test",
    registries: {
      remote: {
        url: "https://registry.example",
        namespace: "test-ns",
        status: "not_connected",
      },
    },
  } as unknown as ReturnType<typeof readInstanceIdentity>);
}

beforeEach(() => {
  vi.clearAllMocks();
  setIdentityWithNamespace();
  // Default mockFetchResponse to a clean 201 that will be overridden per test.
  mockFetchResponse(201, {
    requestId: "req-1",
    requestSecret: "secret-xyz",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    pollIntervalSeconds: 30,
  });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 201 happy path
// ---------------------------------------------------------------------------

describe("requestRemoteAccessAction — 201 happy path", () => {
  it("calls registry POST with the documented body shape", async () => {
    await captureRedirect(() => requestRemoteAccessAction(buildValidFormData()));
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/api\/register$/);
    expect((init as RequestInit).method).toBe("POST");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("content-type")?.toLowerCase()).toBe("application/json");
    const parsedBody = JSON.parse(String((init as RequestInit).body));
    expect(parsedBody).toEqual(
      expect.objectContaining({
        namespace: "test-ns",
        contactEmail: "operator@example.com",
      }),
    );
    expect(typeof parsedBody.instanceUrl).toBe("string");
  });

  it("includes an Idempotency-Key header set to a 64-char hex string", async () => {
    await captureRedirect(() => requestRemoteAccessAction(buildValidFormData()));
    const fetchMock = vi.mocked(globalThis.fetch);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers((init as RequestInit).headers);
    const key = headers.get("Idempotency-Key");
    expect(key).not.toBeNull();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("calls writeRegistryCredential with the requestSecret BEFORE writeInstanceIdentity", async () => {
    await captureRedirect(() => requestRemoteAccessAction(buildValidFormData()));
    const writeCred = vi.mocked(writeRegistryCredential);
    const writeIdentity = vi.mocked(writeInstanceIdentity);
    expect(writeCred).toHaveBeenCalledWith("test-ns", "request-secret", "secret-xyz");
    expect(writeIdentity).toHaveBeenCalled();
    const writeCredOrder = writeCred.mock.invocationCallOrder[0]!;
    const writeIdentityOrder = writeIdentity.mock.invocationCallOrder[0]!;
    expect(writeCredOrder).toBeLessThan(writeIdentityOrder);
  });

  it("calls writeRegistryCredential BEFORE enqueueBackgroundJob", async () => {
    await captureRedirect(() => requestRemoteAccessAction(buildValidFormData()));
    const writeCred = vi.mocked(writeRegistryCredential);
    const enqueue = vi.mocked(enqueueBackgroundJob);
    expect(writeCred).toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalled();
    const writeCredOrder = writeCred.mock.invocationCallOrder[0]!;
    const enqueueOrder = enqueue.mock.invocationCallOrder[0]!;
    expect(writeCredOrder).toBeLessThan(enqueueOrder);
  });

  it("enqueues with bare jobId 'registry-poll:{requestId}' and delay = pollIntervalSeconds * 1000", async () => {
    await captureRedirect(() => requestRemoteAccessAction(buildValidFormData()));
    const enqueue = vi.mocked(enqueueBackgroundJob);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const args = enqueue.mock.calls[0];
    expect(args[0]).toBe("registry-poll");
    expect(args[1]).toEqual(expect.objectContaining({ requestId: "req-1" }));
    // Single-in-flight contract: initial enqueue uses BARE jobId, not
    // the timestamped form (the timestamped form is reserved for handler-
    // side self-reschedules).
    expect(args[2]).toEqual(
      expect.objectContaining({ jobId: "registry-poll:req-1", delay: 30_000 }),
    );
    expect(String(args[2]?.jobId)).toBe("registry-poll:req-1");
  });

  it("redirects to /configuration/environment?tab=registries&ok=requested", async () => {
    const url = await captureRedirect(() => requestRemoteAccessAction(buildValidFormData()));
    expect(url).toBe("/configuration/environment?tab=registries&ok=requested");
  });
});

// ---------------------------------------------------------------------------
// 409 paths
// ---------------------------------------------------------------------------

describe("requestRemoteAccessAction — 409 paths", () => {
  it.each([
    ["namespace_taken"],
    ["request_in_flight"],
    ["idempotency_conflict"],
  ])("redirects with error=%s on 409", async (code) => {
    mockFetchResponse(409, { error: { code } });
    const url = await captureRedirect(() =>
      requestRemoteAccessAction(buildValidFormData()),
    );
    expect(url).toBe(`/configuration/environment?tab=registries&error=${code}`);
    expect(vi.mocked(writeRegistryCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("requestRemoteAccessAction — error paths", () => {
  it("redirects with registry_unreachable on network throw", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const url = await captureRedirect(() =>
      requestRemoteAccessAction(buildValidFormData()),
    );
    expect(url).toBe("/configuration/environment?tab=registries&error=registry_unreachable");
    expect(vi.mocked(writeRegistryCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
  });

  it("redirects with registry_unreachable on 5xx", async () => {
    mockFetchResponse(503, { error: "down" });
    const url = await captureRedirect(() =>
      requestRemoteAccessAction(buildValidFormData()),
    );
    expect(url).toBe("/configuration/environment?tab=registries&error=registry_unreachable");
    expect(vi.mocked(writeRegistryCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
  });

  it("redirects with nango_unavailable when writeRegistryCredential rejects", async () => {
    vi.mocked(writeRegistryCredential).mockRejectedValueOnce(new Error("nango down"));
    const url = await captureRedirect(() =>
      requestRemoteAccessAction(buildValidFormData()),
    );
    expect(url).toBe("/configuration/environment?tab=registries&error=nango_unavailable");
    // No local row persisted — the registry has the request and replays
    // its 201 within 24h via Idempotency-Key cache once Nango is fixed.
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
    // best-effort: deleteRegistryCredential is NOT expected (we never wrote)
    expect(vi.mocked(deleteRegistryCredential)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Idempotency-Key determinism
// ---------------------------------------------------------------------------

describe("requestRemoteAccessAction — Idempotency-Key determinism", () => {
  it("produces the same Idempotency-Key for identical inputs in the same UTC day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));

    await captureRedirect(() => requestRemoteAccessAction(buildValidFormData()));
    const fetchMock = vi.mocked(globalThis.fetch);
    const headers1 = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    const key1 = headers1.get("Idempotency-Key");

    vi.clearAllMocks();
    setIdentityWithNamespace();
    mockFetchResponse(201, {
      requestId: "req-1",
      requestSecret: "secret-xyz",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      pollIntervalSeconds: 30,
    });

    // Advance clock within the same UTC day.
    vi.setSystemTime(new Date("2026-05-09T12:00:00Z"));
    await captureRedirect(() => requestRemoteAccessAction(buildValidFormData()));
    const fetchMock2 = vi.mocked(globalThis.fetch);
    const headers2 = new Headers((fetchMock2.mock.calls[0]?.[1] as RequestInit).headers);
    const key2 = headers2.get("Idempotency-Key");

    expect(key1).not.toBeNull();
    expect(key2).not.toBeNull();
    expect(key1).toBe(key2);
  });

  it("produces a DIFFERENT Idempotency-Key when the UTC day rolls over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));

    await captureRedirect(() => requestRemoteAccessAction(buildValidFormData()));
    const fetchMock = vi.mocked(globalThis.fetch);
    const headers1 = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    const key1 = headers1.get("Idempotency-Key");

    vi.clearAllMocks();
    setIdentityWithNamespace();
    mockFetchResponse(201, {
      requestId: "req-1",
      requestSecret: "secret-xyz",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      pollIntervalSeconds: 30,
    });

    // Advance clock to the next UTC day.
    vi.setSystemTime(new Date("2026-05-10T00:00:00Z"));
    await captureRedirect(() => requestRemoteAccessAction(buildValidFormData()));
    const fetchMock2 = vi.mocked(globalThis.fetch);
    const headers2 = new Headers((fetchMock2.mock.calls[0]?.[1] as RequestInit).headers);
    const key2 = headers2.get("Idempotency-Key");

    expect(key1).not.toBeNull();
    expect(key2).not.toBeNull();
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("requestRemoteAccessAction — validation", () => {
  it("redirects with a validation error on empty contactEmail and does not call fetch", async () => {
    const url = await captureRedirect(() =>
      requestRemoteAccessAction(buildFormData({ contactEmail: "" })),
    );
    expect(url).not.toBeNull();
    expect(url).toMatch(/error=/);
    // fetch was not called — validation runs first.
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(writeRegistryCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
  });

  it("redirects with a validation error on syntactically invalid contactEmail", async () => {
    const url = await captureRedirect(() =>
      requestRemoteAccessAction(buildFormData({ contactEmail: "not-an-email" })),
    );
    expect(url).not.toBeNull();
    expect(url).toMatch(/error=/);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(writeRegistryCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
  });
});
