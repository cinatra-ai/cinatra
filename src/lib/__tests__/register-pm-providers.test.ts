// Structural guard for the PM provider capability (cinatra#317 + #319). The
// host binds an external resolver that filters capability-registered impls
// through `isPmConnector` before the SDK registry trusts them. The #319 read
// seam (`readTriggerTask`) is a REQUIRED method — a provider missing it must be
// rejected so a pre-execution PM read can never dispatch to a half-implemented
// provider.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module self-invokes registerPmProviders() on import, which binds an
// external resolver and reads the host capability registry. Stub the SDK and
// the capabilities registry so importing the module in the node test env is a
// no-op apart from exposing isPmConnector.
vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/sdk-extensions", () => ({
  setPmProviderExternalResolver: vi.fn(),
}));
vi.mock("@cinatra-ai/sdk-extensions/internal", () => ({
  PM_PROVIDER_CAPABILITY: "pm-provider",
}));
vi.mock("@/lib/extension-capabilities-registry", () => ({
  resolveCapabilityProviders: vi.fn(() => []),
}));

import { isPmConnector } from "../register-pm-providers";

function fullProvider(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "plane",
    upsertTriggerTask: () => {},
    deleteTriggerTask: () => {},
    readTriggerTask: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isPmConnector — structural guard requires every PmConnector verb", () => {
  it("accepts a fully-shaped provider (incl. readTriggerTask)", () => {
    expect(isPmConnector(fullProvider())).toBe(true);
  });

  it("rejects a non-object / null impl", () => {
    expect(isPmConnector(null)).toBe(false);
    expect(isPmConnector(undefined)).toBe(false);
    expect(isPmConnector("plane")).toBe(false);
    expect(isPmConnector(42)).toBe(false);
  });

  it("rejects an empty / non-string providerId", () => {
    expect(isPmConnector(fullProvider({ providerId: "" }))).toBe(false);
    expect(isPmConnector(fullProvider({ providerId: 123 }))).toBe(false);
  });

  it("rejects a provider missing upsertTriggerTask", () => {
    const p = fullProvider();
    delete (p as Record<string, unknown>).upsertTriggerTask;
    expect(isPmConnector(p)).toBe(false);
  });

  it("rejects a provider missing deleteTriggerTask", () => {
    const p = fullProvider();
    delete (p as Record<string, unknown>).deleteTriggerTask;
    expect(isPmConnector(p)).toBe(false);
  });

  it("rejects a provider missing the #319 readTriggerTask read seam", () => {
    // The pre-#319 PmConnector (only upsert + delete) must NOT pass once the
    // read seam is required — otherwise the pre-execution check would dispatch
    // to a provider that cannot read PM state.
    const p = fullProvider();
    delete (p as Record<string, unknown>).readTriggerTask;
    expect(isPmConnector(p)).toBe(false);
  });

  it("rejects when readTriggerTask is present but not a function", () => {
    expect(isPmConnector(fullProvider({ readTriggerTask: "nope" }))).toBe(false);
  });
});
