import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Actor, PackageRef } from "@cinatra-ai/extension-types";

// cinatra#1276 — the hard-delete uninstall branch persists the SAME richer
// provenance row forceDelete writes. This suite pins that the shared helper
// accepts the new "uninstall" operation and writes a durable audit row with a
// RESOLVED actor identity (userId preferred; "system:<source>" sentinel fallback).

// Intercept the durable insert so no live DB is needed. The @/lib/database
// specifier resolves via the package vitest alias; vi.mock overrides it.
vi.mock("@/lib/database", () => ({
  insertExtensionLifecycleAudit: vi.fn(async () => {}),
}));

import { writeExtensionLifecycleAuditEntry } from "../audit-log";
import { insertExtensionLifecycleAudit } from "@/lib/database";

const ref: PackageRef = {
  registryUrl: "https://registry.example.com",
  packageName: "@acme/never-used-ext",
  version: "2.1.0",
};

const dangling = {
  agent_runs_count: 0,
  agent_runs_count_capped: false,
  dependent_extensions: [],
  dependent_extensions_capped: false,
};

describe("writeExtensionLifecycleAuditEntry — uninstall provenance (#1276)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists an uninstall row with the resolved userId identity, snapshot, and dangling refs", async () => {
    const actor: Actor = { actorType: "human", userId: "user-42", source: "ui" };
    const snapshot = { id: "tpl-x", packageName: ref.packageName };

    await writeExtensionLifecycleAuditEntry({
      actor,
      operation: "uninstall",
      packageRef: ref,
      destroyedRowSnapshot: snapshot,
      danglingReferences: dangling,
      reason: "platform_admin hard-delete uninstall",
    });

    expect(insertExtensionLifecycleAudit).toHaveBeenCalledTimes(1);
    expect(insertExtensionLifecycleAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user-42",
        actorType: "human",
        operation: "uninstall",
        packageName: ref.packageName,
        packageVersion: "2.1.0",
        destroyedRowSnapshot: snapshot,
        danglingReferences: dangling,
        reason: "platform_admin hard-delete uninstall",
      }),
    );
    // A durable, unique row id is minted per entry.
    const row = (insertExtensionLifecycleAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBeGreaterThan(0);
  });

  it("falls back to a system:<source> sentinel identity when the actor has no userId", async () => {
    // No userId → the helper resolves a clearly-marked system:<source> sentinel.
    const actor: Actor = { actorType: "system", source: "worker" };

    await writeExtensionLifecycleAuditEntry({
      actor,
      operation: "uninstall",
      packageRef: ref,
      destroyedRowSnapshot: null,
      danglingReferences: dangling,
    });

    expect(insertExtensionLifecycleAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "system:worker",
        operation: "uninstall",
        destroyedRowSnapshot: null,
        reason: null,
      }),
    );
  });
});
