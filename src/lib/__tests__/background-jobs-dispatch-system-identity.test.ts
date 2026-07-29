// cinatra#1941 S2 — dispatcher identity/frame integration test. Drives
// `dispatchBackgroundJob` (the OUTER dispatch function, exposed for tests as
// `__dispatchBackgroundJobForS2Tests`) with `dispatchRegisteredJob` mocked so
// each case can observe the ActorContext / job-dispatch-frame the HANDLER
// would have seen, without standing up a real registered handler:
//   - a system-maintenance job with NO payload context dispatches under a
//     freshly-minted System ActorContext (the feature);
//   - a job carrying a HumanUser payload __actorContext is byte-identical to
//     pre-S2 behavior, for BOTH system-maintenance and non-system kinds;
//   - a system-maintenance job carrying a non-HumanUser payload context is
//     still HONORED as today, with an anomaly audit row + warn (no behavior
//     change — visibility only);
//   - a system-maintenance job dispatched with the job-system runtime slot
//     EMPTY still dispatches (never refuses — see design doc §3.2), with a
//     loud warn.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/notifications-host", () => ({}));
vi.mock("@/lib/register-run-wait-notifier", () => ({}));
vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: vi.fn(() => ({})),
  writeMetadataValueToDatabase: vi.fn(),
}));
vi.mock("@/lib/background-jobs-notify", () => ({
  notifyJobLifecycle: vi.fn(async () => undefined),
  notifyJobStarted: vi.fn(async () => undefined),
}));

const SYSTEM_MAINTENANCE_JOB = "TEST_SYSTEM_MAINTENANCE_JOB";
const GRANDFATHERED_JOB = "TEST_GRANDFATHERED_JOB";

const { dispatchRegisteredJobMock, UnclassifiedBackgroundJobErrorStub } = vi.hoisted(() => {
  class UnclassifiedBackgroundJobErrorStub extends Error {
    constructor(public readonly jobName: string) {
      super(`unclassified: ${jobName}`);
      this.name = "UnclassifiedBackgroundJobError";
    }
  }
  return {
    dispatchRegisteredJobMock: vi.fn(async () => undefined),
    UnclassifiedBackgroundJobErrorStub,
  };
});

vi.mock("@/lib/background-jobs-registry", () => ({
  BACKGROUND_JOB_REGISTRY: {
    [SYSTEM_MAINTENANCE_JOB]: {
      authority: {
        authorityKind: "system-maintenance",
        actorSource: "dispatcher-system-identity",
        orgExtractor: { source: "row-sweep", note: "test sweep" },
        capabilities: ["content.write"],
      },
    },
    [GRANDFATHERED_JOB]: {
      authority: {
        authorityKind: "grandfathered-run",
        actorSource: "run-row",
        orgExtractor: { source: "run-row" },
        runExtractor: { source: "payload", field: "runId" },
        capabilities: ["run.execute", "run.complete"],
        allowedPurposes: ["agent-run-dispatch"],
      },
    },
  },
  dispatchRegisteredJob: dispatchRegisteredJobMock,
  UnclassifiedBackgroundJobError: UnclassifiedBackgroundJobErrorStub,
}));

import { getActorContext } from "@cinatra-ai/llm/actor-context";
import { __dispatchBackgroundJobForS2Tests } from "@/lib/background-jobs";

type FakeJob = { name: string; id: string; data: Record<string, unknown> };

function makeJob(name: string, data: Record<string, unknown> = {}): FakeJob {
  return { name, id: "job-1", data };
}

// Typed `unknown` deliberately: the production reader casts the slot to its
// own structural type at the read site, so the test writes its typed vi.fn
// mock object here without re-declaring the (generic) runtime signature — a
// Mock<> cannot satisfy the generic `runWithJobFrame<T>` shape directly.
const globalSlot = globalThis as unknown as { __cinatraJobSystemRuntime?: unknown };
const priorSlot = globalSlot.__cinatraJobSystemRuntime;

function installRuntimeSlot() {
  const runtime = {
    runWithJobFrame: vi.fn((_frame: unknown, fn: () => unknown) => fn()),
    buildSystemIdentity: vi.fn((jobName: string, jobId: string) => ({
      principalType: "System",
      principalId: `background-job:${jobName}:${jobId}`,
      authSource: "worker",
      policyVersion: "v2",
    })),
    auditUnclassifiedRefusal: vi.fn(),
    auditFrameAnomaly: vi.fn(),
  };
  globalSlot.__cinatraJobSystemRuntime = runtime;
  return runtime;
}

function removeRuntimeSlot() {
  delete globalSlot.__cinatraJobSystemRuntime;
}

beforeEach(() => {
  dispatchRegisteredJobMock.mockClear();
  dispatchRegisteredJobMock.mockImplementation(async () => undefined);
});

afterEach(() => {
  globalSlot.__cinatraJobSystemRuntime = priorSlot;
  vi.restoreAllMocks();
});

