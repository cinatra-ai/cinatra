// Unit tests for the assistant handle registry primitives (cinatra#1037 P1.2):
// the pure `normalizeAssistantHandle` normalizer and the `assistantHandles`
// drizzle table shape. The DB-touching helpers (registerAssistantHandle /
// resolveAssistantHandles / backfillMissingAssistantHandles) are exercised on the
// real surface via the verify-stack boot proof; the collision/backfill SQL is
// pinned by migration-assistant-handle-registry-core0046.test.ts.

import { describe, it, expect } from "vitest";

describe("normalizeAssistantHandle", () => {
  it("passes an already-clean handle through unchanged", async () => {
    const { normalizeAssistantHandle } = await import("@/lib/better-auth-db");
    expect(normalizeAssistantHandle("cinatra")).toBe("cinatra");
    expect(normalizeAssistantHandle("wp-content-editor")).toBe("wp-content-editor");
  });

  it("lowercases, collapses whitespace runs to a single underscore", async () => {
    const { normalizeAssistantHandle } = await import("@/lib/better-auth-db");
    expect(normalizeAssistantHandle("WordPress Content Editor")).toBe("wordpress_content_editor");
    expect(normalizeAssistantHandle("a b  c")).toBe("a_b_c");
  });

  it("strips characters outside [a-z0-9_-] and trims leading/trailing [_-]", async () => {
    const { normalizeAssistantHandle } = await import("@/lib/better-auth-db");
    expect(normalizeAssistantHandle("  @Foo!!  ")).toBe("foo");
    expect(normalizeAssistantHandle("_bar_")).toBe("bar");
    expect(normalizeAssistantHandle("café-bot")).toBe("caf-bot");
  });

  it("returns null when nothing valid survives", async () => {
    const { normalizeAssistantHandle } = await import("@/lib/better-auth-db");
    expect(normalizeAssistantHandle("___")).toBeNull();
    expect(normalizeAssistantHandle("!!!")).toBeNull();
    expect(normalizeAssistantHandle("")).toBeNull();
    expect(normalizeAssistantHandle(null)).toBeNull();
    expect(normalizeAssistantHandle(undefined)).toBeNull();
  });
});

describe("assistantHandles table shape", () => {
  it("exposes the registry columns (1:1 principal key, handle, override, origin/package, timestamps)", async () => {
    const mod = await import("@/lib/better-auth-db");
    const { getTableColumns } = await import("drizzle-orm");
    const names = Object.keys(getTableColumns(mod.assistantHandles)).sort();
    // origin + packageName added by cinatra#1874 W1 (extension vs standalone
    // provenance + the owning package link).
    expect(names).toEqual([
      "assistantUserId",
      "createdAt",
      "handle",
      "isOverride",
      "origin",
      "packageName",
      "updatedAt",
    ]);
  });
});
