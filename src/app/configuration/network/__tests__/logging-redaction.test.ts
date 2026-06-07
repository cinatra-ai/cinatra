// Full happy-path log-redaction regression coverage.
//
// Drives the full happy path through the REAL `requestRemoteAccessAction`
// and `runRegistryPollJob` imports (only their I/O dependencies are mocked)
// and captures every `console.log/warn/error` call. Asserts that the literal
// canary token AND the literal canary requestSecret strings do NOT appear in
// any captured argument.
//
// Canary strings are deliberately distinct from realistic-looking secrets —
// they're obviously synthetic and not real tokens. Their presence in CI
// logs is harmless; their presence in *captured handler output* would
// indicate a redaction-pipeline regression.
//
// Manual leak-check: to verify this test catches real leaks, edit
// `src/lib/registry-poll-job.ts` to add
// `console.log(token)` inside the 200-approved branch, run this file, and
// observe failure. Revert before committing. The file intentionally contains
// `REDACTION-CANARY` literals multiple times.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RemoteRegistryConnection, InstanceIdentity } from "@/lib/instance-identity-store";

// ---------------------------------------------------------------------------
// Canary literals
//
// The two canary literals — REDACTION-CANARY-TOKEN-... and
// REDACTION-CANARY-SECRET-... — are deliberately distinct from any real
// token format. They are used as the npm token (REDACTION-CANARY-TOKEN-...)
// and the requestSecret (REDACTION-CANARY-SECRET-...) values fed into the
// real action and handler under test, then asserted absent from every
// captured logger sink.
// ---------------------------------------------------------------------------

const TOKEN_CANARY = "REDACTION-CANARY-TOKEN-yz9x8w7v6u5t4s3r2q1p0";
const SECRET_CANARY = "REDACTION-CANARY-SECRET-abcdefghijklmnopqrstuvwxyz12";

// ---------------------------------------------------------------------------
// Mocks — all I/O dependencies. The real action and handler are NOT mocked.
// ---------------------------------------------------------------------------

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({
    user: { id: "u", email: "operator@example.com" },
  })),
  requireAuthSession: vi.fn(async () => ({
    user: { id: "u", email: "operator@example.com" },
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
  readRegistryCredential: vi.fn(),
  writeRegistryCredential: vi.fn(),
  deleteRegistryCredential: vi.fn(),
  getRegistryCredentialRef: vi.fn(
    (ns: string, kind: string) => `cinatra-registry-${kind}-${ns}`,
  ),
}));
vi.mock("@/lib/background-jobs", () => ({
  BACKGROUND_JOB_NAMES: { REGISTRY_POLL: "registry-poll" },
  enqueueBackgroundJob: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const e = new Error("REDIRECT:" + url);
    (e as unknown as { __isRedirect: true }).__isRedirect = true;
    throw e;
  }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { requestRemoteAccessAction } from "@/app/configuration/network/actions";
import { runRegistryPollJob } from "@/lib/registry-poll-job";
import {
  readInstanceIdentity,
  writeInstanceIdentity,
} from "@/lib/instance-identity-store";
import {
  readRegistryCredential,
  writeRegistryCredential,
} from "@/lib/registry-credentials";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

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
      call.map((arg: unknown) => {
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(arg, (_key, value: unknown) => {
            if (typeof value === "bigint") return value.toString();
            if (value instanceof Error) {
              return value.message + "\n" + (value.stack ?? "");
            }
            return value;
          });
        } catch {
          return String(arg);
        }
      }),
    )
    .join("\n");
}

function setIdentityState(remote?: Partial<RemoteRegistryConnection> & {
  status: RemoteRegistryConnection["status"];
}): void {
  const identity: InstanceIdentity = {
    instanceNamespace: "test-ns",
    instanceDisplayName: "Test",
    registries: remote
      ? {
          remote: {
            url: "https://registry.example",
            namespace: "test-ns",
            ...remote,
          } as RemoteRegistryConnection,
        }
      : {},
  } as unknown as InstanceIdentity;
  vi.mocked(readInstanceIdentity).mockReturnValue(identity);
  // After writeInstanceIdentity is called inside the action, the next
  // poll-handler read should see the persisted state. Wire writes to
  // re-program the read mock.
  vi.mocked(writeInstanceIdentity).mockImplementation(
    (next: InstanceIdentity) => {
      vi.mocked(readInstanceIdentity).mockReturnValue(next);
    },
  );
}

