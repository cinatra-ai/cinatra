import { describe, it, expect, beforeEach } from "vitest";
import {
  requireExtensionAction,
  setExtensionActionGuard,
  _resetExtensionActionGuardForTests,
} from "../action-guard";

describe("requireExtensionAction — host-injected, fail-closed guard", () => {
  beforeEach(() => {
    _resetExtensionActionGuardForTests();
  });

  it("fails CLOSED (throws) when the host has not wired a guard", async () => {
    await expect(requireExtensionAction("@cinatra-ai/apify-connector", "manage")).rejects.toThrow(
      /wired the action guard/,
    );
  });

  it("delegates to the wired guard with the exact packageId + mode", async () => {
    const calls: Array<{ packageId: string; mode: string }> = [];
    setExtensionActionGuard(async (packageId, mode) => {
      calls.push({ packageId, mode });
    });
    await requireExtensionAction("@cinatra-ai/tailscale-connector", "manage");
    await requireExtensionAction("@cinatra-ai/twenty-connector", "read");
    expect(calls).toEqual([
      { packageId: "@cinatra-ai/tailscale-connector", mode: "manage" },
      { packageId: "@cinatra-ai/twenty-connector", mode: "read" },
    ]);
  });

  it("defaults to the strict 'manage' mode when mode is omitted (fail-safe toward restriction)", async () => {
    const modes: string[] = [];
    setExtensionActionGuard(async (_pkg, mode) => {
      modes.push(mode);
    });
    await requireExtensionAction("@cinatra-ai/apify-connector");
    expect(modes).toEqual(["manage"]);
  });

  it("propagates the guard's rejection (deny path surfaces to the caller)", async () => {
    setExtensionActionGuard(async () => {
      throw new Error("DENIED");
    });
    await expect(requireExtensionAction("@cinatra-ai/apify-connector", "manage")).rejects.toThrow("DENIED");
  });
});
