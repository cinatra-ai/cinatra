import { describe, it, expect, vi, beforeEach } from "vitest";

// Focused unit test for the `@cinatra-ai/host:anthropic-skill-config` host
// capability impl (createAnthropicSkillConfigCapability) that the
// anthropic-connector Skills tab resolves + calls (anthropic-connector#44,
// paired with cinatra#1104). Exercised in isolation — no heavy boot binder — by
// mocking the canonical DB accessors, the admin gate, and the sync/GC/notify
// services the migrated write path composes.

const h = vi.hoisted(() => ({
  // Stand-in for the single canonical connector-config row the ~7 core
  // consumers read (the store ignores packageId — it IS the global key).
  stored: { value: undefined as unknown },
  dbWrites: [] as boolean[],
  requireAdminSession: vi.fn(),
  syncCatalogSkillsToAnthropic: vi.fn(),
  reclaimStaleAnthropicSkills: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/database", () => ({
  // Mirrors the real fail-closed reader: only a primitive `true` reads ON.
  readAnthropicSkillSyncEnabledFromDatabase: () => h.stored.value === true,
  writeAnthropicSkillSyncEnabledToDatabase: (enabled: boolean) => {
    h.dbWrites.push(enabled);
    h.stored.value = enabled === true;
  },
}));
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: (...a: unknown[]) => h.requireAdminSession(...a),
}));
vi.mock("@/lib/anthropic-skill-sync-service", () => ({
  syncCatalogSkillsToAnthropic: (...a: unknown[]) => h.syncCatalogSkillsToAnthropic(...a),
}));
vi.mock("@/lib/anthropic-skill-gc-service", () => ({
  reclaimStaleAnthropicSkills: (...a: unknown[]) => h.reclaimStaleAnthropicSkills(...a),
}));
vi.mock("@/lib/notifications", () => ({
  createNotification: (...a: unknown[]) => h.createNotification(...a),
}));

import { createAnthropicSkillConfigCapability } from "@/lib/anthropic-skill-config-service";

describe("@cinatra-ai/host:anthropic-skill-config capability", () => {
  beforeEach(() => {
    h.stored.value = undefined;
    h.dbWrites.length = 0;
    h.requireAdminSession.mockReset().mockResolvedValue({ user: { id: "admin-1" } });
    h.syncCatalogSkillsToAnthropic.mockReset().mockResolvedValue({ ok: true });
    h.reclaimStaleAnthropicSkills.mockReset().mockResolvedValue({ ok: true, errors: [] });
    h.createNotification.mockReset().mockResolvedValue(undefined);
  });

  it("exposes the { read, write } functions the connector's structural guard requires", () => {
    const cap = createAnthropicSkillConfigCapability();
    expect(typeof cap.read).toBe("function");
    expect(typeof cap.write).toBe("function");
  });

  it("read() mirrors the canonical fail-closed reader (=== true)", () => {
    const cap = createAnthropicSkillConfigCapability();
    expect(cap.read()).toBe(false); // default OFF
    h.stored.value = true;
    expect(cap.read()).toBe(true);
    h.stored.value = "true"; // tampered/garbage string → fail-closed OFF
    expect(cap.read()).toBe(false);
  });

  it("write(true) admin-gates, persists a primitive true to the canonical key, then runs eager sync + GC", async () => {
    const cap = createAnthropicSkillConfigCapability();
    await cap.write(true);
    expect(h.requireAdminSession).toHaveBeenCalledTimes(1);
    expect(h.dbWrites).toEqual([true]);
    expect(h.stored.value).toBe(true);
    // a core reader observes the SAME value written through the capability
    expect(cap.read()).toBe(true);
    expect(h.syncCatalogSkillsToAnthropic).toHaveBeenCalledTimes(1);
    expect(h.reclaimStaleAnthropicSkills).toHaveBeenCalledTimes(1);
  });

  it("write(false) admin-gates, persists false, and still runs the orchestration path (inert-when-OFF lives in the services)", async () => {
    h.stored.value = true;
    const cap = createAnthropicSkillConfigCapability();
    await cap.write(false);
    expect(h.requireAdminSession).toHaveBeenCalledTimes(1);
    expect(h.dbWrites).toEqual([false]);
    expect(h.stored.value).toBe(false);
    expect(cap.read()).toBe(false);
    expect(h.syncCatalogSkillsToAnthropic).toHaveBeenCalledTimes(1);
    expect(h.reclaimStaleAnthropicSkills).toHaveBeenCalledTimes(1);
  });

  it("is fail-closed: a non-admin write throws and never persists or orchestrates", async () => {
    h.requireAdminSession.mockRejectedValue(new Error("admin session required"));
    const cap = createAnthropicSkillConfigCapability();
    await expect(cap.write(true)).rejects.toThrow("admin session required");
    expect(h.dbWrites).toEqual([]);
    expect(h.stored.value).toBe(undefined);
    expect(h.syncCatalogSkillsToAnthropic).not.toHaveBeenCalled();
    expect(h.reclaimStaleAnthropicSkills).not.toHaveBeenCalled();
  });

  it("a sync failure notifies the admin, does NOT roll back the persisted opt-in, and GC still runs", async () => {
    h.syncCatalogSkillsToAnthropic.mockRejectedValue(new Error("boom"));
    const cap = createAnthropicSkillConfigCapability();
    await cap.write(true);
    expect(h.stored.value).toBe(true); // save survived the sync failure
    expect(h.createNotification).toHaveBeenCalled();
    expect(h.reclaimStaleAnthropicSkills).toHaveBeenCalledTimes(1);
  });

  it("a non-ok sync result notifies the admin without throwing", async () => {
    h.syncCatalogSkillsToAnthropic.mockResolvedValue({
      ok: false,
      namespaceError: "namespace not configured",
    });
    const cap = createAnthropicSkillConfigCapability();
    await cap.write(true);
    expect(h.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error" }),
    );
    expect(h.stored.value).toBe(true);
  });
});
