// Tests for the request-scoped Nango credential facade (cinatra#899).
//
// Behaviors under test:
//   1. writeRegistryCredential calls ensureNangoIntegration + importNangoConnection
//      with the conventional providerConfigKey + the request-scoped connectionId.
//   2. readRegistryCredential calls getNangoCredentials with the conventional
//      providerConfigKey + the request-scoped connectionId; returns null when
//      Nango not configured.
//   3. deleteRegistryCredential calls deleteNangoConnection idempotently.
//   4. All helpers no-op gracefully when isNangoConfigured() === false (read/delete
//      no-op; write THROWS so callers learn that persistence failed).
//   5. Callers cannot construct credential IDs by hand — only (namespace, kind,
//      requestId) is exported.
//   6. writeRegistryCredential calls getNangoCredentials AFTER importNangoConnection
//      resolves, with forceRefresh: true, and only resolves when the readback value
//      matches the input.
//   7. Readback mismatch THROWS with the generic verification-failed message
//      (not containing the input or readback value).
//   8. Readback null THROWS with the same generic message.
//   9. Verification failure does NOT log the input or readback value.
//  10. Request-scoping (cinatra#899): the requestId is part of the key, so two
//      different requests for the SAME namespace + kind address DIFFERENT
//      credentials — a stale actor for one request cannot touch another's.
//  11. Fail-closed: an empty/blank requestId (or namespace) THROWS rather than
//      collapsing the key toward an ambiguous, cross-request-aliasable form.
//
// Note: the readback verification logic lives INSIDE writeRegistryCredential;
// callers catch the thrown error and route to their respective terminal paths.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/nango-system", () => ({
  ensureNangoIntegration: vi.fn(async () => null),
  importNangoConnection: vi.fn(async () => null),
  deleteNangoConnection: vi.fn(async () => undefined),
  getNangoCredentials: vi.fn(async () => null),
  isNangoConfigured: vi.fn(() => true),
}));

import {
  ensureNangoIntegration,
  importNangoConnection,
  deleteNangoConnection,
  getNangoCredentials,
  isNangoConfigured,
} from "@/lib/nango-system";
import {
  readRegistryCredential,
  writeRegistryCredential,
  deleteRegistryCredential,
  getRegistryCredentialRef,
} from "@/lib/registry-credentials";

const REQ = "req-1";
const REQ_2 = "req-2";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isNangoConfigured).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeRegistryCredential — happy path", () => {
  it("calls ensureNangoIntegration once with cinatra-registry providerConfigKey", async () => {
    // Arrange a successful readback so the verification step passes.
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "rs-abc" } as never);

    await writeRegistryCredential("ns-1", "request-secret", REQ, "rs-abc");

    expect(vi.mocked(ensureNangoIntegration)).toHaveBeenCalledTimes(1);
    const ensureCall = vi.mocked(ensureNangoIntegration).mock.calls[0][0];
    expect(ensureCall.providerConfigKey).toBe("cinatra-registry");
  });

  it("calls importNangoConnection with the request-scoped connectionId for request-secret kind", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "rs-abc" } as never);

    await writeRegistryCredential("ns-1", "request-secret", REQ, "rs-abc");

    expect(vi.mocked(importNangoConnection)).toHaveBeenCalledTimes(1);
    const importCall = vi.mocked(importNangoConnection).mock.calls[0][0];
    expect(importCall.providerConfigKey).toBe("cinatra-registry");
    expect(importCall.connectionId).toBe("cinatra-registry-request-secret-ns-1-req-1");
    expect(importCall.credentials).toEqual({ type: "API_KEY", apiKey: "rs-abc" });
  });

  it("uses kind=token in the connectionId for token kind", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "tok-abc" } as never);

    await writeRegistryCredential("ns-1", "token", REQ, "tok-abc");

    const importCall = vi.mocked(importNangoConnection).mock.calls[0][0];
    expect(importCall.connectionId).toBe("cinatra-registry-token-ns-1-req-1");
  });
});

describe("readRegistryCredential", () => {
  it("calls getNangoCredentials with the conventional providerConfigKey + request-scoped connectionId and returns the apiKey", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "rs-stored" } as never);

    const value = await readRegistryCredential("ns-1", "request-secret", REQ);

    expect(vi.mocked(getNangoCredentials)).toHaveBeenCalledWith(
      "cinatra-registry",
      "cinatra-registry-request-secret-ns-1-req-1",
    );
    expect(value).toBe("rs-stored");
  });

  it("returns null when Nango credential lookup yields null", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce(null);
    const value = await readRegistryCredential("ns-1", "token", REQ);
    expect(value).toBeNull();
  });

  it("returns null when isNangoConfigured() is false", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(false);
    const value = await readRegistryCredential("ns-1", "token", REQ);
    expect(value).toBeNull();
    expect(vi.mocked(getNangoCredentials)).not.toHaveBeenCalled();
  });
});

