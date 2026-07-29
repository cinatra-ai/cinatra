// cinatra#1941 S2 — unit coverage for the boot-registered job-system runtime
// (src/lib/background-jobs-system-frame.ts): the ALS frame round trip, the
// audited System identity shape, the two audit-emission helpers (spied), the
// declarative payload-field interpreter, and the boot-registration slot
// round trip.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const { logAuditEventMock } = vi.hoisted(() => ({
  logAuditEventMock: vi.fn(async () => undefined),
}));
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: logAuditEventMock,
}));

import {
  runWithJobFrame,
  getActiveJobFrame,
  buildJobSystemIdentity,
  readPayloadField,
  auditUnclassifiedRefusal,
  auditFrameAnomaly,
  registerJobSystemRuntime,
  type JobDispatchFrame,
} from "@/lib/background-jobs-system-frame";
import { POLICY_VERSION } from "@/lib/authz/actor-context";
import type { JobAuthorityMetadata } from "@/lib/background-jobs-registry";

const NO_ORG_WRITE_AUTHORITY: JobAuthorityMetadata = {
  authorityKind: "no-org-write",
  actorSource: "none",
};

function makeFrame(overrides: Partial<JobDispatchFrame> = {}): JobDispatchFrame {
  return {
    jobName: "TEST_JOB",
    jobId: "job-1",
    authority: NO_ORG_WRITE_AUTHORITY,
    payload: {},
    ...overrides,
  };
}

beforeEach(() => {
  logAuditEventMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runWithJobFrame / getActiveJobFrame", () => {
  it("is undefined outside any frame", () => {
    expect(getActiveJobFrame()).toBeUndefined();
  });

  it("is visible inside the frame and reverts after", async () => {
    const frame = makeFrame();
    const observed = await runWithJobFrame(frame, async () => getActiveJobFrame());
    expect(observed).toEqual(frame);
    expect(getActiveJobFrame()).toBeUndefined();
  });

  it("nested frames: the inner frame wins only for the duration of the inner callback", async () => {
    const outer = makeFrame({ jobName: "OUTER" });
    const inner = makeFrame({ jobName: "INNER" });
    await runWithJobFrame(outer, async () => {
      expect(getActiveJobFrame()?.jobName).toBe("OUTER");
      await runWithJobFrame(inner, async () => {
        expect(getActiveJobFrame()?.jobName).toBe("INNER");
      });
      expect(getActiveJobFrame()?.jobName).toBe("OUTER");
    });
  });
});

describe("buildJobSystemIdentity", () => {
  it("mints the System ActorContext shape from job name + id only — never from a payload", () => {
    const ctx = buildJobSystemIdentity("GRAPHITI_PROJECTION_REPAIR", "job-42");
    expect(ctx).toEqual({
      principalType: "System",
      principalId: "background-job:GRAPHITI_PROJECTION_REPAIR:job-42",
      authSource: "worker",
      policyVersion: POLICY_VERSION,
    });
  });
});

describe("readPayloadField", () => {
  it("reads a string field from an object payload", () => {
    expect(readPayloadField({ orgId: "org-1" }, "orgId")).toBe("org-1");
  });

  it("returns null for a non-string value, a missing field, or a non-object payload", () => {
    expect(readPayloadField({ orgId: 123 }, "orgId")).toBeNull();
    expect(readPayloadField({}, "orgId")).toBeNull();
    expect(readPayloadField(null, "orgId")).toBeNull();
    expect(readPayloadField(undefined, "orgId")).toBeNull();
    expect(readPayloadField("nope", "orgId")).toBeNull();
  });
});

describe("auditUnclassifiedRefusal (D6/§4)", () => {
  it("emits a DENIED audit row with the documented shape", () => {
    auditUnclassifiedRefusal("SOME_JOB", "job-9");
    expect(logAuditEventMock).toHaveBeenCalledTimes(1);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        operation: "background-job.unclassified",
        resourceType: "background-job",
        resourceId: "SOME_JOB",
        actorPrincipalId: "background-job:SOME_JOB:job-9",
        actorPrincipalType: "system",
        authSource: "worker",
        policyVersion: POLICY_VERSION,
      }),
    );
  });
});

describe("auditFrameAnomaly (§3.1 anomaly telemetry — no behavior change)", () => {
  it("emits an ALLOWED audit row recording the payload's non-HumanUser principalType", () => {
    auditFrameAnomaly("SOME_JOB", "job-9", "ServiceAccount");
    expect(logAuditEventMock).toHaveBeenCalledTimes(1);
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allowed",
        operation: "background-job.frame-anomaly",
        resourceId: "SOME_JOB",
        actorPrincipalType: "system",
        metadata: expect.objectContaining({ payloadPrincipalType: "ServiceAccount" }),
      }),
    );
  });
});

describe("registerJobSystemRuntime / boot slot", () => {
  const globalSlot = globalThis as unknown as { __cinatraJobSystemRuntime?: unknown };
  const priorSlot = globalSlot.__cinatraJobSystemRuntime;

  afterEach(() => {
    globalSlot.__cinatraJobSystemRuntime = priorSlot;
  });

  it("registers the runtime object at the documented globalThis slot (idempotent, last write wins)", () => {
    const runtimeA = {
      runWithJobFrame,
      buildSystemIdentity: buildJobSystemIdentity,
      auditUnclassifiedRefusal,
      auditFrameAnomaly,
    };
    registerJobSystemRuntime(runtimeA);
    expect(globalSlot.__cinatraJobSystemRuntime).toBe(runtimeA);

    const runtimeB = { ...runtimeA };
    registerJobSystemRuntime(runtimeB);
    expect(globalSlot.__cinatraJobSystemRuntime).toBe(runtimeB);
  });
});
