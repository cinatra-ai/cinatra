// Structural guard for the PM work-store capability (cinatra#1031). The host
// binds an external resolver that filters capability-registered impls through
// `isPmWorkStore` before the SDK registry trusts them. EVERY PmWorkStore verb is
// REQUIRED — a provider missing any op must be rejected so the W2 store
// discipline can never dispatch to a half-implemented store. Mirrors
// register-pm-providers.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module self-invokes registerPmWorkStoreProviders() on import, which binds
// an external resolver and reads the host capability registry. Stub the SDK and
// the capabilities registry so importing the module in the node test env is a
// no-op apart from exposing isPmWorkStore.
vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/sdk-extensions", () => ({
  setPmWorkStoreExternalResolver: vi.fn(),
}));
vi.mock("@cinatra-ai/sdk-extensions/internal", () => ({
  PM_WORK_STORE_CAPABILITY: "pm-work-store",
}));
vi.mock("@/lib/extension-capabilities-registry", () => ({
  resolveCapabilityProviders: vi.fn(() => []),
}));

import { isPmWorkStore } from "../register-pm-work-store-providers";

const VERBS = [
  "createWorkItem",
  "getWorkItemByKey",
  "getWorkItem",
  "listWorkItems",
  "updateWorkItem",
  "closeWorkItem",
  "addComment",
  "listComments",
] as const;

function fullProvider(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = { providerId: "plane" };
  for (const v of VERBS) base[v] = () => {};
  return { ...base, ...overrides };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isPmWorkStore — structural guard requires every PmWorkStore verb", () => {
  it("accepts a fully-shaped provider (all CRUD verbs)", () => {
    expect(isPmWorkStore(fullProvider())).toBe(true);
  });

  it("rejects a non-object / null impl", () => {
    expect(isPmWorkStore(null)).toBe(false);
    expect(isPmWorkStore(undefined)).toBe(false);
    expect(isPmWorkStore("plane")).toBe(false);
    expect(isPmWorkStore(42)).toBe(false);
  });

  it("rejects an empty / non-string providerId", () => {
    expect(isPmWorkStore(fullProvider({ providerId: "" }))).toBe(false);
    expect(isPmWorkStore(fullProvider({ providerId: 123 }))).toBe(false);
  });

  it.each(VERBS)("rejects a provider missing %s", (verb) => {
    const p = fullProvider();
    delete (p as Record<string, unknown>)[verb];
    expect(isPmWorkStore(p)).toBe(false);
  });

  it("rejects when a verb is present but not a function", () => {
    expect(isPmWorkStore(fullProvider({ createWorkItem: "nope" }))).toBe(false);
    expect(isPmWorkStore(fullProvider({ listWorkItems: 5 }))).toBe(false);
  });
});