describe("system-maintenance job with NO payload context — the S2 feature", () => {
  it("dispatches under the freshly-minted System ActorContext the runtime slot builds", async () => {
    const runtime = installRuntimeSlot();
    let observedCtx: unknown;
    dispatchRegisteredJobMock.mockImplementationOnce(async () => {
      observedCtx = getActorContext();
    });

    await __dispatchBackgroundJobForS2Tests(makeJob(SYSTEM_MAINTENANCE_JOB) as never);

    expect(runtime.buildSystemIdentity).toHaveBeenCalledWith(SYSTEM_MAINTENANCE_JOB, "job-1");
    expect(observedCtx).toEqual({
      principalType: "System",
      principalId: `background-job:${SYSTEM_MAINTENANCE_JOB}:job-1`,
      authSource: "worker",
      policyVersion: "v2",
    });
  });

  it("also frames a grandfathered-run job, but mints NO System identity for it (actor stays run-row-anchored, not dispatcher-minted)", async () => {
    const runtime = installRuntimeSlot();
    let observedCtx: unknown;
    dispatchRegisteredJobMock.mockImplementationOnce(async () => {
      observedCtx = getActorContext();
    });

    await __dispatchBackgroundJobForS2Tests(
      makeJob(GRANDFATHERED_JOB, { runId: "run-1" }) as never,
    );

    expect(runtime.buildSystemIdentity).not.toHaveBeenCalled();
    expect(runtime.runWithJobFrame).toHaveBeenCalled();
    expect(observedCtx).toBeUndefined();
  });
});

describe("HumanUser payload context — byte-identical regression", () => {
  it("a job carrying __actorContext dispatches under that EXACT context, unchanged", async () => {
    installRuntimeSlot();
    const humanCtx = {
      principalType: "HumanUser",
      principalId: "user-1",
      authSource: "ui",
      policyVersion: "v2",
    };
    let observedCtx: unknown;
    dispatchRegisteredJobMock.mockImplementationOnce(async () => {
      observedCtx = getActorContext();
    });

    await __dispatchBackgroundJobForS2Tests(
      makeJob(SYSTEM_MAINTENANCE_JOB, { __actorContext: humanCtx }) as never,
    );

    expect(observedCtx).toEqual(humanCtx);
  });

  it("holds even with the job-system runtime slot EMPTY (HumanUser flows never touch the slot)", async () => {
    removeRuntimeSlot();
    const humanCtx = {
      principalType: "HumanUser",
      principalId: "user-1",
      authSource: "ui",
      policyVersion: "v2",
    };
    let observedCtx: unknown;
    dispatchRegisteredJobMock.mockImplementationOnce(async () => {
      observedCtx = getActorContext();
    });

    await __dispatchBackgroundJobForS2Tests(
      makeJob(SYSTEM_MAINTENANCE_JOB, { __actorContext: humanCtx }) as never,
    );

    expect(observedCtx).toEqual(humanCtx);
  });
});

describe("anomaly telemetry (§3.1 rule 2) — no behavior change", () => {
  it("a system-maintenance job carrying a non-HumanUser payload context is still HONORED, with an anomaly audit row recorded", async () => {
    const runtime = installRuntimeSlot();
    const nonHumanCtx = {
      principalType: "ServiceAccount",
      principalId: "svc-1",
      authSource: "worker",
      policyVersion: "v2",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let observedCtx: unknown;
    dispatchRegisteredJobMock.mockImplementationOnce(async () => {
      observedCtx = getActorContext();
    });

    await __dispatchBackgroundJobForS2Tests(
      makeJob(SYSTEM_MAINTENANCE_JOB, { __actorContext: nonHumanCtx }) as never,
    );

    // Honored exactly as today — the non-HumanUser payload context wins, NOT
    // a freshly-minted System identity.
    expect(observedCtx).toEqual(nonHumanCtx);
    expect(runtime.buildSystemIdentity).not.toHaveBeenCalled();
    expect(runtime.auditFrameAnomaly).toHaveBeenCalledWith(
      SYSTEM_MAINTENANCE_JOB,
      "job-1",
      "ServiceAccount",
    );
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("job-system runtime slot EMPTY — never refuses dispatch (design doc §3.2)", () => {
  it("a system-maintenance job with no payload context still dispatches (with no ALS frame, exactly like pre-S2) and warns loudly", async () => {
    removeRuntimeSlot();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let observedCtx: unknown;
    let handlerCalled = false;
    dispatchRegisteredJobMock.mockImplementationOnce(async () => {
      handlerCalled = true;
      observedCtx = getActorContext();
    });

    await __dispatchBackgroundJobForS2Tests(makeJob(SYSTEM_MAINTENANCE_JOB) as never);

    expect(handlerCalled).toBe(true);
    expect(observedCtx).toBeUndefined();
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("runtime slot EMPTY")),
    ).toBe(true);
  });
});
