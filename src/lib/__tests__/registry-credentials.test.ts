// Tests for the namespace-keyed Nango credential facade.
//
// Behaviors under test:
//   1. writeRegistryCredential calls ensureNangoIntegration + importNangoConnection
//      with the conventional providerConfigKey + connectionId.
//   2. readRegistryCredential calls getNangoCredentials with the conventional
//      providerConfigKey + connectionId; returns null when Nango not configured.
//   3. deleteRegistryCredential calls deleteNangoConnection idempotently.
//   4. All helpers no-op gracefully when isNangoConfigured() === false (read/delete
//      no-op; write THROWS so callers learn that persistence failed).
//   5. Callers cannot construct credential IDs by hand — only (namespace, kind) is exported.
//   6. writeRegistryCredential calls getNangoCredentials AFTER importNangoConnection
//      resolves, with forceRefresh: true, and only resolves when the readback value
//      matches the input.
//   7. Readback mismatch THROWS with the generic verification-failed message
//      (not containing the input or readback value).
//   8. Readback null THROWS with the same generic message.
//   9. Verification failure does NOT log the input or readback value.
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

    await writeRegistryCredential("ns-1", "request-secret", "rs-abc");

    expect(vi.mocked(ensureNangoIntegration)).toHaveBeenCalledTimes(1);
    const ensureCall = vi.mocked(ensureNangoIntegration).mock.calls[0][0];
    expect(ensureCall.providerConfigKey).toBe("cinatra-registry");
  });

  it("calls importNangoConnection with the per-namespace connectionId for request-secret kind", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "rs-abc" } as never);

    await writeRegistryCredential("ns-1", "request-secret", "rs-abc");

    expect(vi.mocked(importNangoConnection)).toHaveBeenCalledTimes(1);
    const importCall = vi.mocked(importNangoConnection).mock.calls[0][0];
    expect(importCall.providerConfigKey).toBe("cinatra-registry");
    expect(importCall.connectionId).toBe("cinatra-registry-request-secret-ns-1");
    expect(importCall.credentials).toEqual({ type: "API_KEY", apiKey: "rs-abc" });
  });

  it("uses kind=token in the connectionId for token kind", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "tok-abc" } as never);

    await writeRegistryCredential("ns-1", "token", "tok-abc");

    const importCall = vi.mocked(importNangoConnection).mock.calls[0][0];
    expect(importCall.connectionId).toBe("cinatra-registry-token-ns-1");
  });
});

describe("readRegistryCredential", () => {
  it("calls getNangoCredentials with the conventional providerConfigKey + connectionId and returns the apiKey", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "rs-stored" } as never);

    const value = await readRegistryCredential("ns-1", "request-secret");

    expect(vi.mocked(getNangoCredentials)).toHaveBeenCalledWith(
      "cinatra-registry",
      "cinatra-registry-request-secret-ns-1",
    );
    expect(value).toBe("rs-stored");
  });

  it("returns null when Nango credential lookup yields null", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce(null);
    const value = await readRegistryCredential("ns-1", "token");
    expect(value).toBeNull();
  });

  it("returns null when isNangoConfigured() is false", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(false);
    const value = await readRegistryCredential("ns-1", "token");
    expect(value).toBeNull();
    expect(vi.mocked(getNangoCredentials)).not.toHaveBeenCalled();
  });
});

describe("deleteRegistryCredential", () => {
  it("calls deleteNangoConnection with the conventional providerConfigKey + connectionId", async () => {
    await deleteRegistryCredential("ns-1", "request-secret");
    expect(vi.mocked(deleteNangoConnection)).toHaveBeenCalledWith(
      "cinatra-registry",
      "cinatra-registry-request-secret-ns-1",
    );
  });

  it("is idempotent — a second call when the credential is already gone does not throw", async () => {
    // The Nango wrapper's delete itself swallows missing-connection errors, so this
    // helper inherits that contract. A 404-equivalent rejection from the underlying
    // call must be swallowed too as an extra defensive layer.
    vi.mocked(deleteNangoConnection).mockRejectedValueOnce(new Error("not found"));
    await expect(deleteRegistryCredential("ns-1", "token")).resolves.toBeUndefined();
  });

  it("no-ops when isNangoConfigured() is false", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(false);
    await deleteRegistryCredential("ns-1", "token");
    expect(vi.mocked(deleteNangoConnection)).not.toHaveBeenCalled();
  });
});

describe("getRegistryCredentialRef (exported credential reference builder)", () => {
  it("returns the same connectionId format that writeRegistryCredential uses", () => {
    expect(getRegistryCredentialRef("ns-1", "request-secret")).toBe(
      "cinatra-registry-request-secret-ns-1",
    );
    expect(getRegistryCredentialRef("ns-1", "token")).toBe("cinatra-registry-token-ns-1");
  });
});

describe("writeRegistryCredential — readback verification", () => {
  it("calls getNangoCredentials AFTER importNangoConnection resolves, with the same connectionId and forceRefresh: true", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "tok-abc" } as never);

    await writeRegistryCredential("ns-1", "token", "tok-abc");

    // Order: import must have been called before getNangoCredentials.
    const importIdx = vi.mocked(importNangoConnection).mock.invocationCallOrder[0];
    const readIdx = vi.mocked(getNangoCredentials).mock.invocationCallOrder[0];
    expect(importIdx).toBeLessThan(readIdx);

    expect(vi.mocked(getNangoCredentials)).toHaveBeenCalledWith(
      "cinatra-registry",
      "cinatra-registry-token-ns-1",
      { forceRefresh: true },
    );
  });

  it("THROWS with the generic verification-failed message when the readback returns a different value", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce({ apiKey: "different-value" } as never);

    await expect(writeRegistryCredential("ns-1", "token", "tok-abc")).rejects.toThrow(
      "Nango credential write verification failed (readback did not match input).",
    );
  });

  it("THROWS with the generic verification-failed message when the readback returns null", async () => {
    vi.mocked(getNangoCredentials).mockResolvedValueOnce(null);

    await expect(writeRegistryCredential("ns-1", "token", "tok-abc")).rejects.toThrow(
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

    await expect(writeRegistryCredential("ns-1", "token", INPUT)).rejects.toThrow(
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
    await expect(writeRegistryCredential("ns-1", "token", "tok-abc")).rejects.toThrow(
      /Nango is not configured/,
    );
    expect(vi.mocked(ensureNangoIntegration)).not.toHaveBeenCalled();
    expect(vi.mocked(importNangoConnection)).not.toHaveBeenCalled();
  });
});
