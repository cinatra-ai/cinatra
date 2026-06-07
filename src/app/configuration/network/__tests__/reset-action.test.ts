// Co-located regression test for `resetRemoteRegistryAction`.
//
// Locks the contract: terminal states (denied / expired / error) clean
// BOTH Nango credentials and reset the slot; connected / pending /
// not_connected are no-ops; admin gate enforced; Nango cleanup is
// idempotent on errors.
//
// Mocking scaffold mirrors `src/app/setup/name/__tests__/actions.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstanceIdentity, RemoteRegistryConnection } from "@/lib/instance-identity-store";

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({ user: { id: "user-1", email: "operator@example.com" } })),
  requireAuthSession: vi.fn(async () => ({ user: { id: "user-1", email: "operator@example.com" } })),
}));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
  writeInstanceIdentity: vi.fn(),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
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
vi.mock("@/lib/instance-secrets", () => ({
  encryptSecret: vi.fn((s: string) => ({ ciphertext: "enc:" + s, iv: "iv-stub" })),
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

import { resetRemoteRegistryAction } from "@/app/configuration/network/actions";
import { requireAdminSession } from "@/lib/auth-session";
import { readInstanceIdentity, writeInstanceIdentity } from "@/lib/instance-identity-store";
import { deleteRegistryCredential } from "@/lib/registry-credentials";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RemoteOverrides = Partial<RemoteRegistryConnection> & {
  status: RemoteRegistryConnection["status"];
};

function setRemoteState(over: RemoteOverrides): InstanceIdentity {
  const identity: InstanceIdentity = {
    instanceNamespace: over.namespace ?? "test-ns",
    instanceDisplayName: "Test",
    registries: {
      remote: {
        url: "https://registry.example",
        namespace: over.namespace ?? "test-ns",
        ...over,
      } as RemoteRegistryConnection,
    },
  } as unknown as InstanceIdentity;
  vi.mocked(readInstanceIdentity).mockReturnValue(identity);
  return identity;
}

function setNoRemoteState(): InstanceIdentity {
  const identity: InstanceIdentity = {
    instanceNamespace: "test-ns",
    instanceDisplayName: "Test",
    registries: {},
  } as unknown as InstanceIdentity;
  vi.mocked(readInstanceIdentity).mockReturnValue(identity);
  return identity;
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

beforeEach(() => {
  vi.clearAllMocks();
  // Default success behavior; individual tests override.
  vi.mocked(deleteRegistryCredential).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Terminal states (denied / expired / error → not_connected)
// ---------------------------------------------------------------------------

describe("resetRemoteRegistryAction — terminal states (denied/expired/error → not_connected)", () => {
  for (const status of ["denied", "expired", "error"] as const) {
    it(`clears both Nango credentials and flips slot to not_connected when status is ${status}`, async () => {
      setRemoteState({
        status,
        namespace: "test-ns",
        url: "https://registry.example",
      });

      const url = await captureRedirect(() => resetRemoteRegistryAction());

      // Both Nango credentials are deleted (partial-write-success cleanup).
      expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith("test-ns", "request-secret");
      expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith("test-ns", "token");

      // Slot reset to not_connected with no transient fields.
      expect(vi.mocked(writeInstanceIdentity)).toHaveBeenCalledTimes(1);
      const writtenIdentity = vi.mocked(writeInstanceIdentity).mock.calls[0]![0];
      expect(writtenIdentity.registries?.remote).toEqual({
        url: "https://registry.example",
        namespace: "test-ns",
        status: "not_connected",
      });

      // Redirect ends with &ok=requested-reset.
      expect(url).not.toBeNull();
      expect(url!.endsWith("&ok=requested-reset")).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Non-terminal states (no-ops)
// ---------------------------------------------------------------------------

describe("resetRemoteRegistryAction — non-terminal states are no-ops", () => {
  it("no-ops when status is connected (operator must use disconnect)", async () => {
    setRemoteState({
      status: "connected",
      namespace: "test-ns",
      url: "https://registry.example",
    });

    const url = await captureRedirect(() => resetRemoteRegistryAction());

    expect(vi.mocked(deleteRegistryCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
    expect(url).not.toBeNull();
    expect(url!.endsWith("&ok=requested-reset")).toBe(true);
  });

  it("no-ops when status is pending (operator must use cancel)", async () => {
    setRemoteState({
      status: "pending",
      namespace: "test-ns",
      url: "https://registry.example",
      requestId: "req-1",
    });

    const url = await captureRedirect(() => resetRemoteRegistryAction());

    expect(vi.mocked(deleteRegistryCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
    expect(url).not.toBeNull();
    expect(url!.endsWith("&ok=requested-reset")).toBe(true);
  });

  it("no-ops idempotently when status is not_connected", async () => {
    setRemoteState({
      status: "not_connected",
      namespace: "test-ns",
      url: "https://registry.example",
    });

    const url = await captureRedirect(() => resetRemoteRegistryAction());

    expect(vi.mocked(deleteRegistryCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
    expect(url).not.toBeNull();
    expect(url!.endsWith("&ok=requested-reset")).toBe(true);
  });

  it("no-ops idempotently when remote slot is absent", async () => {
    setNoRemoteState();

    const url = await captureRedirect(() => resetRemoteRegistryAction());

    expect(vi.mocked(deleteRegistryCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
    expect(url).not.toBeNull();
    expect(url!.endsWith("&ok=requested-reset")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Admin gate
// ---------------------------------------------------------------------------

describe("resetRemoteRegistryAction — admin gate", () => {
  it("redirects to /not-authorized when requireAdminSession rejects (no Nango call, no slot write)", async () => {
    // requireAdminSession redirects unauthorized requests via Next.js redirect()
    // (the standard pattern in this codebase: throws a NEXT_REDIRECT-shaped
    // error rather than returning null).
    vi.mocked(requireAdminSession).mockImplementationOnce(async () => {
      const err = new Error("REDIRECT:/not-authorized");
      (err as unknown as { __isRedirect: true }).__isRedirect = true;
      throw err;
    });

    // Even with terminal state in identity, the gate must trip first.
    setRemoteState({
      status: "error",
      namespace: "test-ns",
      url: "https://registry.example",
    });

    const url = await captureRedirect(() => resetRemoteRegistryAction());

    expect(url).not.toBeNull();
    expect(url!.startsWith("/")).toBe(true);
    // /not-authorized is the canonical admin-gate redirect (auth-session.ts).
    // Accept either /not-authorized OR any path that contains "error=" as the
    // observable contract — the action must never reach Nango or slot-write.
    expect(
      url!.includes("not-authorized") || url!.includes("error="),
    ).toBe(true);

    expect(vi.mocked(deleteRegistryCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Nango cleanup is idempotent (errors do not block slot reset)
// ---------------------------------------------------------------------------

describe("resetRemoteRegistryAction — Nango cleanup is idempotent", () => {
  it("does not throw when deleteRegistryCredential rejects (idempotent try/catch)", async () => {
    setRemoteState({
      status: "error",
      namespace: "test-ns",
      url: "https://registry.example",
    });

    // First call rejects (request-secret), second call resolves (token).
    vi.mocked(deleteRegistryCredential)
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce(undefined);

    // Suppress redactSensitive output noise without losing visibility on real errors.
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const url = await captureRedirect(() => resetRemoteRegistryAction());

    // Action proceeds past the Nango error and still resets the slot.
    expect(vi.mocked(writeInstanceIdentity)).toHaveBeenCalledTimes(1);
    const writtenIdentity = vi.mocked(writeInstanceIdentity).mock.calls[0]![0];
    expect(writtenIdentity.registries?.remote).toEqual({
      url: "https://registry.example",
      namespace: "test-ns",
      status: "not_connected",
    });

    expect(url).not.toBeNull();
    expect(url!.endsWith("&ok=requested-reset")).toBe(true);

    consoleWarnSpy.mockRestore();
  });

  it("does not throw when both deleteRegistryCredential calls reject (slot still reset)", async () => {
    setRemoteState({
      status: "denied",
      namespace: "test-ns",
      url: "https://registry.example",
    });

    vi.mocked(deleteRegistryCredential)
      .mockRejectedValueOnce(new Error("nango outage 1"))
      .mockRejectedValueOnce(new Error("nango outage 2"));

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const url = await captureRedirect(() => resetRemoteRegistryAction());

    expect(vi.mocked(writeInstanceIdentity)).toHaveBeenCalledTimes(1);
    const writtenIdentity = vi.mocked(writeInstanceIdentity).mock.calls[0]![0];
    expect(writtenIdentity.registries?.remote).toEqual({
      url: "https://registry.example",
      namespace: "test-ns",
      status: "not_connected",
    });

    expect(url).not.toBeNull();
    expect(url!.endsWith("&ok=requested-reset")).toBe(true);

    consoleWarnSpy.mockRestore();
  });
});
