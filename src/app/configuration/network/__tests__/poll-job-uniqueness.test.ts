// BullMQ jobId uniqueness assertions for registry polling.
//
// Subsequent reschedules from inside the active handler use a distinct attempt
// jobId per attempt to avoid BullMQ same-jobId-while-active silent drops in
// `bullmq` ^5.71.1. The initial enqueue from the request action uses the bare
// `registry-poll:{requestId}` pattern for single-in-flight semantics; tests for
// that initial-enqueue path live with the request action tests. For queue-level
// coverage, use an integration test against a live Redis instance.

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
    new Response(JSON.stringify(body), {
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
  vi.mocked(readRegistryCredential).mockResolvedValue("test-request-secret");
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Distinct-attempt jobId pattern
// ---------------------------------------------------------------------------

describe("REGISTRY_POLL — jobId pattern", () => {
  it("self-reschedule on 200 pending uses distinct attempt jobId 'registry-poll:{requestId}:{nextPollAtMs}'", async () => {
    setRemoteState();
    mockFetchOnce(200, { status: "pending", pollIntervalSeconds: 30 });
    await runRegistryPollJob({ requestId: "req-1" });
    const args = getLatestEnqueueArgs();
    expect(String(args[2]?.jobId)).toMatch(/^registry-poll:req-1:\d+$/);
    // NOT the bare initial-enqueue form.
    expect(String(args[2]?.jobId)).not.toBe("registry-poll:req-1");
  });

  it("self-reschedule on 429 rate_limited uses the same distinct-attempt jobId pattern", async () => {
    setRemoteState();
    mockFetchOnce(429, { error: { code: "rate_limited" } }, { "Retry-After": "60" });
    await runRegistryPollJob({ requestId: "req-1" });
    const args = getLatestEnqueueArgs();
    expect(String(args[2]?.jobId)).toMatch(/^registry-poll:req-1:\d+$/);
  });

  it("self-reschedule on 5xx uses the same distinct-attempt jobId pattern", async () => {
    setRemoteState();
    mockFetchOnce(503, {});
    await runRegistryPollJob({ requestId: "req-1" });
    const args = getLatestEnqueueArgs();
    expect(String(args[2]?.jobId)).toMatch(/^registry-poll:req-1:\d+$/);
  });

  it("consecutive reschedules within the same handler chain use DISTINCT jobIds", async () => {
    // First reschedule.
    setRemoteState();
    mockFetchOnce(200, { status: "pending", pollIntervalSeconds: 30 });
    await runRegistryPollJob({ requestId: "req-1" });
    const firstArgs = getLatestEnqueueArgs();
    const firstJobId = String(firstArgs[2]?.jobId);

    // Advance by a few ms to ensure Date.now() differs between calls.
    await new Promise((r) => setTimeout(r, 5));

    // Second reschedule.
    vi.mocked(enqueueBackgroundJob).mockClear();
    setRemoteState();
    mockFetchOnce(200, { status: "pending", pollIntervalSeconds: 30 });
    await runRegistryPollJob({ requestId: "req-1" });
    const secondArgs = getLatestEnqueueArgs();
    const secondJobId = String(secondArgs[2]?.jobId);

    expect(firstJobId).toMatch(/^registry-poll:req-1:\d+$/);
    expect(secondJobId).toMatch(/^registry-poll:req-1:\d+$/);
    expect(firstJobId).not.toEqual(secondJobId);
  });

  it("the payload of a self-reschedule includes the scheduledFor field", async () => {
    setRemoteState();
    mockFetchOnce(200, { status: "pending", pollIntervalSeconds: 30 });
    await runRegistryPollJob({ requestId: "req-1" });
    const args = getLatestEnqueueArgs();
    const payload = args[1] as { requestId: string; scheduledFor?: number };
    expect(typeof payload.scheduledFor).toBe("number");
    // payload.scheduledFor equals the trailing ms-epoch suffix on jobId.
    const jobIdSuffix = parseInt(String(args[2]?.jobId).split(":").pop()!, 10);
    expect(payload.scheduledFor).toBe(jobIdSuffix);
  });

  it("the persisted nextPollAt equals the most-recent reschedule payload's scheduledFor", async () => {
    setRemoteState();
    mockFetchOnce(200, { status: "pending", pollIntervalSeconds: 30 });
    await runRegistryPollJob({ requestId: "req-1" });

    const args = getLatestEnqueueArgs();
    const payload = args[1] as { requestId: string; scheduledFor?: number };

    const lastWrite = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0];
    const persistedNextPollAt = (lastWrite as InstanceIdentity).registries
      ?.remote?.nextPollAt;
    expect(persistedNextPollAt).toBeTruthy();
    expect(new Date(persistedNextPollAt as string).getTime()).toBe(
      payload.scheduledFor,
    );
  });

  it("stale-attempt guard exits without fetch or enqueue when payload.scheduledFor is older than persisted nextPollAt", async () => {
    const T = Date.now();
    // Persisted nextPollAt = T+60s; this attempt was scheduled for T+30s
    // (older) and should be considered stale.
    setRemoteState({
      nextPollAt: new Date(T + 60_000).toISOString(),
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await runRegistryPollJob({ requestId: "req-1", scheduledFor: T + 30_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
  });

  it("when remainingMs is negative or zero, no enqueue is called and status flips to expired", async () => {
    // Past expiresAt — the expiresAt-guard at the top of the handler catches
    // this and flips status to expired without entering reschedule().
    setRemoteState({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    mockFetchOnce(200, { status: "pending", pollIntervalSeconds: 30 });
    await runRegistryPollJob({ requestId: "req-1" });
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
    const lastWrite = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0];
    expect((lastWrite as InstanceIdentity).registries?.remote?.status).toBe(
      "expired",
    );
  });

  it("does NOT enqueue at all on terminal-state branches (denied/410-expired/410-consumed/404)", async () => {
    // denied
    setRemoteState();
    mockFetchOnce(200, { status: "denied", reason: "no" });
    await runRegistryPollJob({ requestId: "req-1" });
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalled();

    // 410 expired
    vi.clearAllMocks();
    vi.mocked(readRegistryCredential).mockResolvedValue("test-request-secret");
    setRemoteState();
    mockFetchOnce(410, { status: "expired" });
    await runRegistryPollJob({ requestId: "req-1" });
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();

    // 410 consumed
    vi.clearAllMocks();
    vi.mocked(readRegistryCredential).mockResolvedValue("test-request-secret");
    setRemoteState();
    mockFetchOnce(410, { status: "consumed" });
    await runRegistryPollJob({ requestId: "req-1" });
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();

    // 404 not_found
    vi.clearAllMocks();
    vi.mocked(readRegistryCredential).mockResolvedValue("test-request-secret");
    setRemoteState();
    mockFetchOnce(404, { error: { code: "not_found" } });
    await runRegistryPollJob({ requestId: "req-1" });
    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
  });
});
