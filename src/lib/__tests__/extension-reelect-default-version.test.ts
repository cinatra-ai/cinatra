import { describe, it, expect, vi } from "vitest";
import { reelectDefaultVersion } from "@/lib/extension-runtime-activate";
import type { ActivationResult } from "@cinatra-ai/sdk-extensions";

// cinatra#1040 S4 acceptance scenario 4 — ATOMIC default re-election. The
// transition reuses the hot-update invariants: verify the new default BEFORE
// teardown (no strand), teardown EVERY global registry, re-activate multi-version,
// and roll back to the prior default if the post-teardown activation fails. Driven
// here at the seam via injected deps (no store / DB / boot).

const registered = (pkg: string): ActivationResult[] => [{ packageName: pkg, status: "registered" }];
const failed = (pkg: string): ActivationResult[] => [{ packageName: pkg, status: "failed", reason: "register-threw" }];

describe("reelectDefaultVersion (cinatra#1040 S4)", () => {
  it("ABORTS before teardown when the new default is not activatable (no strand — old registrations intact)", async () => {
    const teardown = vi.fn();
    const activate = vi.fn(async () => registered("@x/p"));
    const res = await reelectDefaultVersion("@x/p", {
      preVerify: async () => ({ ok: false, reason: "register-threw" }),
      teardown,
      activate,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("register-threw");
    expect(teardown).not.toHaveBeenCalled(); // nothing torn down → old default still live
    expect(activate).not.toHaveBeenCalled();
  });

  it("tears down every registry THEN re-activates multi-version on success", async () => {
    const order: string[] = [];
    const teardown = vi.fn(() => void order.push("teardown"));
    const activate = vi.fn(async () => {
      order.push("activate");
      return registered("@x/p");
    });
    const res = await reelectDefaultVersion("@x/p", {
      preVerify: async () => ({ ok: true }),
      teardown,
      activate,
    });
    expect(res.ok).toBe(true);
    expect(teardown).toHaveBeenCalledWith("@x/p");
    expect(activate).toHaveBeenCalledWith("@x/p");
    // Teardown strictly precedes re-activation.
    expect(order).toEqual(["teardown", "activate"]);
  });

  it("rolls back to the prior default when the post-teardown activation FAILS", async () => {
    const reactivatePriorDefault = vi.fn();
    const res = await reelectDefaultVersion("@x/p", {
      preVerify: async () => ({ ok: true }),
      teardown: vi.fn(),
      activate: async () => failed("@x/p"),
      reactivatePriorDefault,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("new-default-activation-failed");
    expect(reactivatePriorDefault).toHaveBeenCalledTimes(1);
  });

  it("treats an activation that never registers the package as a failure (rollback)", async () => {
    const reactivatePriorDefault = vi.fn();
    const res = await reelectDefaultVersion("@x/p", {
      preVerify: async () => ({ ok: true }),
      teardown: vi.fn(),
      activate: async () => [], // nothing activated
      reactivatePriorDefault,
    });
    expect(res.ok).toBe(false);
    expect(reactivatePriorDefault).toHaveBeenCalled();
  });
});
