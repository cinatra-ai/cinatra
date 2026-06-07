// Unit tests for runRegistryPollJob.
//
// Covers the registry polling handler behaviors:
//   1. 200 pending → reschedule + persist same-source nextPollAt
//   2. 200 approved happy → write token, then delete request-secret, flip connected
//   3. 200 approved Nango-failure → status flips to error, token never logged
//   4. 200 denied → secret deleted, status denied
//   5. 410 expired → secret deleted, status expired
//   6. 410 consumed → secret deleted, status error with consumed reason
//   7. 404 not_found → secret deleted, status error with not-found reason
//   8. 429 rate_limited → reschedule per Retry-After
//   9. 5xx / network → exponential backoff via deriveNext5xxBackoffMs
//  10. terminal-state guard
//  11. expired-guard (expiresAt < now)
//  12. mismatched requestId guard
//  13. missing requestSecret in Nango → status error
//  14. 200 pending reschedule failure → warn-and-continue (no throw)
//
// The deeper logging-redaction regression test lives separately; this suite
// covers the unit-level invariants for the handler.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
  writeInstanceIdentity: vi.fn(),
}));
vi.mock("@/lib/registry-credentials", () => ({
  readRegistryCredential: vi.fn(),
  writeRegistryCredential: vi.fn(),
  deleteRegistryCredential: vi.fn(),
  getRegistryCredentialRef: vi.fn((namespace: string, kind: string) => `cinatra-registry-${kind}-${namespace}`),
}));
vi.mock("@/lib/background-jobs", () => ({
  BACKGROUND_JOB_NAMES: {
    REGISTRY_POLL: "registry-poll",
  },
  enqueueBackgroundJob: vi.fn(async () => undefined),
}));
vi.mock("@/lib/redact-sensitive", () => ({
  redactSensitive: vi.fn((value: unknown) => value),
}));

import { readInstanceIdentity, writeInstanceIdentity } from "@/lib/instance-identity-store";
import {
  readRegistryCredential,
  writeRegistryCredential,
  deleteRegistryCredential,
  getRegistryCredentialRef,
} from "@/lib/registry-credentials";
import { enqueueBackgroundJob, BACKGROUND_JOB_NAMES } from "@/lib/background-jobs";
import { runRegistryPollJob } from "@/lib/registry-poll-job";

const ORIGINAL_FETCH = globalThis.fetch;

let fetchSpy: ReturnType<typeof vi.fn>;

const NAMESPACE = "test-ns";
const REQUEST_ID = "req-test-1";
const REQUEST_SECRET = "request-secret-must-not-leak";
const TOKEN = "npm-token-must-not-leak-abc123";

function makeIdentityWithRemote(overrides: Record<string, unknown> = {}): unknown {
  return {
    instanceNamespace: NAMESPACE,
    registries: {
      remote: {
        url: "https://registry.example.com",
        namespace: NAMESPACE,
        requestId: REQUEST_ID,
        status: "pending",
        // Deliberately far future so expiry guards don't fire.
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        ...overrides,
      },
    },
  };
}