describe("deleteRegistryCredential", () => {
  it("calls deleteNangoConnection with the conventional providerConfigKey + request-scoped connectionId", async () => {
    await deleteRegistryCredential("ns-1", "request-secret", REQ);
    expect(vi.mocked(deleteNangoConnection)).toHaveBeenCalledWith(
      "cinatra-registry",
      "cinatra-registry-request-secret-ns-1-req-1",
    );
  });

  it.each([
    ["status", { status: 404 }],
    ["statusCode", { statusCode: 404 }],
    ["response.status", { response: { status: 404 } }],
  ])("is idempotent — a STRUCTURED 404 (%s) when the credential is already gone is swallowed SILENTLY (no warn)", async (_label, err) => {
    // A structured HTTP 404 is the sole reliable already-absent signal, and the
    // ONLY class this helper swallows — silently, with no noise.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(deleteNangoConnection).mockRejectedValueOnce(err as never);
    await expect(deleteRegistryCredential("ns-1", "token", REQ)).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does NOT throw on ANY delete failure — unwrapped one-shot poll-job callers rely on it resolving to persist their terminal state", async () => {
    vi.mocked(deleteNangoConnection).mockRejectedValueOnce(new Error("nango 503 boom"));
    await expect(deleteRegistryCredential("ns-1", "token", REQ)).resolves.toBeUndefined();
  });

  it("LOGS a real (non-404) delete failure with the connectionId (never a value) so the masked-failure is observable (cinatra#899)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(deleteNangoConnection).mockRejectedValueOnce(
      new Error("nango 503: upstream config error, missing API key"),
    );
    await expect(deleteRegistryCredential("ns-1", "token", REQ)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls
      .flatMap((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))))
      .join("\n");
    expect(logged).toContain("cinatra-registry-token-ns-1-req-1");
    warnSpy.mockRestore();
  });

  it.each([
    "provider config not found",
    "API key not_found",
    "route 404 while calling upstream",
    "delete connection failed: provider config not found",
    "connection provider config not found",
    "connection already exists but provider config not found",
    "Connection not found", // message-only 404 (no status): logged, never masked
    "no such connection",
  ])("LOGS (never silently swallows) a message-only failure, so no real failure is masked as a benign missing-connection: %s", async (msg) => {
    // Guards against ANY substring/message-based misclassification: only a
    // STRUCTURED 404 is swallowed; a message-only error is always logged
    // (cinatra#899 — a security-sensitive credential delete must not hide a real
    // failure behind operation-context prose).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(deleteNangoConnection).mockRejectedValueOnce(new Error(msg));
    await expect(deleteRegistryCredential("ns-1", "token", REQ)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("no-ops when isNangoConfigured() is false", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(false);
    await deleteRegistryCredential("ns-1", "token", REQ);
    expect(vi.mocked(deleteNangoConnection)).not.toHaveBeenCalled();
  });
});

describe("getRegistryCredentialRef (exported credential reference builder)", () => {
  it("returns the same request-scoped connectionId format that writeRegistryCredential uses", () => {
    expect(getRegistryCredentialRef("ns-1", "request-secret", REQ)).toBe(
      "cinatra-registry-request-secret-ns-1-req-1",
    );
    expect(getRegistryCredentialRef("ns-1", "token", REQ)).toBe(
      "cinatra-registry-token-ns-1-req-1",
    );
  });
});