function mockFetchResponseOnce(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function buildRequestForm(): FormData {
  const fd = new FormData();
  fd.append("contactEmail", "operator@example.com");
  return fd;
}

async function captureRedirect(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (err) {
    const e = err as { __isRedirect?: true };
    if (e.__isRedirect) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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
// Full happy-path drive
// ---------------------------------------------------------------------------

describe("logging redaction — full happy path drive", () => {
  it("never logs the literal requestSecret during the request action 201 path", async () => {
    setIdentityState({ status: "not_connected" });
    mockFetchResponseOnce(201, {
      requestId: "req-1",
      requestSecret: SECRET_CANARY,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      pollIntervalSeconds: 30,
    });
    await captureRedirect(() => requestRemoteAccessAction(buildRequestForm()));

    const captured = getAllLoggedText();
    expect(captured).not.toContain(SECRET_CANARY);
  });

  it("never logs the literal token during the poll-job approved path", async () => {
    setIdentityState({
      status: "pending",
      requestId: "req-1",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    vi.mocked(readRegistryCredential).mockResolvedValue(SECRET_CANARY);
    mockFetchResponseOnce(200, { status: "approved", token: TOKEN_CANARY });
    await runRegistryPollJob({ requestId: "req-1" });

    const captured = getAllLoggedText();
    expect(captured).not.toContain(TOKEN_CANARY);
  });

  it("never logs either canary during the full happy path drive (request → 3 pending polls → approved)", async () => {
    // Step 1: Request action — 201 happy path with SECRET_CANARY.
    setIdentityState({ status: "not_connected" });
    mockFetchResponseOnce(201, {
      requestId: "req-1",
      requestSecret: SECRET_CANARY,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      pollIntervalSeconds: 30,
    });
    await captureRedirect(() => requestRemoteAccessAction(buildRequestForm()));

    // Re-prime state to pending for the polling phase. The
    // writeInstanceIdentity mock has already pushed the new state.
    // Ensure readRegistryCredential returns the secret for poll calls.
    vi.mocked(readRegistryCredential).mockResolvedValue(SECRET_CANARY);

    // Step 2: 3 pending polls.
    for (let i = 0; i < 3; i++) {
      setIdentityState({
        status: "pending",
        requestId: "req-1",
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      mockFetchResponseOnce(200, { status: "pending", pollIntervalSeconds: 30 });
      await runRegistryPollJob({ requestId: "req-1" });
    }

    // Step 3: 200 approved with TOKEN_CANARY.
    setIdentityState({
      status: "pending",
      requestId: "req-1",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    mockFetchResponseOnce(200, { status: "approved", token: TOKEN_CANARY });
    await runRegistryPollJob({ requestId: "req-1" });

    const captured = getAllLoggedText();
    expect(captured).not.toContain(SECRET_CANARY);
    expect(captured).not.toContain(TOKEN_CANARY);
  });

  it("never logs the Authorization header value containing the secret canary", async () => {
    setIdentityState({
      status: "pending",
      requestId: "req-1",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    vi.mocked(readRegistryCredential).mockResolvedValue(SECRET_CANARY);
    mockFetchResponseOnce(200, { status: "pending", pollIntervalSeconds: 30 });
    await runRegistryPollJob({ requestId: "req-1" });

    const captured = getAllLoggedText();
    expect(captured).not.toContain(`Bearer ${SECRET_CANARY}`);
  });
});

// ---------------------------------------------------------------------------
// Failure paths — the highest-risk leak surface
// ---------------------------------------------------------------------------

describe("logging redaction — failure paths", () => {
  it("never logs the token during the Nango-failure approved path", async () => {
    setIdentityState({
      status: "pending",
      requestId: "req-1",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    vi.mocked(readRegistryCredential).mockResolvedValue(SECRET_CANARY);
    mockFetchResponseOnce(200, { status: "approved", token: TOKEN_CANARY });
    vi.mocked(writeRegistryCredential).mockRejectedValueOnce(
      new Error("Nango write failed"),
    );

    await runRegistryPollJob({ requestId: "req-1" });

    const captured = getAllLoggedText();
    expect(captured).not.toContain(TOKEN_CANARY);
  });
});