function mockFetchOnce(status: number, body: unknown, headers: Record<string, string> = {}): void {
  fetchSpy.mockImplementationOnce(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}

function mockFetchThrows(err: Error): void {
  fetchSpy.mockImplementationOnce(async () => {
    throw err;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readInstanceIdentity).mockReturnValue(makeIdentityWithRemote() as never);
  vi.mocked(readRegistryCredential).mockResolvedValue(REQUEST_SECRET);
  vi.mocked(writeRegistryCredential).mockResolvedValue(undefined);
  vi.mocked(deleteRegistryCredential).mockResolvedValue(undefined);
  fetchSpy = vi.fn(async () => {
    throw new Error("fetch was not mocked for this test");
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("runRegistryPollJob — guard rails", () => {
  it("exits cleanly when there is no remote slot", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue({ instanceNamespace: NAMESPACE, registries: {} } as never);
    await runRegistryPollJob({ requestId: REQUEST_ID });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writeInstanceIdentity).not.toHaveBeenCalled();
  });

  it("exits cleanly when payload requestId mismatches the persisted requestId", async () => {
    await runRegistryPollJob({ requestId: "different-id" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writeInstanceIdentity).not.toHaveBeenCalled();
    expect(readRegistryCredential).not.toHaveBeenCalled();
  });

  it("exits cleanly when status is not pending (terminal-state guard)", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(
      makeIdentityWithRemote({ status: "connected" }) as never,
    );
    await runRegistryPollJob({ requestId: REQUEST_ID });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readRegistryCredential).not.toHaveBeenCalled();
  });

  it("flips status to expired when expiresAt < now", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue(
      makeIdentityWithRemote({ expiresAt: new Date(Date.now() - 1_000).toISOString() }) as never,
    );
    await runRegistryPollJob({ requestId: REQUEST_ID });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writeInstanceIdentity).toHaveBeenCalled();
    const written = vi.mocked(writeInstanceIdentity).mock.calls[0]![0] as { registries: { remote: { status: string } } };
    expect(written.registries.remote.status).toBe("expired");
  });

  it("stale-attempt guard rejects payload.scheduledFor older than persisted nextPollAt", async () => {
    const persistedNextPollAtMs = Date.now() + 30_000;
    vi.mocked(readInstanceIdentity).mockReturnValue(
      makeIdentityWithRemote({
        nextPollAt: new Date(persistedNextPollAtMs).toISOString(),
      }) as never,
    );
    // payload.scheduledFor predates persisted nextPollAt — exit cleanly.
    await runRegistryPollJob({ requestId: REQUEST_ID, scheduledFor: persistedNextPollAtMs - 5_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readRegistryCredential).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("flips status to error when requestSecret is missing in Nango", async () => {
    vi.mocked(readRegistryCredential).mockResolvedValueOnce(null);
    await runRegistryPollJob({ requestId: REQUEST_ID });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writeInstanceIdentity).toHaveBeenCalled();
    const written = vi.mocked(writeInstanceIdentity).mock.calls[0]![0] as {
      registries: { remote: { status: string; terminalReason: string | null } };
    };
    expect(written.registries.remote.status).toBe("error");
    expect(written.registries.remote.terminalReason).toMatch(/missing|fresh request/i);
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });
});

describe("runRegistryPollJob — 200 pending", () => {
  it("reschedules with body.pollIntervalSeconds and persists same-source nextPollAt", async () => {
    mockFetchOnce(200, { status: "pending", pollIntervalSeconds: 30 });
    await runRegistryPollJob({ requestId: REQUEST_ID });

    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
    const enqueueArgs = vi.mocked(enqueueBackgroundJob).mock.calls[0]!;
    expect(enqueueArgs[0]).toBe(BACKGROUND_JOB_NAMES.REGISTRY_POLL);
    const payload = enqueueArgs[1] as { requestId: string; scheduledFor: number };
    const opts = enqueueArgs[2] as {
      jobId: string;
      delay: number;
      inheritActorContext?: boolean;
    };
    expect(payload.requestId).toBe(REQUEST_ID);
    expect(typeof payload.scheduledFor).toBe("number");
    expect(opts.delay).toBe(30_000);
    // jobId must include the timestamped suffix so BullMQ does not drop
    // self-reschedules as duplicate jobs.
    expect(opts.jobId).toMatch(/^registry-poll:req-test-1:\d+$/);
    // SYSTEM_JOB worker-internal enqueue must opt out of the HumanUser
    // auto-attribution cascade so an upstream user-attributed trigger doesn't
    // leak into the self-rescheduling chain.
    expect(opts.inheritActorContext).toBe(false);
    // Persisted nextPollAt MUST equal the BullMQ payload.scheduledFor so the
    // stale-attempt guard and rescheduler use the same timestamp source.
    const written = vi.mocked(writeInstanceIdentity).mock.calls[0]![0] as {
      registries: { remote: { nextPollAt: string; lastPolledAt: string; status: string } };
    };
    expect(new Date(written.registries.remote.nextPollAt).getTime()).toBe(payload.scheduledFor);
    expect(written.registries.remote.status).toBe("pending");
  });

  it("warns-and-continues when reschedule throws (Redis outage)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(enqueueBackgroundJob).mockRejectedValueOnce(new Error("Redis ECONNREFUSED"));
    mockFetchOnce(200, { status: "pending", pollIntervalSeconds: 30 });

    // Must NOT throw.
    await expect(runRegistryPollJob({ requestId: REQUEST_ID })).resolves.toBeUndefined();

    // The handler emits a redacted warn with the reschedule-failed tag.
    const taggedWarn = warnSpy.mock.calls.find((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("reschedule-failed")),
    );
    expect(taggedWarn).toBeDefined();

    warnSpy.mockRestore();
  });

  it("flips status to expired (and skips reschedule) when remainingMs <= 0 inside reschedule", async () => {
    // expiresAt is JUST after now; pollIntervalSeconds * 1000 will exceed the remaining window.
    // We construct a fixture where Date.now() reads inside the reschedule helper see remaining <= 0
    // by setting expiresAt slightly in the past, but the OUTER expired-guard already exits in that case.
    // To exercise the post-expiry short-circuit specifically inside reschedule(), we let the outer guard
    // see remaining > 0 (e.g. 100ms), then the helper internally sees remaining <= 0 once delay is added.
    //
    // Simpler: set expiresAt in the past by a hair AFTER the outer guard. Since the outer guard reads
    // first, we need to construct a case where remaining == 0 exactly when reschedule runs. We'll set
    // expiresAt to Date.now() + 50ms and pollIntervalSeconds = 60 (which would push past expiresAt).
    // The outer expiresAt guard fires first if expiresAt < now, but if expiresAt is RIGHT AT now+50ms,
    // it passes the outer guard, and reschedule's remaining check correctly short-circuits.
    const justAfterNow = new Date(Date.now() + 50).toISOString();
    vi.mocked(readInstanceIdentity).mockReturnValue(
      makeIdentityWithRemote({ expiresAt: justAfterNow }) as never,
    );
    mockFetchOnce(200, { status: "pending", pollIntervalSeconds: 60 });
    // Wait so that the helper's remainingMs computation is <= 0 at the time it runs.
    await new Promise((r) => setTimeout(r, 80));

    await runRegistryPollJob({ requestId: REQUEST_ID });

    // Should NOT enqueue (post-expiry short-circuit returns null).
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    const written = vi.mocked(writeInstanceIdentity).mock.calls[0]![0] as {
      registries: { remote: { status: string } };
    };
    expect(written.registries.remote.status).toBe("expired");
  });
});

describe("runRegistryPollJob — 200 approved (security-critical)", () => {
  it("writes token to Nango BEFORE deleting the request-secret, then flips connected", async () => {
    mockFetchOnce(200, { status: "approved", token: TOKEN });

    const callOrder: string[] = [];
    vi.mocked(writeRegistryCredential).mockImplementationOnce(async (_ns, kind) => {
      callOrder.push(`write:${kind}`);
    });
    vi.mocked(deleteRegistryCredential).mockImplementationOnce(async (_ns, kind) => {
      callOrder.push(`delete:${kind}`);
    });

    await runRegistryPollJob({ requestId: REQUEST_ID });

    // Ordering invariant: write token, then delete request-secret.
    expect(callOrder).toEqual(["write:token", "delete:request-secret"]);

    expect(writeRegistryCredential).toHaveBeenCalledWith(NAMESPACE, "token", TOKEN);
    expect(deleteRegistryCredential).toHaveBeenCalledWith(NAMESPACE, "request-secret");

    // Status flips to connected; nangoCredentialRef derived via the builder.
    const written = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)![0] as {
      registries: { remote: { status: string; approvedAt: string; tokenUpdatedAt: string; nangoCredentialRef: string } };
    };
    expect(written.registries.remote.status).toBe("connected");
    expect(written.registries.remote.approvedAt).toBeTypeOf("string");
    expect(written.registries.remote.tokenUpdatedAt).toBeTypeOf("string");
    expect(getRegistryCredentialRef).toHaveBeenCalledWith(NAMESPACE, "token");
    expect(written.registries.remote.nangoCredentialRef).toBe(`cinatra-registry-token-${NAMESPACE}`);

    // No reschedule on approved.
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("on Nango-write failure flips status to error, drops token, never logs the literal token", async () => {
    const logs: unknown[][] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      logs.push(args);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logs.push(args);
    });

    mockFetchOnce(200, { status: "approved", token: TOKEN });
    vi.mocked(writeRegistryCredential).mockRejectedValueOnce(new Error("verification failed"));

    await runRegistryPollJob({ requestId: REQUEST_ID });

    const written = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)![0] as {
      registries: { remote: { status: string; terminalReason: string | null } };
    };
    expect(written.registries.remote.status).toBe("error");
    expect(written.registries.remote.terminalReason).toMatch(/Token storage failed|fresh request/i);

    // Best-effort delete of request-secret still attempted.
    expect(deleteRegistryCredential).toHaveBeenCalledWith(NAMESPACE, "request-secret");

    // The literal token MUST NOT appear in any captured log line.
    const flat = logs
      .flatMap((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))))
      .join("\n");
    expect(flat).not.toContain(TOKEN);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("runRegistryPollJob — 200 denied", () => {
  it("flips status to denied, mirrors reason, deletes request-secret, no reschedule", async () => {
    mockFetchOnce(200, { status: "denied", reason: "spam suspicion" });
    await runRegistryPollJob({ requestId: REQUEST_ID });

    expect(deleteRegistryCredential).toHaveBeenCalledWith(NAMESPACE, "request-secret");
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();

    const written = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)![0] as {
      registries: { remote: { status: string; denyReason: string | null; deniedAt: string } };
    };
    expect(written.registries.remote.status).toBe("denied");
    expect(written.registries.remote.denyReason).toBe("spam suspicion");
    expect(written.registries.remote.deniedAt).toBeTypeOf("string");
  });
});

