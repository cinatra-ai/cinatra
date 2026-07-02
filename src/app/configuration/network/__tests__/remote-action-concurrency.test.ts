// Concurrency regression suite for the remote-registry network actions
// (cinatra#850).
//
// The teardown/transition actions (cancel/disconnect/reset) read the slot,
// perform a Nango side effect, then persist — a window in which the
// registry-poll worker or another operator tab can advance the `remote` slot.
// Each persist is now a row-level CAS whose mutation is STATE-AWARE: it only
// applies if the FRESHLY re-read slot is still the state the action captured
// (cancel: same pending requestId; disconnect: still connected; reset: still
// terminal). A stale teardown must never clobber a newer authoritative slot
// (a same-slot lost update). `requestRemoteAccessAction` additionally checks
// the CAS outcome so it never claims success when the pending row did not land.
//
// The delegating instance-identity-store mock re-reads the mocked identity,
// applies the caller's registries mutation, and persists via
// `writeInstanceIdentity`. Returning DIFFERENT identities from the action-top
// read vs. the CAS re-read is a deterministic interleaving harness for the
// snapshot->write race — no wall clock. The real CAS engine is unit-tested in
// `src/lib/__tests__/instance-identity-cas.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstanceIdentity, RemoteRegistryConnection } from "@/lib/instance-identity-store";

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({ user: { id: "user-1", email: "operator@example.com" } })),
  requireAuthSession: vi.fn(async () => ({ user: { id: "user-1", email: "operator@example.com" } })),
}));
vi.mock("@/lib/instance-identity-store", () => {
  const readInstanceIdentity = vi.fn();
  const writeInstanceIdentity = vi.fn();
  const updateInstanceIdentityRegistries = vi.fn(
    (mutate: (r: Record<string, unknown>) => Record<string, unknown>) => {
      const current = readInstanceIdentity() as
        | { registries?: Record<string, unknown> }
        | null
        | undefined;
      if (!current) return "no-identity";
      const nextRegistries = mutate(current.registries ?? {});
      writeInstanceIdentity({ ...current, registries: nextRegistries });
      return "swapped";
    },
  );
  return { readInstanceIdentity, writeInstanceIdentity, updateInstanceIdentityRegistries };
});
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

import {
  cancelRemoteRequestAction,
  disconnectRemoteRegistryAction,
  resetRemoteRegistryAction,
  requestRemoteAccessAction,
} from "@/app/configuration/network/actions";
import {
  readInstanceIdentity,
  writeInstanceIdentity,
  updateInstanceIdentityRegistries,
} from "@/lib/instance-identity-store";
import {
  deleteRegistryCredential,
  writeRegistryCredential,
} from "@/lib/registry-credentials";
import { enqueueBackgroundJob } from "@/lib/background-jobs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;
const LOCAL_SLOT = {
  url: "http://127.0.0.1:4873",
  tokenCiphertext: "local-ct",
  tokenIv: "local-iv",
  tokenAlgo: "aes-256-gcm",
  tokenUpdatedAt: null,
};

