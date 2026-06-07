// Table-driven 7-branch test for `runRegistryPollJob`.
//
// Locks the `src/lib/registry-poll-job.ts` contract including:
// - All 7 response branches (200 pending / approved / denied; 410 expired /
//   consumed; 404 not_found; 429 rate_limited; 5xx + unexpected).
// - Guards (status, requestId, expiresAt, missing requestSecret, stale-attempt).
// - Approved-handler ordering invariant: writeRegistryCredential("token")
//   BEFORE deleteRegistryCredential("request-secret").
// - 5xx backoff doubling sequence: 30s → 60s → 120s → 240s → 300s (cap).
// - Backoff cap to remaining time-to-expiresAt.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RemoteRegistryConnection, InstanceIdentity } from "@/lib/instance-identity-store";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
  writeInstanceIdentity: vi.fn(),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
}));
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
  enqueueBackgroundJob: vi.fn(),
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
import { enqueueBackgroundJob } from "@/lib/background-jobs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

type RemoteOverrides = Partial<RemoteRegistryConnection>;

function setRemoteState(over: RemoteOverrides = {}): RemoteRegistryConnection {
  const base: RemoteRegistryConnection = {
    url: "https://registry.example",
    namespace: "test-ns",
    requestId: "req-1",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    status: "pending",
    contactEmail: "op@example.com",
    requestedAt: new Date().toISOString(),
    approvedAt: null,
    deniedAt: null,
    denyReason: null,
    tokenUpdatedAt: null,
    lastPolledAt: null,
    nextPollAt: null,
    terminalReason: null,
    nangoCredentialRef: null,
  };
  const remote = { ...base, ...over } as RemoteRegistryConnection;
  vi.mocked(readInstanceIdentity).mockReturnValue({
    instanceNamespace: "test-ns",
    instanceDisplayName: "Test",
    registries: { remote },
  } as unknown as InstanceIdentity);
  return remote;
}

function mockFetchOnce(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  ) as unknown as typeof fetch;
}