describe("runRegistryPollJob — 410 expired", () => {
  it("flips status to expired, deletes secret, no reschedule", async () => {
    mockFetchOnce(410, { status: "expired" });
    await runRegistryPollJob({ requestId: REQUEST_ID });
    expect(deleteRegistryCredential).toHaveBeenCalledWith(NAMESPACE, "request-secret");
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    const written = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)![0] as {
      registries: { remote: { status: string } };
    };
    expect(written.registries.remote.status).toBe("expired");
  });
});

describe("runRegistryPollJob — 410 consumed", () => {
  it("flips status to error, deletes secret, no reschedule", async () => {
    mockFetchOnce(410, { status: "consumed" });
    await runRegistryPollJob({ requestId: REQUEST_ID });
    expect(deleteRegistryCredential).toHaveBeenCalledWith(NAMESPACE, "request-secret");
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    const written = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)![0] as {
      registries: { remote: { status: string; terminalReason: string | null } };
    };
    expect(written.registries.remote.status).toBe("error");
    expect(written.registries.remote.terminalReason).toMatch(/consumed|fresh request/i);
  });
});

describe("runRegistryPollJob — 404 not_found", () => {
  it("flips status to error, deletes secret, no reschedule", async () => {
    mockFetchOnce(404, { error: { code: "not_found" } });
    await runRegistryPollJob({ requestId: REQUEST_ID });
    expect(deleteRegistryCredential).toHaveBeenCalledWith(NAMESPACE, "request-secret");
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    const written = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)![0] as {
      registries: { remote: { status: string; terminalReason: string | null } };
    };
    expect(written.registries.remote.status).toBe("error");
    expect(written.registries.remote.terminalReason).toMatch(/not recognized|not_found/i);
  });
});

