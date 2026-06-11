// Degraded-mode coverage for the CRM-integration background jobs
// (lazy/guarded host-access cutover): the dispatcher resolves the CRM
// surfaces through the capability registry at job time — with NO provider
// registered (crm-connector absent or not activated) the jobs degrade
// (warn/no-op + complete) instead of crashing the worker, and with a
// registered provider they route through it.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { processProjectionOutboxMock } = vi.hoisted(() => ({
  processProjectionOutboxMock: vi.fn(async () => ({ processed: 0, failed: 0 })),
}));

vi.mock("@cinatra-ai/objects/graphiti-projector", () => ({
  processProjectionOutbox: processProjectionOutboxMock,
}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  BACKGROUND_JOB_NAMES,
  __dispatchBackgroundJobForTests as dispatchBackgroundJob,
} from "@/lib/background-jobs";

function makeJob(name: string, data: unknown = {}, id = "test-job") {
  return {
    name,
    data,
    id,
    token: "test-token",
    moveToDelayed: vi.fn(),
  } as unknown as Parameters<typeof dispatchBackgroundJob>[0];
}

beforeEach(() => {
  __resetCapabilityRegistry();
  processProjectionOutboxMock.mockClear();
  vi.restoreAllMocks();
});

describe("TWENTY_POINTER_REPAIR through the crm-pointer-writer capability", () => {
  const payload = {
    type: "account" as const,
    externalId: "ext-1",
    name: "Acme",
    orgId: "org-1",
    userId: "user-1",
  };

  it("degrades (warn + complete, no throw) when no writer is registered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      dispatchBackgroundJob(makeJob(BACKGROUND_JOB_NAMES.TWENTY_POINTER_REPAIR, payload)),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("crm-pointer-writer");
  });

  it("writes through the registered capability provider", async () => {
    const writePointer = vi.fn(async () => {});
    registerCapabilityProvider("crm-pointer-writer", {
      packageName: "@v/crm-connector",
      impl: { writePointer },
    });
    await dispatchBackgroundJob(makeJob(BACKGROUND_JOB_NAMES.TWENTY_POINTER_REPAIR, payload));
    expect(writePointer).toHaveBeenCalledWith(payload);
  });

  it("a writer failure propagates (BullMQ attempts/backoff own transient retries)", async () => {
    registerCapabilityProvider("crm-pointer-writer", {
      packageName: "@v/crm-connector",
      impl: {
        writePointer: async () => {
          throw new Error("transient");
        },
      },
    });
    await expect(
      dispatchBackgroundJob(makeJob(BACKGROUND_JOB_NAMES.TWENTY_POINTER_REPAIR, payload)),
    ).rejects.toThrow("transient");
  });
});

describe("GRAPHITI_PROJECTION_REPAIR sync bootstrap through the crm-sync-bootstrap capability", () => {
  // NOTE on the degraded semantics asserted here: `processProjectionOutbox`
  // is mocked, so this covers the DISPATCHER's contract (cycle proceeds;
  // bootstrap ordering). The real projector's behavior with NO adapter
  // registered is documented at the dispatch site: adapter-owned rows fall
  // through to the GENERIC projection (terminal, no Twenty hydration) — the
  // accepted degraded mode for a genuinely absent crm-connector, pinned by
  // the projector's own routing tests in packages/objects.
  it("the outbox cycle still runs with no bootstrap registered (degraded, anonymous duplicate dies)", async () => {
    // Non-canonical job id → run once + return (no moveToDelayed path).
    await expect(
      dispatchBackgroundJob(
        makeJob(BACKGROUND_JOB_NAMES.GRAPHITI_PROJECTION_REPAIR, {}, "anonymous-duplicate"),
      ),
    ).resolves.toBeUndefined();
    expect(processProjectionOutboxMock).toHaveBeenCalledTimes(1);
  });

  it("invokes the registered sync bootstrap before processing the outbox", async () => {
    const calls: string[] = [];
    registerCapabilityProvider("crm-sync-bootstrap", {
      packageName: "@v/crm-connector",
      impl: { ensureSyncRegistrations: () => calls.push("bootstrap") },
    });
    processProjectionOutboxMock.mockImplementationOnce(async () => {
      calls.push("outbox");
      return { processed: 0, failed: 0 };
    });
    await dispatchBackgroundJob(
      makeJob(BACKGROUND_JOB_NAMES.GRAPHITI_PROJECTION_REPAIR, {}, "anonymous-duplicate"),
    );
    expect(calls).toEqual(["bootstrap", "outbox"]);
  });
});
