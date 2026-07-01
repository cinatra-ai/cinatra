import { describe, expect, it } from "vitest";

import { evaluateUserStoreMount } from "@/lib/boot/user-store-mount-check";
import { isDegradeProbeArmed } from "@/lib/boot/phases/boot-degrade-probe";

// ---------------------------------------------------------------------------
// User-store durable-mount check (cinatra#789 item 5) + degrade-probe arming
// (cinatra#789 item 1). The mount check WARNS clearly (never silent) but is
// non-deploy-blocking; the degrade probe is inert unless DOUBLE-armed.
// ---------------------------------------------------------------------------

const ROOT = "/data/extensions/packages";

describe("evaluateUserStoreMount", () => {
  it("ok when the store exists + is writable", () => {
    expect(evaluateUserStoreMount(ROOT, { exists: true, writable: true })).toEqual({ kind: "ok" });
  });

  it("missing with a clear message when the store does not exist", () => {
    const v = evaluateUserStoreMount(ROOT, { exists: false, writable: false });
    expect(v.kind).toBe("missing");
    if (v.kind === "missing") {
      expect(v.message).toMatch(/does not exist/);
      expect(v.message).toMatch(/LOST on restart/);
      expect(v.message).toContain(ROOT);
    }
  });

  it("not-writable with a clear message when the store exists but is read-only", () => {
    const v = evaluateUserStoreMount(ROOT, { exists: true, writable: false });
    expect(v.kind).toBe("not-writable");
    if (v.kind === "not-writable") {
      expect(v.message).toMatch(/NOT writable/);
    }
  });
});

describe("isDegradeProbeArmed (double opt-in — prod-safe)", () => {
  it("inert unless BOTH flags are set", () => {
    expect(isDegradeProbeArmed({})).toBe(false);
    expect(isDegradeProbeArmed({ CINATRA_BOOT_E2E: "1" })).toBe(false);
    expect(isDegradeProbeArmed({ CINATRA_BOOT_SIMULATE_DEGRADED: "1" })).toBe(false);
  });

  it("armed only when both are exactly '1'", () => {
    expect(
      isDegradeProbeArmed({ CINATRA_BOOT_E2E: "1", CINATRA_BOOT_SIMULATE_DEGRADED: "1" }),
    ).toBe(true);
    expect(
      isDegradeProbeArmed({ CINATRA_BOOT_E2E: "true", CINATRA_BOOT_SIMULATE_DEGRADED: "1" }),
    ).toBe(false);
  });
});
