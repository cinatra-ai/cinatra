import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

let storedBlob: Record<string, unknown> = {};

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn((key: string, fallback: unknown) => {
    return key in storedBlob ? storedBlob[key] : fallback;
  }),
  writeConnectorConfigToDatabase: vi.fn((key: string, value: unknown) => {
    storedBlob[key] = value;
  }),
}));

import {
  getDevExtensionsSettings,
  saveDevExtensionsSettings,
  normalizePublishScopeOverride,
  readEffectivePublishScopeOverride,
} from "@/lib/dev-extensions";

const ORIGINAL_RUNTIME_MODE = process.env.CINATRA_RUNTIME_MODE;

beforeEach(() => {
  storedBlob = {};
  process.env.CINATRA_RUNTIME_MODE = ORIGINAL_RUNTIME_MODE;
});

describe("dev-extensions settings store", () => {
  it("returns publishScopeOverride: null when no settings stored", () => {
    expect(getDevExtensionsSettings()).toEqual({ publishScopeOverride: null });
  });

  it("roundtrips saved override through the blob store", () => {
    saveDevExtensionsSettings({ publishScopeOverride: "acme-corp" });
    expect(getDevExtensionsSettings()).toEqual({ publishScopeOverride: "acme-corp" });
  });

  it("treats empty string as null on save", () => {
    saveDevExtensionsSettings({ publishScopeOverride: "" });
    expect(getDevExtensionsSettings()).toEqual({ publishScopeOverride: null });
  });

  it("treats null as null on save", () => {
    saveDevExtensionsSettings({ publishScopeOverride: null });
    expect(getDevExtensionsSettings()).toEqual({ publishScopeOverride: null });
  });

  it("can clear a saved override", () => {
    saveDevExtensionsSettings({ publishScopeOverride: "acme-corp" });
    saveDevExtensionsSettings({ publishScopeOverride: null });
    expect(getDevExtensionsSettings()).toEqual({ publishScopeOverride: null });
  });
});

describe("normalizePublishScopeOverride", () => {
  it("returns null for nullish input", () => {
    expect(normalizePublishScopeOverride(null)).toBeNull();
    expect(normalizePublishScopeOverride(undefined)).toBeNull();
    expect(normalizePublishScopeOverride("")).toBeNull();
    expect(normalizePublishScopeOverride("   ")).toBeNull();
  });

  it("strips leading @ and lowercases", () => {
    expect(normalizePublishScopeOverride("@Acme-Corp")).toBe("acme-corp");
    expect(normalizePublishScopeOverride("ACME")).toBe("acme");
    expect(normalizePublishScopeOverride("  @cinatra-test  ")).toBe("cinatra-test");
  });

  it("rejects names containing /", () => {
    expect(() => normalizePublishScopeOverride("acme/foo")).toThrow();
    expect(() => normalizePublishScopeOverride("@acme/foo")).toThrow();
  });

  it("rejects names that fail the scope regex", () => {
    expect(() => normalizePublishScopeOverride("a")).toThrow(); // too short
    expect(() => normalizePublishScopeOverride("acme!")).toThrow(); // bad chars
    expect(() => normalizePublishScopeOverride("-acme")).toThrow(); // leading hyphen
    expect(() => normalizePublishScopeOverride("a".repeat(40))).toThrow(); // too long
  });

  it("accepts valid names at the regex boundaries", () => {
    expect(normalizePublishScopeOverride("ab")).toBe("ab"); // minimum length
    expect(normalizePublishScopeOverride(`a${"b".repeat(38)}`)).toBe(`a${"b".repeat(38)}`); // max length 39
    expect(normalizePublishScopeOverride("9acme")).toBe("9acme"); // leading digit
  });
});

describe("saveDevExtensionsSettings normalization at save", () => {
  it("normalizes @Acme-Corp to acme-corp", () => {
    saveDevExtensionsSettings({ publishScopeOverride: "@Acme-Corp" });
    expect(getDevExtensionsSettings()).toEqual({ publishScopeOverride: "acme-corp" });
  });

  it("rejects invalid input at save time", () => {
    expect(() => saveDevExtensionsSettings({ publishScopeOverride: "acme/foo" })).toThrow();
  });
});

describe("readEffectivePublishScopeOverride", () => {
  it("returns the stored override in dev mode", () => {
    process.env.CINATRA_RUNTIME_MODE = "development";
    saveDevExtensionsSettings({ publishScopeOverride: "acme-corp" });
    expect(readEffectivePublishScopeOverride()).toBe("acme-corp");
  });

  it("returns null in prod mode regardless of stored value", () => {
    saveDevExtensionsSettings({ publishScopeOverride: "acme-corp" });
    process.env.CINATRA_RUNTIME_MODE = "production";
    expect(readEffectivePublishScopeOverride()).toBeNull();
  });

  it("returns null in dev mode when no override is stored", () => {
    process.env.CINATRA_RUNTIME_MODE = "development";
    expect(readEffectivePublishScopeOverride()).toBeNull();
  });

  it("returns null when CINATRA_RUNTIME_MODE is unset", () => {
    saveDevExtensionsSettings({ publishScopeOverride: "acme-corp" });
    delete process.env.CINATRA_RUNTIME_MODE;
    expect(readEffectivePublishScopeOverride()).toBeNull();
  });
});
