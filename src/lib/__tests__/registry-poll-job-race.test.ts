// Worker same-slot lost-update regression (cinatra#850).
//
// `runRegistryPollJob` reads the pending `remote` slot, awaits the registry
// fetch, then persists its transition. In that window the operator can cancel
// the request (slot -> not_connected) or cancel-and-re-request (slot -> a
// DIFFERENT pending request). The persist is a row-level CAS whose mutation is
// state-aware: it only applies if the freshly re-read slot is STILL the same
// in-flight request (matching `requestId`) AND still `pending`. Otherwise the
// poll becomes a no-op — it must NOT resurrect a cancelled request nor clobber a
// newer one.
//
// The delegating instance-identity-store mock re-reads the mocked identity and
// applies the caller's registries mutation. Returning DIFFERENT identities from
// the handler-top read vs. the CAS re-read is a deterministic interleaving
// harness — no wall clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstanceIdentity, RemoteRegistryConnection } from "@/lib/instance-identity-store";

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
vi.mock("@/lib/registry-credentials", () => ({
  readRegistryCredential: vi.fn(async () => "test-request-secret"),
  writeRegistryCredential: vi.fn(),
  deleteRegistryCredential: vi.fn(),
  getRegistryCredentialRef: vi.fn(
    (ns: string, kind: string, requestId: string) =>
      `cinatra-registry-${kind}-${ns}-${requestId}`,
  ),
}));
vi.mock("@/lib/redact-sensitive", () => ({
  redactSensitive: vi.fn((v: unknown) => v),
}));
vi.mock("@/lib/background-jobs", () => ({
  BACKGROUND_JOB_NAMES: { REGISTRY_POLL: "registry-poll" },
  enqueueBackgroundJob: vi.fn(async () => undefined),
}));

import { runRegistryPollJob } from "@/lib/registry-poll-job";
import {
  readInstanceIdentity,
  writeInstanceIdentity,
} from "@/lib/instance-identity-store";
import {
  readRegistryCredential,
  writeRegistryCredential,
  deleteRegistryCredential,
} from "@/lib/registry-credentials";

const ORIGINAL_FETCH = globalThis.fetch;

