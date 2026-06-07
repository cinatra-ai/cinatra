// Approved-handler Nango-write failure path test.
//
// When the registry returns 200 approved with a token but Nango persistence of
// that token fails, the local state must flip to `error` with the documented
// terminalReason; the token literal must NOT be written to the local DB nor
// logged in any console sink; the request-secret deletion must be attempted
// (best-effort cleanup); and no further poll job is enqueued.
//
// The token literal `test-npm-token-LEAK-CANARY-12345` is a deliberate
// canary — the test asserts it never appears in any captured console
// argument.

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
  // Pass-through so we can detect a leak: if any console call is *given* the
  // token, the assertion below would fail. The real `redactSensitive`
  // strips it, so this stub deliberately does NOT, to surface any caller
  // that omits the wrapper.
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
  writeRegistryCredential,
  deleteRegistryCredential,
} from "@/lib/registry-credentials";
import { enqueueBackgroundJob } from "@/lib/background-jobs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;
const TOKEN_CANARY = "test-npm-token-LEAK-CANARY-12345";

function setRemoteState(): RemoteRegistryConnection {
  const remote: RemoteRegistryConnection = {
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
  vi.mocked(readInstanceIdentity).mockReturnValue({
    instanceNamespace: "test-ns",
    instanceDisplayName: "Test",
    registries: { remote },
  } as unknown as InstanceIdentity);
  return remote;
}

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function getAllLoggedText(): string {
  return [
    ...consoleLogSpy.mock.calls,
    ...consoleWarnSpy.mock.calls,
    ...consoleErrorSpy.mock.calls,
  ]
    .flatMap((call) =>
      call.map((arg: unknown) =>
        typeof arg === "string"
          ? arg
          : JSON.stringify(
              arg,
              (_key, value: unknown) => {
                if (typeof value === "bigint") return value.toString();
                if (value instanceof Error) return value.message + "\n" + (value.stack ?? "");
                return value;
              },
            ),
      ),
    )
    .join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Approved-handler Nango-write failure
// ---------------------------------------------------------------------------

describe("REGISTRY_POLL — approved with Nango write failure", () => {
  function setupFailureScenario() {
    setRemoteState();
    mockFetchOnce(200, { status: "approved", token: TOKEN_CANARY });
    vi.mocked(writeRegistryCredential).mockRejectedValueOnce(
      new Error("nango write failed"),
    );
  }

  it("does NOT write the token to the instance_identity store", async () => {
    setupFailureScenario();
    await runRegistryPollJob({ requestId: "req-1" });

    const writes = vi.mocked(writeInstanceIdentity).mock.calls;
    for (const [arg] of writes) {
      // Stringify the entire identity payload and assert the token does
      // not appear anywhere in the persisted state.
      const stringified = JSON.stringify(arg);
      expect(stringified).not.toContain(TOKEN_CANARY);
    }

    // Confirm the persisted status is `error`, not `connected`.
    const lastWrite = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0];
    expect((lastWrite as InstanceIdentity).registries?.remote?.status).toBe(
      "error",
    );
  });

  it("flips status to error with the documented terminalReason", async () => {
    setupFailureScenario();
    await runRegistryPollJob({ requestId: "req-1" });

    const lastWrite = vi.mocked(writeInstanceIdentity).mock.calls.at(-1)?.[0];
    const persisted = (lastWrite as InstanceIdentity).registries?.remote;
    expect(persisted?.status).toBe("error");
    expect(persisted?.terminalReason).toContain(
      "Token storage failed",
    );
  });

  it("emits an audit event without the token in payload", async () => {
    setupFailureScenario();
    await runRegistryPollJob({ requestId: "req-1" });

    // Confirm the nango-failure event tag was logged (somewhere in any sink).
    const captured = getAllLoggedText();
    expect(captured).toContain("[registry-poll] nango-failure");
    // And the canary token was NOT in any captured argument.
    expect(captured).not.toContain(TOKEN_CANARY);
  });

  it("attempts best-effort deletion of the request-secret", async () => {
    setupFailureScenario();
    await runRegistryPollJob({ requestId: "req-1" });

    expect(vi.mocked(deleteRegistryCredential)).toHaveBeenCalledWith(
      "test-ns",
      "request-secret",
    );
  });

  it("does not enqueue another poll", async () => {
    setupFailureScenario();
    await runRegistryPollJob({ requestId: "req-1" });

    expect(vi.mocked(enqueueBackgroundJob)).not.toHaveBeenCalled();
  });

  it("the token literal does not appear in any console sink", async () => {
    setupFailureScenario();
    await runRegistryPollJob({ requestId: "req-1" });

    const captured = getAllLoggedText();
    expect(captured).not.toContain(TOKEN_CANARY);
  });
});
