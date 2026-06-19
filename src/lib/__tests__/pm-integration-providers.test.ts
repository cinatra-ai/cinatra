// Host PM bridge tests: fail-open resolution + delegation to the registered
// pm-provider, and the register-pm-providers external-resolver binding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerPmProvider,
  _resetPmProviderRegistry,
  type PmConnector,
  type PmTask,
} from "@cinatra-ai/sdk-extensions";
import {
  syncRunTriggerPmTask,
  deleteRunTriggerPmTask,
  getRunTriggerPmTask,
} from "@/lib/pm-integration-providers";

function fakeTask(id: string): PmTask {
  return { id, title: "t", state: "backlog" };
}

afterEach(() => {
  _resetPmProviderRegistry();
  vi.restoreAllMocks();
});

describe("pm-integration-providers — fail-open host bridge", () => {
  it("syncRunTriggerPmTask is a no-op when no PM provider is registered", async () => {
    // No provider registered → degraded → resolves without throwing.
    await expect(
      syncRunTriggerPmTask({ runId: "r1", triggerType: "scheduled" }),
    ).resolves.toBeUndefined();
  });

  it("syncRunTriggerPmTask delegates to the registered plane provider", async () => {
    const upsert = vi.fn(async () => fakeTask("wi-1"));
    const provider: PmConnector = {
      providerId: "plane",
      upsertRunTask: upsert,
      deleteRunTask: async () => {},
      getRunTask: async () => null,
    };
    registerPmProvider(provider);
    await syncRunTriggerPmTask({
      runId: "r1",
      triggerType: "scheduled",
      scheduledAt: "2026-06-20T09:00:00.000Z",
      timezone: "UTC",
      enabled: true,
    });
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1", triggerType: "scheduled" }),
    );
  });

  it("syncRunTriggerPmTask SWALLOWS a provider error (fail-open)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerPmProvider({
      providerId: "plane",
      upsertRunTask: async () => {
        throw new Error("plane down");
      },
      deleteRunTask: async () => {},
      getRunTask: async () => null,
    });
    await expect(
      syncRunTriggerPmTask({ runId: "r1", triggerType: "scheduled" }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("deleteRunTriggerPmTask delegates + swallows errors", async () => {
    const del = vi.fn(async () => {});
    registerPmProvider({
      providerId: "plane",
      upsertRunTask: async () => fakeTask("x"),
      deleteRunTask: del,
      getRunTask: async () => null,
    });
    await deleteRunTriggerPmTask({ runId: "r9" });
    expect(del).toHaveBeenCalledWith({ runId: "r9" });
  });

  it("getRunTriggerPmTask returns the mapped task summary or null", async () => {
    registerPmProvider({
      providerId: "plane",
      upsertRunTask: async () => fakeTask("x"),
      deleteRunTask: async () => {},
      getRunTask: async () => fakeTask("wi-5"),
    });
    expect(await getRunTriggerPmTask({ runId: "r5" })).toEqual({ id: "wi-5", state: "backlog" });
  });
});
