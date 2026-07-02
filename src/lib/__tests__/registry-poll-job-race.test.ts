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
    (ns: string, kind: string) => `cinatra-registry-${kind}-${ns}`,
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
import { readRegistryCredential } from "@/lib/registry-credentials";

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

function mockFetch200Pending(): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ status: "pending", pollIntervalSeconds: 30 }), {
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
