// cinatra#4150: the publish-decision expiry rides the resume-delivery loop. This drives the
// REAL `seed-artifact-review-resume-delivery` phase of src/lib/boot/phases/system-loops.ts
// with its dynamic imports mocked, takes the sweep it registers, and runs it: the expiry
// pass runs first in each cycle, a failed pass is logged by its error name only, and the
// resume drain still runs after it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  order: [] as string[],
  register: vi.fn(),
  enqueue: vi.fn(async () => undefined),
  expiry: vi.fn(async (): Promise<void> => undefined),
  drain: vi.fn(async (): Promise<unknown> => ({ delivered: 0 })),
}));

vi.mock("@/lib/background-jobs-registry", () => ({
  registerArtifactReviewResumeDeliveryRunner: h.register,
}));
vi.mock("@cinatra-ai/agents/artifact-review-resume-delivery", () => ({
  sweepExpiredPublishDecisionsOnce: h.expiry,
  sweepArtifactReviewResumeIntents: h.drain,
}));
vi.mock("@/lib/background-jobs", async () => {
  const names = await vi.importActual<typeof import("@/lib/background-jobs-names")>(
    "@/lib/background-jobs-names",
  );
  return {
    BACKGROUND_JOB_NAMES: names.BACKGROUND_JOB_NAMES,
    ARTIFACT_REVIEW_RESUME_DELIVERY_LOOP_JOB_ID: names.ARTIFACT_REVIEW_RESUME_DELIVERY_LOOP_JOB_ID,
    enqueueBackgroundJob: h.enqueue,
  };
});

import { systemLoopPhases } from "@/lib/boot/phases/system-loops";

async function registeredSweep(): Promise<() => Promise<unknown>> {
  const phase = systemLoopPhases().find((p) => p.name === "seed-artifact-review-resume-delivery");
  expect(phase).toBeDefined();
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await phase!.run();
  } finally {
    log.mockRestore();
  }
  expect(h.register).toHaveBeenCalledTimes(1);
  return (h.register.mock.calls[0]![0] as { sweep: () => Promise<unknown> }).sweep;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.expiry.mockImplementation(async () => {
    h.order.push("expiry");
  });
  h.drain.mockImplementation(async () => {
    h.order.push("drain");
    return { delivered: 0 };
  });
});

describe("the publish-decision expiry on the resume-delivery loop", () => {
  it("runs the expiry pass first, then the resume drain, and returns the drain's summary", async () => {
    const sweep = await registeredSweep();
    expect(await sweep()).toEqual({ delivered: 0 });
    expect(h.order).toEqual(["expiry", "drain"]);
  });

  it("a failed expiry pass is logged by its error name only, and the resume drain still runs", async () => {
    const sweep = await registeredSweep();
    h.expiry.mockImplementationOnce(async () => {
      h.order.push("expiry");
      throw new TypeError("db down at run-1");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await sweep()).toEqual({ delivered: 0 });
      expect(error).toHaveBeenCalledWith("[publish-decision-expiry] pass failed:", "TypeError");
      expect(error.mock.calls.flat().map(String).join("\n")).not.toMatch(/db down|run-1/);
    } finally {
      error.mockRestore();
    }
    expect(h.order).toEqual(["expiry", "drain"]);
  });

  it("a fault of the resume drain itself is not swallowed by the wrapper", async () => {
    const sweep = await registeredSweep();
    h.drain.mockRejectedValueOnce(new Error("drain down"));
    await expect(sweep()).rejects.toThrow("drain down");
  });
});