function pendingIdentity(requestId: string): InstanceIdentity {
  return {
    instanceNamespace: "test-ns",
    registries: {
      local: {
        url: "http://127.0.0.1:4873",
        tokenCiphertext: "ct",
        tokenIv: "iv",
        tokenAlgo: "aes-256-gcm",
        tokenUpdatedAt: null,
      },
      remote: {
        url: "https://registry.example.com",
        namespace: "test-ns",
        requestId,
        status: "pending",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
    },
  } as unknown as InstanceIdentity;
}

function notConnectedIdentity(): InstanceIdentity {
  return {
    instanceNamespace: "test-ns",
    registries: {
      local: {
        url: "http://127.0.0.1:4873",
        tokenCiphertext: "ct",
        tokenIv: "iv",
        tokenAlgo: "aes-256-gcm",
        tokenUpdatedAt: null,
      },
      remote: { url: "https://registry.example.com", namespace: "test-ns", status: "not_connected" },
    },
  } as unknown as InstanceIdentity;
}

function connectedIdentity(requestId: string): InstanceIdentity {
  return {
    instanceNamespace: "test-ns",
    registries: {
      local: {
        url: "http://127.0.0.1:4873",
        tokenCiphertext: "ct",
        tokenIv: "iv",
        tokenAlgo: "aes-256-gcm",
        tokenUpdatedAt: null,
      },
      remote: {
        url: "https://registry.example.com",
        namespace: "test-ns",
        requestId,
        status: "connected",
        nangoCredentialRef: `cinatra-registry-token-test-ns-${requestId}`,
      },
    },
  } as unknown as InstanceIdentity;
}

function mockFetch200Pending(): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ status: "pending", pollIntervalSeconds: 30 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function mockFetch200Approved(token: string): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ status: "approved", token }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function lastWrittenRemote(): RemoteRegistryConnection | null | undefined {
  const last = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0];
  return (last as InstanceIdentity | undefined)?.registries?.remote;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readRegistryCredential).mockResolvedValue("test-request-secret");
  vi.mocked(writeRegistryCredential).mockResolvedValue(undefined);
  vi.mocked(deleteRegistryCredential).mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("runRegistryPollJob — same-slot lost update (cinatra#850)", () => {
  it("does NOT resurrect a request the operator cancelled (slot -> not_connected) mid-poll", async () => {
    // Handler-top read sees pending req-1 (guards pass); the CAS re-read sees the
    // operator's not_connected write. The poll's pending-reschedule persist must
    // become a no-op — the cancelled slot stays not_connected.
    vi.mocked(readInstanceIdentity)
      .mockReturnValueOnce(pendingIdentity("req-1"))
      .mockReturnValue(notConnectedIdentity());
    mockFetch200Pending();

    await runRegistryPollJob({ requestId: "req-1" });

    expect(lastWrittenRemote()?.status).toBe("not_connected");
    expect(lastWrittenRemote()?.status).not.toBe("pending");
  });

  it("does NOT clobber a DIFFERENT pending request that superseded the one it polled", async () => {
    // Handler-top read sees pending req-1; the CAS re-read sees a fresh pending
    // req-2 (operator cancelled req-1 and re-requested). The poll must not
    // overwrite req-2 with req-1's polled state.
    vi.mocked(readInstanceIdentity)
      .mockReturnValueOnce(pendingIdentity("req-1"))
      .mockReturnValue(pendingIdentity("req-2"));
    mockFetch200Pending();

    await runRegistryPollJob({ requestId: "req-1" });

    expect(lastWrittenRemote()?.status).toBe("pending");
    expect(lastWrittenRemote()?.requestId).toBe("req-2");
  });

  it("applies the transition normally when the slot is unchanged (same requestId, still pending)", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(pendingIdentity("req-1"));
    mockFetch200Pending();

    await runRegistryPollJob({ requestId: "req-1" });

    // The reschedule persist landed: still pending req-1, with a fresh nextPollAt.
    expect(lastWrittenRemote()?.status).toBe("pending");
    expect(lastWrittenRemote()?.requestId).toBe("req-1");
    expect(lastWrittenRemote()?.nextPollAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Approved-in-the-cancel-window orphaned-token cleanup (cinatra#899)
// ---------------------------------------------------------------------------
//
// The approved branch writes the npm `token` to Nango BEFORE it persists the
// `connected` transition. If the operator cancelled (slot -> not_connected) or
// superseded the request (slot -> a DIFFERENT pending req-2) in the window
// between the approval fetch and the persist, the #850 row guard correctly
// SKIPS the connected write — but the token just written would be orphaned in
// Nango. The handler now detects that no-op (the connected state did not apply
// AND the slot no longer carries THIS request) and deletes the orphaned token.
// Request-scoped keying (this file's mock returns `...-{requestId}`) guarantees
// that delete only ever removes THIS request's token. The single exception is a
// SIBLING poller that already connected the SAME request — that token is LIVE
// and must be kept.
const TOKEN_CANARY = "npm-token-orphan-canary-abc123";

describe("runRegistryPollJob — approved-window orphaned-token cleanup (cinatra#899)", () => {
  it("deletes the just-written token when the operator cancelled (slot -> not_connected) in the approval window", async () => {
    vi.mocked(readInstanceIdentity)
      .mockReturnValueOnce(pendingIdentity("req-1"))
      .mockReturnValue(notConnectedIdentity());
    mockFetch200Approved(TOKEN_CANARY);

    await runRegistryPollJob({ requestId: "req-1" });

    // Token was written request-scoped for req-1 ...
    expect(vi.mocked(writeRegistryCredential)).toHaveBeenCalledWith(
      "test-ns",
      "token",
      "req-1",
      TOKEN_CANARY,
    );
    // ... then reclaimed as an orphan because the connected persist no-op'd.
    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith(
      "test-ns",
      "token",
      "req-1",
    );
    // The cancelled slot is NOT resurrected to connected.
    expect(lastWrittenRemote()?.status).toBe("not_connected");
  });

  it("deletes ONLY req-1's token (never req-2's) when a fresh request superseded it — fail-closed cross-request", async () => {
    vi.mocked(readInstanceIdentity)
      .mockReturnValueOnce(pendingIdentity("req-1"))
      .mockReturnValue(pendingIdentity("req-2"));
    mockFetch200Approved(TOKEN_CANARY);

    await runRegistryPollJob({ requestId: "req-1" });

    // The orphan delete targets req-1's request-scoped token key ...
    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith(
      "test-ns",
      "token",
      "req-1",
    );
    // ... and NEVER req-2's — a stale approval cannot strip the live request's
    // credential (the whole point of request-scoping).
    expect(vi.mocked(deleteRegistryCredential)).not.toHaveBeenCalledWith(
      "test-ns",
      "token",
      "req-2",
    );
    // req-2 is left untouched in the slot.
    expect(lastWrittenRemote()?.status).toBe("pending");
    expect(lastWrittenRemote()?.requestId).toBe("req-2");
  });

  it("does NOT delete the token when a SIBLING poll already connected the SAME request (token is live)", async () => {
    // Handler-top read sees pending req-1; by the connected-persist CAS re-read a
    // sibling poll (e.g. the manual "Refresh status" action racing this BullMQ
    // tick) has already flipped the SAME req-1 to connected. `applied` is false
    // but the slot still carries req-1, so the token is LIVE — it must be kept.
    vi.mocked(readInstanceIdentity)
      .mockReturnValueOnce(pendingIdentity("req-1"))
      .mockReturnValue(connectedIdentity("req-1"));
    mockFetch200Approved(TOKEN_CANARY);

    await runRegistryPollJob({ requestId: "req-1" });

    // The token write is idempotent (same key, same value) ...
    expect(vi.mocked(writeRegistryCredential)).toHaveBeenCalledWith(
      "test-ns",
      "token",
      "req-1",
      TOKEN_CANARY,
    );
    // ... but the LIVE token is NEVER deleted.
    expect(vi.mocked(deleteRegistryCredential)).not.toHaveBeenCalledWith(
      "test-ns",
      "token",
      "req-1",
    );
    // The connected req-1 slot stands.
    expect(lastWrittenRemote()?.status).toBe("connected");
    expect(lastWrittenRemote()?.requestId).toBe("req-1");
  });

  it("keeps the token and does not orphan-delete on a clean single-poll connect", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(pendingIdentity("req-1"));
    mockFetch200Approved(TOKEN_CANARY);

    await runRegistryPollJob({ requestId: "req-1" });

    // Normal connect: token stays, only the request-secret is consumed.
    expect(vi.mocked(deleteRegistryCredential)).not.toHaveBeenCalledWith(
      "test-ns",
      "token",
      "req-1",
    );
    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith(
      "test-ns",
      "request-secret",
      "req-1",
    );
    expect(lastWrittenRemote()?.status).toBe("connected");
    expect(lastWrittenRemote()?.requestId).toBe("req-1");
  });

  it("defensively logs (never crashes the one-shot job) if the orphan-token delete unexpectedly throws", async () => {
    // The credential helper is designed NOT to throw (it swallows-and-logs real
    // Nango failures), but the handler's orphan-cleanup `.catch` is defense-in-
    // depth: even if a delete unexpectedly rejects, the one-shot poll job must not
    // crash — it logs and moves on. Here the mocked helper throws to exercise that
    // guard.
    vi.mocked(readInstanceIdentity)
      .mockReturnValueOnce(pendingIdentity("req-1"))
      .mockReturnValue(notConnectedIdentity());
    mockFetch200Approved(TOKEN_CANARY);
    // request-secret delete resolves; the token (orphan) delete rejects.
    vi.mocked(deleteRegistryCredential).mockImplementation(async (_ns, kind) => {
      if (kind === "token") throw new Error("nango delete 503");
      return undefined;
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Must resolve (not reject) — the one-shot job survives.
    await expect(runRegistryPollJob({ requestId: "req-1" })).resolves.toBeUndefined();

    const warned = warnSpy.mock.calls
      .flatMap((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))))
      .join("\n");
    expect(warned).toContain("[registry-poll] orphan-token-cleanup-failed");
    // The canary token never appears in a log line.
    expect(warned).not.toContain(TOKEN_CANARY);
    warnSpy.mockRestore();
  });
});