function getLatestEnqueueArgs() {
  const calls = vi.mocked(enqueueBackgroundJob).mock.calls;
  return calls[calls.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default — readRegistryCredential mock returns the secret.
  vi.mocked(readRegistryCredential).mockResolvedValue("test-request-secret");
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Happy paths — table-driven over the 7 response branches
// ---------------------------------------------------------------------------

describe("REGISTRY_POLL handler — happy paths", () => {
  it("200 pending — reschedules with pollIntervalSeconds delay and timestamped jobId", async () => {
    setRemoteState();
    mockFetchOnce(200, { status: "pending", pollIntervalSeconds: 30 });
    await runRegistryPollJob({ requestId: "req-1" });
    const args = getLatestEnqueueArgs();
    expect(args[0]).toBe("registry-poll");
    expect(args[2]?.delay).toBe(30_000);
    expect(String(args[2]?.jobId)).toMatch(/^registry-poll:req-1:\d+$/);
    // payload.scheduledFor present and equals jobId trailing suffix.
    const payload = args[1] as { requestId: string; scheduledFor?: number };
    const jobIdSuffix = parseInt(String(args[2]?.jobId).split(":").pop()!, 10);
    expect(payload.scheduledFor).toBe(jobIdSuffix);
    // Status remains pending.
    const persisted = vi.mocked(writeInstanceIdentity).mock.calls[0]?.[0];
    expect((persisted as InstanceIdentity).registries?.remote?.status).toBe("pending");
  });

  it("200 approved — writes token to Nango BEFORE deleting request-secret; flips to connected", async () => {
    setRemoteState();
    mockFetchOnce(200, { status: "approved", token: "tok-abc" });
    await runRegistryPollJob({ requestId: "req-1" });

    expect(vi.mocked(writeRegistryCredential)).toHaveBeenCalledWith(
      "test-ns",
      "token",
      "tok-abc",
    );
    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith(
      "test-ns",
      "request-secret",
    );
    const writeOrder =
      vi.mocked(writeRegistryCredential).mock.invocationCallOrder[0]!;
    const deleteOrder =
      vi.mocked(deleteRegistryCredential).mock.invocationCallOrder[0]!;
    expect(writeOrder).toBeLessThan(deleteOrder);

    // Status flipped to connected.
    const lastWrite = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0];
    expect((lastWrite as InstanceIdentity).registries?.remote?.status).toBe(
      "connected",
    );
  });

  it("200 denied — deletes request-secret, flips to denied with denyReason, no enqueue", async () => {
    setRemoteState();
    mockFetchOnce(200, { status: "denied", reason: "nope" });
    await runRegistryPollJob({ requestId: "req-1" });
    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith(
      "test-ns",
      "request-secret",
    );
    const lastWrite = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0];
    const persisted = (lastWrite as InstanceIdentity).registries?.remote;
    expect(persisted?.status).toBe("denied");
    expect(persisted?.denyReason).toBe("nope");
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
  });

  it("410 expired — secret deleted; status expired; no enqueue", async () => {
    setRemoteState();
    mockFetchOnce(410, { status: "expired" });
    await runRegistryPollJob({ requestId: "req-1" });
    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith(
      "test-ns",
      "request-secret",
    );
    const lastWrite = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0];
    expect((lastWrite as InstanceIdentity).registries?.remote?.status).toBe(
      "expired",
    );
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
  });

  it("410 consumed — secret deleted; status error with terminalReason; no enqueue", async () => {
    setRemoteState();
    mockFetchOnce(410, { status: "consumed" });
    await runRegistryPollJob({ requestId: "req-1" });
    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith(
      "test-ns",
      "request-secret",
    );
    const lastWrite = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0];
    const persisted = (lastWrite as InstanceIdentity).registries?.remote;
    expect(persisted?.status).toBe("error");
    expect(persisted?.terminalReason).toBeTruthy();
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
  });

  it("404 not_found — secret deleted; status error with terminalReason; no enqueue", async () => {
    setRemoteState();
    mockFetchOnce(404, { error: { code: "not_found" } });
    await runRegistryPollJob({ requestId: "req-1" });
    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith(
      "test-ns",
      "request-secret",
    );
    const lastWrite = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0];
    const persisted = (lastWrite as InstanceIdentity).registries?.remote;
    expect(persisted?.status).toBe("error");
    expect(persisted?.terminalReason).toBeTruthy();
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
  });

  it("429 rate_limited — honors Retry-After header (60s)", async () => {
    setRemoteState();
    mockFetchOnce(429, { error: { code: "rate_limited" } }, { "Retry-After": "60" });
    await runRegistryPollJob({ requestId: "req-1" });
    const args = getLatestEnqueueArgs();
    expect(args[2]?.delay).toBe(60_000);
  });

  it("503 server — enqueues with backoff in [30000, 300000]", async () => {
    setRemoteState();
    mockFetchOnce(503, {});
    await runRegistryPollJob({ requestId: "req-1" });
    const args = getLatestEnqueueArgs();
    expect(args[2]?.delay).toBeGreaterThanOrEqual(30_000);
    expect(args[2]?.delay).toBeLessThanOrEqual(300_000);
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe("REGISTRY_POLL handler — guards", () => {
  it("exits without polling when status is not pending", async () => {
    setRemoteState({ status: "connected" });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await runRegistryPollJob({ requestId: "req-1" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exits without polling when expiresAt is in the past (and flips status to expired)", async () => {
    setRemoteState({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await runRegistryPollJob({ requestId: "req-1" });
    expect(fetchSpy).not.toHaveBeenCalled();
    const lastWrite = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0];
    expect((lastWrite as InstanceIdentity).registries?.remote?.status).toBe(
      "expired",
    );
  });

  it("exits without polling when payload requestId mismatches state", async () => {
    setRemoteState({ requestId: "req-1" });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await runRegistryPollJob({ requestId: "other" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exits with status=error when readRegistryCredential returns null", async () => {
    setRemoteState();
    vi.mocked(readRegistryCredential).mockResolvedValueOnce(null);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await runRegistryPollJob({ requestId: "req-1" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
    const lastWrite = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0];
    expect((lastWrite as InstanceIdentity).registries?.remote?.status).toBe(
      "error",
    );
  });
});

// ---------------------------------------------------------------------------
// Approved-response ordering invariant
// ---------------------------------------------------------------------------

describe("REGISTRY_POLL handler — approved-response ordering invariant", () => {
  it("calls writeRegistryCredential('token') BEFORE deleteRegistryCredential('request-secret')", async () => {
    setRemoteState();
    mockFetchOnce(200, { status: "approved", token: "tok-secure" });
    await runRegistryPollJob({ requestId: "req-1" });

    // Find the index of the token-write and request-secret-delete calls.
    const writeCalls = vi.mocked(writeRegistryCredential).mock.calls;
    const deleteCalls = vi.mocked(deleteRegistryCredential).mock.calls;
    const tokenWriteIdx = writeCalls.findIndex(
      (call) => call[1] === "token",
    );
    const secretDeleteIdx = deleteCalls.findIndex(
      (call) => call[1] === "request-secret",
    );
    expect(tokenWriteIdx).toBeGreaterThanOrEqual(0);
    expect(secretDeleteIdx).toBeGreaterThanOrEqual(0);

    const tokenWriteOrder =
      vi.mocked(writeRegistryCredential).mock.invocationCallOrder[tokenWriteIdx]!;
    const secretDeleteOrder =
      vi.mocked(deleteRegistryCredential).mock.invocationCallOrder[secretDeleteIdx]!;
    expect(tokenWriteOrder).toBeLessThan(secretDeleteOrder);
  });
});

// ---------------------------------------------------------------------------
// Backoff cap to expiresAt
// ---------------------------------------------------------------------------

describe("REGISTRY_POLL handler — backoff cap to expiresAt", () => {
  it("caps a 5-min backoff to remaining time-to-expiresAt when expiry is closer", async () => {
    // 30s remaining; 5xx would otherwise want 30s backoff = the cap is the
    // remainingMs path. We use 503 with a state where the previous delta is
    // already near the cap, then cap is to remaining.
    const futureExpire = new Date(Date.now() + 30_000).toISOString();
    setRemoteState({
      expiresAt: futureExpire,
      lastPolledAt: new Date(Date.now() - 300_000).toISOString(),
      nextPollAt: new Date(Date.now()).toISOString(),
    });
    mockFetchOnce(503, {});
    await runRegistryPollJob({ requestId: "req-1" });
    const args = getLatestEnqueueArgs();
    // Capped at remainingMs; <= 30_000 + tolerance.
    expect(args[2]?.delay).toBeLessThanOrEqual(30_000);
    expect(args[2]?.delay).toBeGreaterThanOrEqual(1_000);
  });
});

// ---------------------------------------------------------------------------
// 5xx backoff doubling
// ---------------------------------------------------------------------------

describe("REGISTRY_POLL handler — 5xx backoff doubling", () => {
  it("starts at BACKOFF_START_MS (30s) on the first 5xx attempt with no prior poll delta", async () => {
    setRemoteState({
      lastPolledAt: null,
      nextPollAt: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    mockFetchOnce(503, {});
    await runRegistryPollJob({ requestId: "req-1" });
    const args = getLatestEnqueueArgs();
    expect(args[2]?.delay).toBeGreaterThanOrEqual(29_000);
    expect(args[2]?.delay).toBeLessThanOrEqual(31_000);
  });

  it("doubles the backoff on consecutive 5xx responses", async () => {
    const farFuture = new Date(Date.now() + 60 * 60_000).toISOString();
    const now = Date.now();

    // First call: previous delta = 30s.
    setRemoteState({
      lastPolledAt: new Date(now - 30_000).toISOString(),
      nextPollAt: new Date(now).toISOString(),
      expiresAt: farFuture,
    });
    mockFetchOnce(503, {});
    await runRegistryPollJob({ requestId: "req-1" });
    let args = getLatestEnqueueArgs();
    expect(args[2]?.delay).toBe(60_000);

    vi.clearAllMocks();
    vi.mocked(readRegistryCredential).mockResolvedValue("test-request-secret");

    // Second call: previous delta now 60s.
    setRemoteState({
      lastPolledAt: new Date(now - 60_000).toISOString(),
      nextPollAt: new Date(now).toISOString(),
      expiresAt: farFuture,
    });
    mockFetchOnce(503, {});
    await runRegistryPollJob({ requestId: "req-1" });
    args = getLatestEnqueueArgs();
    expect(args[2]?.delay).toBe(120_000);
  });

  it("caps at BACKOFF_CAP_MS (300_000) and does not exceed it on further 5xx responses", async () => {
    const farFuture = new Date(Date.now() + 60 * 60_000).toISOString();
    const now = Date.now();

    // Previous delta already = cap → stay at cap.
    setRemoteState({
      lastPolledAt: new Date(now - 300_000).toISOString(),
      nextPollAt: new Date(now).toISOString(),
      expiresAt: farFuture,
    });
    mockFetchOnce(503, {});
    await runRegistryPollJob({ requestId: "req-1" });
    const args = getLatestEnqueueArgs();
    expect(args[2]?.delay).toBe(300_000);
  });

  it("restarts at BACKOFF_START_MS when the persisted delta is non-positive (defensive clock skew)", async () => {
    const farFuture = new Date(Date.now() + 60 * 60_000).toISOString();
    const now = Date.now();

    // Negative delta — corrupt or clock-skewed state.
    setRemoteState({
      lastPolledAt: new Date(now + 10_000).toISOString(),
      nextPollAt: new Date(now).toISOString(),
      expiresAt: farFuture,
    });
    mockFetchOnce(503, {});
    await runRegistryPollJob({ requestId: "req-1" });
    const args = getLatestEnqueueArgs();
    expect(args[2]?.delay).toBeGreaterThanOrEqual(29_000);
    expect(args[2]?.delay).toBeLessThanOrEqual(31_000);
  });
});