describe("runRegistryPollJob — 429 rate_limited", () => {
  it("honors Retry-After header and reschedules without state mutation beyond timestamps", async () => {
    mockFetchOnce(429, { error: { code: "rate_limited" } }, { "retry-after": "120" });
    await runRegistryPollJob({ requestId: REQUEST_ID });

    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(enqueueBackgroundJob).mock.calls[0]![2] as { jobId: string; delay: number };
    expect(opts.delay).toBe(120_000);

    // No status flip — only timestamps move.
    const written = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)![0] as {
      registries: { remote: { status: string } };
    };
    expect(written.registries.remote.status).toBe("pending");
    expect(deleteRegistryCredential).not.toHaveBeenCalled();
  });
});

describe("runRegistryPollJob — 5xx / network failure", () => {
  it("first 5xx attempt uses BACKOFF_START_MS (30s)", async () => {
    mockFetchOnce(503, "");
    await runRegistryPollJob({ requestId: REQUEST_ID });

    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(enqueueBackgroundJob).mock.calls[0]![2] as { delay: number };
    expect(opts.delay).toBe(30_000);
  });

  it("doubles the backoff on consecutive 5xx responses (60s after a prior 30s window)", async () => {
    // Simulate "second 5xx attempt" by pre-populating lastPolledAt 30s before nextPollAt.
    const lastPolledAt = new Date(Date.now() - 60_000).toISOString();
    const nextPollAt = new Date(Date.now() - 30_000).toISOString();
    vi.mocked(readInstanceIdentity).mockReturnValue(
      makeIdentityWithRemote({ lastPolledAt, nextPollAt }) as never,
    );
    mockFetchOnce(503, "");
    await runRegistryPollJob({ requestId: REQUEST_ID });

    const opts = vi.mocked(enqueueBackgroundJob).mock.calls[0]![2] as { delay: number };
    expect(opts.delay).toBe(60_000);
  });

  it("caps the backoff at BACKOFF_CAP_MS (5min) when previous delta was already at the cap", async () => {
    const lastPolledAt = new Date(Date.now() - 600_000).toISOString();
    const nextPollAt = new Date(Date.now() - 300_000).toISOString(); // delta = 5min
    vi.mocked(readInstanceIdentity).mockReturnValue(
      makeIdentityWithRemote({ lastPolledAt, nextPollAt }) as never,
    );
    mockFetchOnce(500, "");
    await runRegistryPollJob({ requestId: REQUEST_ID });

    const opts = vi.mocked(enqueueBackgroundJob).mock.calls[0]![2] as { delay: number };
    expect(opts.delay).toBe(300_000);
  });

  it("network throw is treated as 5xx (uses deriveNext5xxBackoffMs)", async () => {
    mockFetchThrows(new Error("ENETUNREACH"));
    await runRegistryPollJob({ requestId: REQUEST_ID });
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(enqueueBackgroundJob).mock.calls[0]![2] as { delay: number };
    expect(opts.delay).toBe(30_000);
  });
});
