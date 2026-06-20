// Host PM bridge (cinatra#317) — the schedule↔PM-task sync indirection
// packages/agents calls OUT to via "@/lib/pm-integration-providers". Proves the
// fail-open contract: no provider → no-op; success → records the task id; a
// provider/store outage → logs + records the error and NEVER throws (the local
// schedule is authoritative). Mirrors the CRM bridge's resolution semantics.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the SDK provider registry — the bridge resolves the live PM provider
// through lookupPmProvider / listPmProviders.
const lookupPmProvider = vi.fn();
const listPmProviders = vi.fn();
vi.mock("@cinatra-ai/sdk-extensions", () => ({
  lookupPmProvider: (...a: unknown[]) => lookupPmProvider(...a),
  listPmProviders: (...a: unknown[]) => listPmProviders(...a),
}));
vi.mock("@cinatra-ai/sdk-extensions/internal", () => ({
  PM_PROVIDER_CAPABILITY: "pm-provider",
}));

// Mock the agents pm-link-store — the bridge persists the mirror outcome here.
const readPmLinkByRunId = vi.fn();
const recordPmLinkSuccess = vi.fn();
const recordPmLinkError = vi.fn();
const deletePmLinkByRunId = vi.fn();
vi.mock("@cinatra-ai/agents/pm-link-store", () => ({
  readPmLinkByRunId: (...a: unknown[]) => readPmLinkByRunId(...a),
  recordPmLinkSuccess: (...a: unknown[]) => recordPmLinkSuccess(...a),
  recordPmLinkError: (...a: unknown[]) => recordPmLinkError(...a),
  deletePmLinkByRunId: (...a: unknown[]) => deletePmLinkByRunId(...a),
}));

// server-only is a runtime no-op marker; stub it for the node test env.
vi.mock("server-only", () => ({}));

import {
  syncRunTriggerPmTask,
  deleteRunTriggerPmTask,
} from "../pm-integration-providers";

function fakeProvider(overrides: Partial<{
  providerId: string;
  upsertTriggerTask: ReturnType<typeof vi.fn>;
  deleteTriggerTask: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    providerId: overrides.providerId ?? "plane",
    upsertTriggerTask:
      overrides.upsertTriggerTask ??
      vi.fn(async () => ({ externalTaskId: "wi-1", providerId: "plane" })),
    deleteTriggerTask: overrides.deleteTriggerTask ?? vi.fn(async () => {}),
  };
}

