// Org-scoped dashboard-lifecycle hook seam (cinatra#1628, S11a). Pins the
// globalThis-slot contract: no-op when unwired, fires with (package, org,
// transition) when wired, org-null no-op, best-effort (a throwing hook is
// swallowed so a committed archive/restore is never aborted).
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  setExtensionDashboardLifecycleHook,
  fireExtensionDashboardLifecycle,
} from "../dashboard-lifecycle-hook";

afterEach(() => setExtensionDashboardLifecycleHook(null));

describe("dashboard-lifecycle-hook — wiring seam", () => {
  it("is a no-op when no host hook is wired", async () => {
    await expect(
      fireExtensionDashboardLifecycle({
        packageName: "@cinatra-ai/x",
        organizationId: "org-1",
        transition: "archive",
      }),
    ).resolves.toBeUndefined();
  });

  it("fires the wired hook with the full (package, org, transition, actor) input", async () => {
    const calls: unknown[] = [];
    setExtensionDashboardLifecycleHook((input) => {
      calls.push(input);
    });
    await fireExtensionDashboardLifecycle({
      packageName: "@cinatra-ai/blog-content-workflow",
      organizationId: "org-42",
      transition: "archive",
      actorPrincipalId: "user-7",
    });
    expect(calls).toEqual([
      {
        packageName: "@cinatra-ai/blog-content-workflow",
        organizationId: "org-42",
        transition: "archive",
        actorPrincipalId: "user-7",
      },
    ]);
  });

  it("does NOT fire when organizationId is null/undefined (no org-scoped dashboards)", async () => {
    const hook = vi.fn();
    setExtensionDashboardLifecycleHook(hook);
    await fireExtensionDashboardLifecycle({ packageName: "@cinatra-ai/x", organizationId: null, transition: "restore" });
    await fireExtensionDashboardLifecycle({ packageName: "@cinatra-ai/x", organizationId: undefined, transition: "archive" });
    expect(hook).not.toHaveBeenCalled();
  });

  it("BEST-EFFORT: a throwing hook is swallowed (committed transition is never aborted)", async () => {
    setExtensionDashboardLifecycleHook(() => {
      throw new Error("transient dashboards DB error");
    });
    await expect(
      fireExtensionDashboardLifecycle({
        packageName: "@cinatra-ai/x",
        organizationId: "org-1",
        transition: "archive",
      }),
    ).resolves.toBeUndefined();
  });

  it("passes the restore transition through", async () => {
    const hook = vi.fn();
    setExtensionDashboardLifecycleHook(hook);
    await fireExtensionDashboardLifecycle({ packageName: "@cinatra-ai/x", organizationId: "o", transition: "restore" });
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ transition: "restore" }));
  });
});