function identityWithRemote(over: Partial<RemoteRegistryConnection> & {
  status: RemoteRegistryConnection["status"];
}): InstanceIdentity {
  return {
    instanceNamespace: "test-ns",
    instanceDisplayName: "Test",
    registries: {
      local: { ...LOCAL_SLOT },
      remote: {
        url: "https://registry.example",
        namespace: "test-ns",
        ...over,
      } as RemoteRegistryConnection,
    },
  } as unknown as InstanceIdentity;
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

function lastWrittenRemote(): RemoteRegistryConnection | null | undefined {
  const calls = vi.mocked(writeInstanceIdentity).mock.calls;
  const last = calls.at(-1)?.[0];
  return (last as InstanceIdentity | undefined)?.registries?.remote;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(deleteRegistryCredential).mockResolvedValue(undefined);
  vi.mocked(writeRegistryCredential).mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// cancelRemoteRequestAction
// ---------------------------------------------------------------------------

describe("cancelRemoteRequestAction — state-aware", () => {
  it("resets a still-pending request to not_connected and preserves the sibling local slot", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(
      identityWithRemote({ status: "pending", requestId: "req-1" }),
    );

    const url = await captureRedirect(() => cancelRemoteRequestAction());

    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith("test-ns", "request-secret");
    expect(lastWrittenRemote()).toEqual({
      url: "https://registry.example",
      namespace: "test-ns",
      status: "not_connected",
    });
    expect((vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0] as InstanceIdentity)
      .registries?.local?.url).toBe("http://127.0.0.1:4873");
    expect(url!.includes("ok=cancelled")).toBe(true);
  });

  it("does NOT revert a request the worker advanced to connected in the race window", async () => {
    const pending = identityWithRemote({ status: "pending", requestId: "req-1" });
    const connected = identityWithRemote({
      status: "connected",
      requestId: "req-1",
      nangoCredentialRef: "cinatra-registry-token-test-ns",
    });
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(pending).mockReturnValue(connected);

    const url = await captureRedirect(() => cancelRemoteRequestAction());

    expect(lastWrittenRemote()?.status).toBe("connected");
    expect(lastWrittenRemote()?.status).not.toBe("not_connected");
    expect(url!.includes("ok=cancelled")).toBe(true);
  });

  it("does NOT cancel a DIFFERENT pending request that superseded the one it read", async () => {
    // Operator cancels req-1; between the guard read and the CAS write, req-1
    // was cancelled + a fresh req-2 requested. The stale cancel must not clobber
    // req-2.
    const pendingA = identityWithRemote({ status: "pending", requestId: "req-1" });
    const pendingB = identityWithRemote({ status: "pending", requestId: "req-2" });
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(pendingA).mockReturnValue(pendingB);

    await captureRedirect(() => cancelRemoteRequestAction());

    expect(lastWrittenRemote()?.status).toBe("pending");
    expect(lastWrittenRemote()?.requestId).toBe("req-2");
  });

  it("is an idempotent no-op when the request is not pending (no Nango delete, no write)", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(identityWithRemote({ status: "not_connected" }));

    const url = await captureRedirect(() => cancelRemoteRequestAction());

    expect(vi.mocked(deleteRegistryCredential)).not.toHaveBeenCalled();
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
    expect(url!.includes("ok=cancelled")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// disconnectRemoteRegistryAction
// ---------------------------------------------------------------------------

describe("disconnectRemoteRegistryAction — state-aware", () => {
  it("clears a still-connected slot to not_connected", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(
      identityWithRemote({
        status: "connected",
        requestId: "req-c1",
        nangoCredentialRef: "cinatra-registry-token-test-ns",
      }),
    );

    const url = await captureRedirect(() => disconnectRemoteRegistryAction());

    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith("test-ns", "token");
    expect(lastWrittenRemote()).toEqual({
      url: "https://registry.example",
      namespace: "test-ns",
      status: "not_connected",
    });
    expect(url!.includes("ok=remote-disconnected")).toBe(true);
  });

  it("does NOT clobber a fresh pending request that replaced the connected slot mid-teardown", async () => {
    const connected = identityWithRemote({ status: "connected", requestId: "req-c1" });
    const pendingB = identityWithRemote({ status: "pending", requestId: "req-2" });
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(connected).mockReturnValue(pendingB);

    await captureRedirect(() => disconnectRemoteRegistryAction());

    expect(lastWrittenRemote()?.status).toBe("pending");
    expect(lastWrittenRemote()?.requestId).toBe("req-2");
  });

  it("does NOT clobber a DIFFERENT connected request that replaced the one it read", async () => {
    const connectedA = identityWithRemote({ status: "connected", requestId: "req-c1" });
    const connectedB = identityWithRemote({ status: "connected", requestId: "req-c2" });
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(connectedA).mockReturnValue(connectedB);

    await captureRedirect(() => disconnectRemoteRegistryAction());

    expect(lastWrittenRemote()?.status).toBe("connected");
    expect(lastWrittenRemote()?.requestId).toBe("req-c2");
  });
});

// ---------------------------------------------------------------------------
// resetRemoteRegistryAction
// ---------------------------------------------------------------------------

describe("resetRemoteRegistryAction — state-aware", () => {
  it("resets a still-terminal slot to not_connected", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(
      identityWithRemote({ status: "error", requestId: "req-t1" }),
    );

    const url = await captureRedirect(() => resetRemoteRegistryAction());

    expect(lastWrittenRemote()).toEqual({
      url: "https://registry.example",
      namespace: "test-ns",
      status: "not_connected",
    });
    expect(url!.includes("ok=requested-reset")).toBe(true);
  });

  it("does NOT clobber a fresh pending request submitted while the reset was in flight", async () => {
    const terminal = identityWithRemote({ status: "denied", requestId: "req-t1" });
    const pendingB = identityWithRemote({ status: "pending", requestId: "req-2" });
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(terminal).mockReturnValue(pendingB);

    await captureRedirect(() => resetRemoteRegistryAction());

    expect(lastWrittenRemote()?.status).toBe("pending");
    expect(lastWrittenRemote()?.requestId).toBe("req-2");
  });

  it("does NOT clobber a DIFFERENT terminal request that replaced the one it read", async () => {
    const terminalA = identityWithRemote({ status: "error", requestId: "req-t1" });
    const terminalB = identityWithRemote({ status: "denied", requestId: "req-t2" });
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(terminalA).mockReturnValue(terminalB);

    await captureRedirect(() => resetRemoteRegistryAction());

    // The fresh terminal request is a different one — reset must not clear it.
    expect(lastWrittenRemote()?.status).toBe("denied");
    expect(lastWrittenRemote()?.requestId).toBe("req-t2");
  });
});

// ---------------------------------------------------------------------------
// requestRemoteAccessAction — CAS outcome handling
// ---------------------------------------------------------------------------

describe("requestRemoteAccessAction — pending-row persist failure", () => {
  function mockFetch201(): void {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          requestId: "req-1",
          requestSecret: "secret-xyz",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          pollIntervalSeconds: 30,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
  }

  it("rolls back the request-secret and errors (never ok=requested / never enqueues) when the CAS does not land", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(identityWithRemote({ status: "not_connected" }));
    mockFetch201();
    // Simulate sustained CAS contention: the single pending-row write does not
    // land. `Once` so the override cannot leak into sibling tests.
    vi.mocked(updateInstanceIdentityRegistries).mockReturnValueOnce("exhausted");

    const fd = new FormData();
    fd.append("contactEmail", "operator@example.com");
    const url = await captureRedirect(() => requestRemoteAccessAction(fd));

    // Nango secret written first, then rolled back because the row didn't persist.
    expect(vi.mocked(writeRegistryCredential)).toHaveBeenCalledWith("test-ns", "request-secret", "secret-xyz");
    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith("test-ns", "request-secret");
    // No poll enqueued for a request with no local row, and NOT ok=requested.
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
    expect(url).not.toBeNull();
    expect(url!.includes("ok=requested")).toBe(false);
    expect(url!.includes("error=")).toBe(true);
  });

  it("proceeds normally (enqueue + ok=requested) when the CAS lands", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(identityWithRemote({ status: "not_connected" }));
    mockFetch201();
    // default delegating mock returns "swapped"

    const fd = new FormData();
    fd.append("contactEmail", "operator@example.com");
    const url = await captureRedirect(() => requestRemoteAccessAction(fd));

    expect(vi.mocked(enqueueBackgroundJob)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteRegistryCredential)).not.toHaveBeenCalled();
    expect(url!.includes("ok=requested")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// teardown actions — CAS non-commit must NOT falsely report success (cinatra#850)
// ---------------------------------------------------------------------------
//
// Each teardown deletes an irreversible Nango credential BEFORE the slot CAS.
// If the CAS does not land (realistically only "exhausted" under sustained
// contention on the identity row), the DB slot stays connected/pending/terminal
// while the credential is gone — the action must surface an error instead of a
// misleading ok redirect (mirrors the request action's outcome handling above).

describe("teardown actions — CAS non-commit surfaces error", () => {
  it("cancel: errors (not ok=cancelled) when the slot reset does not commit", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(
      identityWithRemote({ status: "pending", requestId: "req-1" }),
    );
    vi.mocked(updateInstanceIdentityRegistries).mockReturnValueOnce("exhausted");

    const url = await captureRedirect(() => cancelRemoteRequestAction());

    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith("test-ns", "request-secret");
    expect(url).not.toBeNull();
    expect(url!.includes("ok=cancelled")).toBe(false);
    expect(url!.includes("error=")).toBe(true);
  });

  it("disconnect: errors (not ok=remote-disconnected) when the slot clear does not commit", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(
      identityWithRemote({
        status: "connected",
        requestId: "req-1",
        nangoCredentialRef: "cinatra-registry-token-test-ns",
      }),
    );
    vi.mocked(updateInstanceIdentityRegistries).mockReturnValueOnce("exhausted");

    const url = await captureRedirect(() => disconnectRemoteRegistryAction());

    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith("test-ns", "token");
    expect(url).not.toBeNull();
    expect(url!.includes("ok=remote-disconnected")).toBe(false);
    expect(url!.includes("error=")).toBe(true);
  });

  it("reset: errors (not ok=requested-reset) when the slot reset does not commit", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(
      identityWithRemote({ status: "denied", requestId: "req-1" }),
    );
    vi.mocked(updateInstanceIdentityRegistries).mockReturnValueOnce("exhausted");

    const url = await captureRedirect(() => resetRemoteRegistryAction());

    expect(url).not.toBeNull();
    expect(url!.includes("ok=requested-reset")).toBe(false);
    expect(url!.includes("error=")).toBe(true);
  });
});