const baseTrigger = {
  runId: "run-1",
  triggerType: "scheduled",
  scheduledAt: "2026-06-25T09:00:00.000Z",
  cronExpression: null,
  timezone: "UTC",
  enabled: true,
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  readPmLinkByRunId.mockResolvedValue(null);
  recordPmLinkSuccess.mockResolvedValue(undefined);
  recordPmLinkError.mockResolvedValue(undefined);
  deletePmLinkByRunId.mockResolvedValue(undefined);
  lookupPmProvider.mockReturnValue(null);
  listPmProviders.mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("syncRunTriggerPmTask", () => {
  it("no provider registered → no-op (never throws, no record)", async () => {
    listPmProviders.mockReturnValue([]);
    await expect(syncRunTriggerPmTask(baseTrigger)).resolves.toBeUndefined();
    expect(recordPmLinkSuccess).not.toHaveBeenCalled();
    expect(recordPmLinkError).not.toHaveBeenCalled();
  });

  it("first push (no existing link) → upsert create + record success", async () => {
    const provider = fakeProvider();
    listPmProviders.mockReturnValue([provider]);
    await syncRunTriggerPmTask(baseTrigger);
    expect(provider.upsertTriggerTask).toHaveBeenCalledWith({
      task: {
        runId: "run-1",
        triggerType: "scheduled",
        scheduledAt: "2026-06-25T09:00:00.000Z",
        cronExpression: null,
        timezone: "UTC",
        enabled: true,
      },
      existingTaskId: null,
    });
    expect(recordPmLinkSuccess).toHaveBeenCalledWith({
      runId: "run-1",
      provider: "plane",
      externalTaskId: "wi-1",
    });
  });

  it("existing link → upsert update passes the prior external id, prefers the link provider", async () => {
    readPmLinkByRunId.mockResolvedValue({
      runId: "run-1",
      provider: "plane",
      externalTaskId: "wi-existing",
    });
    const provider = fakeProvider();
    lookupPmProvider.mockReturnValue(provider);
    await syncRunTriggerPmTask(baseTrigger);
    expect(lookupPmProvider).toHaveBeenCalledWith("plane");
    expect(provider.upsertTriggerTask).toHaveBeenCalledWith(
      expect.objectContaining({ existingTaskId: "wi-existing" }),
    );
  });

  it("provider throws → fail-open: records error, NEVER throws", async () => {
    const provider = fakeProvider({
      upsertTriggerTask: vi.fn(async () => {
        throw new Error("plane down");
      }),
    });
    listPmProviders.mockReturnValue([provider]);
    await expect(syncRunTriggerPmTask(baseTrigger)).resolves.toBeUndefined();
    expect(recordPmLinkError).toHaveBeenCalledWith({
      runId: "run-1",
      provider: "plane",
      syncError: "plane down",
    });
    expect(recordPmLinkSuccess).not.toHaveBeenCalled();
  });

  it("link-read FAILURE → SKIPS the PM sync entirely (codex#317: unknown prior state, never address the wrong provider)", async () => {
    readPmLinkByRunId.mockRejectedValue(new Error("db blip"));
    const provider = fakeProvider();
    listPmProviders.mockReturnValue([provider]);
    await expect(syncRunTriggerPmTask(baseTrigger)).resolves.toBeUndefined();
    // Do NOT push to any provider, and do NOT touch the link store — the prior
    // mirror state is unknown; the reconcile loop repairs the missed mirror.
    expect(provider.upsertTriggerTask).not.toHaveBeenCalled();
    expect(recordPmLinkSuccess).not.toHaveBeenCalled();
    expect(recordPmLinkError).not.toHaveBeenCalled();
  });

  it("provider that never settles → bounded timeout fail-open: records error, never throws (codex#317 caveat)", async () => {
    vi.useFakeTimers();
    try {
      const provider = fakeProvider({
        // Never resolves — simulates a hung HTTP call.
        upsertTriggerTask: vi.fn(() => new Promise(() => {})),
      });
      listPmProviders.mockReturnValue([provider]);
      const p = syncRunTriggerPmTask(baseTrigger);
      // Advance past the host's bounded ceiling.
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(p).resolves.toBeUndefined();
      expect(recordPmLinkError).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-1", provider: "plane" }),
      );
      expect(recordPmLinkSuccess).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("deleteRunTriggerPmTask", () => {
  it("no existing link → no-op (nothing to delete)", async () => {
    readPmLinkByRunId.mockResolvedValue(null);
    await expect(
      deleteRunTriggerPmTask({ runId: "run-1" }),
    ).resolves.toBeUndefined();
    expect(deletePmLinkByRunId).not.toHaveBeenCalled();
  });

  it("existing task + provider → deletes upstream then drops the link row", async () => {
    readPmLinkByRunId.mockResolvedValue({
      runId: "run-1",
      provider: "plane",
      externalTaskId: "wi-1",
    });
    const provider = fakeProvider();
    lookupPmProvider.mockReturnValue(provider);
    await deleteRunTriggerPmTask({ runId: "run-1" });
    expect(provider.deleteTriggerTask).toHaveBeenCalledWith({
      runId: "run-1",
      externalTaskId: "wi-1",
    });
    expect(deletePmLinkByRunId).toHaveBeenCalledWith("run-1");
  });

  it("provider delete throws → leaves the link row for reconcile, never throws", async () => {
    readPmLinkByRunId.mockResolvedValue({
      runId: "run-1",
      provider: "plane",
      externalTaskId: "wi-1",
    });
    const provider = fakeProvider({
      deleteTriggerTask: vi.fn(async () => {
        throw new Error("plane down");
      }),
    });
    lookupPmProvider.mockReturnValue(provider);
    await expect(
      deleteRunTriggerPmTask({ runId: "run-1" }),
    ).resolves.toBeUndefined();
    expect(deletePmLinkByRunId).not.toHaveBeenCalled();
  });

  it("residual external task but no provider registered → KEEPS the link row for reconcile (codex#317)", async () => {
    readPmLinkByRunId.mockResolvedValue({
      runId: "run-1",
      provider: "plane",
      externalTaskId: "wi-1",
    });
    lookupPmProvider.mockReturnValue(null);
    listPmProviders.mockReturnValue([]);
    await expect(
      deleteRunTriggerPmTask({ runId: "run-1" }),
    ).resolves.toBeUndefined();
    // The cleanup pointer must NOT be orphaned — leave the row for #318.
    expect(deletePmLinkByRunId).not.toHaveBeenCalled();
  });

  it("null task id WITH a sync_error (errored/timed-out push, unknown upstream) → KEEPS the row (codex#317)", async () => {
    // A timed-out first push may have STILL created a Plane task the host never
    // observed — dropping the row would orphan it. Leave it for reconcile.
    readPmLinkByRunId.mockResolvedValue({
      runId: "run-1",
      provider: "plane",
      externalTaskId: null,
      syncError: "upsert timed out after 10000ms",
    });
    await expect(
      deleteRunTriggerPmTask({ runId: "run-1" }),
    ).resolves.toBeUndefined();
    expect(deletePmLinkByRunId).not.toHaveBeenCalled();
    expect(lookupPmProvider).not.toHaveBeenCalled();
  });

  it("null task id AND no sync_error (provably never attempted) → drops the row outright", async () => {
    readPmLinkByRunId.mockResolvedValue({
      runId: "run-1",
      provider: "plane",
      externalTaskId: null,
      syncError: null,
    });
    await deleteRunTriggerPmTask({ runId: "run-1" });
    expect(deletePmLinkByRunId).toHaveBeenCalledWith("run-1");
    expect(lookupPmProvider).not.toHaveBeenCalled();
  });
});