describe("request-scoping (cinatra#899) — cross-request credential isolation", () => {
  it("addresses DIFFERENT connectionIds for two requests of the same namespace + kind", () => {
    const refA = getRegistryCredentialRef("ns-1", "request-secret", REQ);
    const refB = getRegistryCredentialRef("ns-1", "request-secret", REQ_2);
    expect(refA).not.toBe(refB);
    expect(refA).toBe("cinatra-registry-request-secret-ns-1-req-1");
    expect(refB).toBe("cinatra-registry-request-secret-ns-1-req-2");
  });

  it("a delete for request A targets a DIFFERENT Nango connectionId than request B's — a stale teardown cannot reach the live request's credential", async () => {
    await deleteRegistryCredential("ns-1", "request-secret", REQ);
    await deleteRegistryCredential("ns-1", "request-secret", REQ_2);

    const deletedIds = vi
      .mocked(deleteNangoConnection)
      .mock.calls.map((call) => call[1]);
    expect(deletedIds).toEqual([
      "cinatra-registry-request-secret-ns-1-req-1",
      "cinatra-registry-request-secret-ns-1-req-2",
    ]);
    // The two deletes never collide on the same key.
    expect(deletedIds[0]).not.toBe(deletedIds[1]);
  });

  it("a read for request A never returns request B's credential (distinct keys)", async () => {
    await readRegistryCredential("ns-1", "token", REQ);
    await readRegistryCredential("ns-1", "token", REQ_2);
    const readIds = vi.mocked(getNangoCredentials).mock.calls.map((call) => call[1]);
    expect(readIds).toEqual([
      "cinatra-registry-token-ns-1-req-1",
      "cinatra-registry-token-ns-1-req-2",
    ]);
  });
});

describe("fail-closed — empty/blank key components throw", () => {
  it("getRegistryCredentialRef throws on an empty requestId (never collapses to an ambiguous key)", () => {
    expect(() => getRegistryCredentialRef("ns-1", "token", "")).toThrow(
      /non-empty requestId/,
    );
  });

  it("getRegistryCredentialRef throws on an empty namespace", () => {
    expect(() => getRegistryCredentialRef("", "token", REQ)).toThrow(
      /non-empty namespace/,
    );
  });

  it("deleteRegistryCredential throws on an empty requestId rather than targeting a namespace-agnostic key", async () => {
    await expect(deleteRegistryCredential("ns-1", "token", "")).rejects.toThrow(
      /non-empty requestId/,
    );
    expect(vi.mocked(deleteNangoConnection)).not.toHaveBeenCalled();
  });

  it("writeRegistryCredential throws on an empty requestId (nothing is imported)", async () => {
    await expect(
      writeRegistryCredential("ns-1", "token", "", "tok-abc"),
    ).rejects.toThrow(/non-empty requestId/);
    expect(vi.mocked(importNangoConnection)).not.toHaveBeenCalled();
  });
});

describe("writeRegistryCredential — readback verification", () => {
  it("calls getNangoCredentials AFTER importNangoConnection resolves, with the same connectionId and forceRefresh: true", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "tok-abc" } as never);

    await writeRegistryCredential("ns-1", "token", REQ, "tok-abc");

    // Order: import must have been called before getNangoCredentials.
    const importIdx = vi.mocked(importNangoConnection).mock.invocationCallOrder[0];
    const readIdx = vi.mocked(getNangoCredentials).mock.invocationCallOrder[0];
    expect(importIdx).toBeLessThan(readIdx);

    expect(vi.mocked(getNangoCredentials)).toHaveBeenCalledWith(
      "cinatra-registry",
      "cinatra-registry-token-ns-1-req-1",
      { forceRefresh: true },
    );
  });

  it("THROWS with the generic verification-failed message when the readback returns a different value", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "different-value" } as never);

    await expect(writeRegistryCredential("ns-1", "token", REQ, "tok-abc")).rejects.toThrow(
      "Nango credential write verification failed (readback did not match input).",
    );
  });

  it("THROWS with the generic verification-failed message when the readback returns null", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce(null);

    await expect(writeRegistryCredential("ns-1", "token", REQ, "tok-abc")).rejects.toThrow(
      "Nango credential write verification failed (readback did not match input).",
    );
  });

  it("never logs the input value or readback value on a verification mismatch", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const INPUT = "tok-input-secret-must-not-leak";
    const READBACK = "tok-readback-different-must-not-leak";
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: READBACK } as never);

    await expect(writeRegistryCredential("ns-1", "token", REQ, INPUT)).rejects.toThrow(
      /verification failed/,
    );

    const allCalls = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ]
      .flatMap((call) => call.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))))
      .join("\n");

    expect(allCalls).not.toContain(INPUT);
    expect(allCalls).not.toContain(READBACK);
  });
});

describe("writeRegistryCredential — Nango-not-configured invariant", () => {
  it("THROWS when isNangoConfigured() is false; silent no-op would break terminal-error handling", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(false);
    await expect(writeRegistryCredential("ns-1", "token", REQ, "tok-abc")).rejects.toThrow(
      /Nango is not configured/,
    );
    expect(vi.mocked(ensureNangoIntegration)).not.toHaveBeenCalled();
    expect(vi.mocked(importNangoConnection)).not.toHaveBeenCalled();
  });
});
