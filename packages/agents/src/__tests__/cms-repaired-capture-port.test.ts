/**
 * cinatra#2044 / #2046 — the repaired-capture PORT and the drain's honesty
 * accounting.
 *
 * The failure this suite exists to prevent is not a crash — it is SILENCE. The
 * repair-successor gate renders #2287's `repair` pair; if the third picture is
 * missing and nothing says so, the gate shows a one-sided comparison and no
 * counter, log or record anywhere reports it. That is precisely the state the
 * live negative proof caught on cinatra#2044 (issuecomment-5144478834).
 *
 * So the contract under test is: the port NEVER throws into the repair, and
 * every outcome is classified — with `leavesUncapturedSide` naming exactly the
 * set that leaves the gate unable to state its own gap.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import {
  attemptRepairedCapture,
  leavesUncapturedSide,
  publishCmsRepairedCapturePort,
  readCmsRepairedCapturePort,
  type CmsRepairedCaptureAttempt,
  type CmsRepairedCaptureRequest,
} from "../cms-repaired-capture-port";
import { recordRepairedCaptureOutcome } from "../lifecycle-repair-cms-production-bridge";
import type { CmsRepairCompletionSummary } from "../lifecycle-repair-cms-production-bridge";

const REQUEST: CmsRepairedCaptureRequest = {
  orgId: "org-1",
  successorTarget: { artifactId: "art-successor", representationRevisionId: "rev-successor" },
  baseTarget: { artifactId: "art-base", representationRevisionId: "rev-base" },
  title: "Repaired post",
  createdBy: "user-accountable",
  producerRunId: "run-repair-1",
};

function emptySummary(): CmsRepairCompletionSummary {
  return {
    scanned: 0,
    completed: 0,
    pending: 0,
    unresolved: 0,
    failed: 0,
    repairedCaptured: 0,
    repairedCaptureDegraded: 0,
    repairedCaptureMissing: 0,
  };
}

beforeEach(() => {
  publishCmsRepairedCapturePort(undefined);
});

afterEach(() => {
  publishCmsRepairedCapturePort(undefined);
  vi.restoreAllMocks();
});

describe("the repaired-capture port", () => {
  it("reports `unavailable` — never a silent skip — when no port is bound", async () => {
    expect(readCmsRepairedCapturePort()).toBeUndefined();

    const attempt = await attemptRepairedCapture(REQUEST);

    expect(attempt).toEqual({ outcome: "unavailable" });
    // A boot misconfiguration must be LOUD: this is the class that leaves the
    // successor gate with no picture and nothing on it explaining why.
    expect(leavesUncapturedSide(attempt)).toBe(true);
  });

  it("hands the port the repair's OWN targets and returns `captured`", async () => {
    const seen: CmsRepairedCaptureRequest[] = [];
    publishCmsRepairedCapturePort(async (r) => {
      seen.push(r);
      return { status: "captured" };
    });

    const attempt = await attemptRepairedCapture(REQUEST);

    expect(attempt).toEqual({ outcome: "captured" });
    expect(leavesUncapturedSide(attempt)).toBe(false);
    expect(seen).toHaveLength(1);
    // The picture binds to the SUCCESSOR; the base travels only so the capture
    // can recover coordinates the gate itself already resolved.
    expect(seen[0].successorTarget).toEqual(REQUEST.successorTarget);
    expect(seen[0].baseTarget).toEqual(REQUEST.baseTarget);
    expect(seen[0].createdBy).toBe("user-accountable");
    expect(seen[0].producerRunId).toBe("run-repair-1");
  });

  it("passes a RECORDED degrade through as the quiet class — the gate states the gap itself", async () => {
    publishCmsRepairedCapturePort(async () => ({
      status: "degraded",
      reason: "preview-unreachable",
      recorded: true,
    }));

    const attempt = await attemptRepairedCapture(REQUEST);

    expect(attempt).toEqual({
      outcome: "degraded",
      reason: "preview-unreachable",
      recorded: true,
    });
    expect(leavesUncapturedSide(attempt)).toBe(false);
  });

  it("treats an UNRECORDED degrade as leaving an uncaptured side", async () => {
    publishCmsRepairedCapturePort(async () => ({
      status: "degraded",
      reason: "capture-timeout",
      recorded: false,
    }));

    const attempt = await attemptRepairedCapture(REQUEST);

    // The reason never reached the gate, so the reviewer sees a blank side with
    // no explanation — indistinguishable from the bug this work fixes.
    expect(leavesUncapturedSide(attempt)).toBe(true);
  });

  it("CONTAINS a throwing port instead of failing the repair", async () => {
    publishCmsRepairedCapturePort(async () => {
      throw new Error("headless renderer exploded");
    });

    const attempt = await attemptRepairedCapture(REQUEST);

    expect(attempt.outcome).toBe("failed");
    expect(attempt.outcome === "failed" && attempt.error).toContain("headless renderer exploded");
    expect(leavesUncapturedSide(attempt)).toBe(true);
  });

  it("contains a non-Error throw too", async () => {
    publishCmsRepairedCapturePort(async () => {
      throw "string rejection";
    });

    const attempt = await attemptRepairedCapture(REQUEST);

    expect(attempt).toEqual({ outcome: "failed", error: "string rejection" });
  });

  it("publish is last-write-wins and clearable", async () => {
    publishCmsRepairedCapturePort(async () => ({ status: "captured" }));
    expect(readCmsRepairedCapturePort()).toBeDefined();
    publishCmsRepairedCapturePort(undefined);
    expect(readCmsRepairedCapturePort()).toBeUndefined();
    expect(await attemptRepairedCapture(REQUEST)).toEqual({ outcome: "unavailable" });
  });
});

describe("the drain's repaired-capture accounting", () => {
  it("counts a capture", () => {
    const summary = emptySummary();
    recordRepairedCaptureOutcome(summary, "repair-1", { outcome: "captured" });
    expect(summary.repairedCaptured).toBe(1);
    expect(summary.repairedCaptureDegraded).toBe(0);
    expect(summary.repairedCaptureMissing).toBe(0);
  });

  it("counts a RECORDED degrade separately from a missing picture, and warns rather than errors", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = emptySummary();

    recordRepairedCaptureOutcome(summary, "repair-1", {
      outcome: "degraded",
      reason: "no-owned-regions",
      recorded: true,
    });

    expect(summary.repairedCaptureDegraded).toBe(1);
    expect(summary.repairedCaptureMissing).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("no-owned-regions");
    expect(error).not.toHaveBeenCalled();
  });

  it.each<[string, CmsRepairedCaptureAttempt, string]>([
    ["no port bound", { outcome: "unavailable" }, "no host capture port is bound"],
    ["the port threw", { outcome: "failed", error: "boom" }, "the capture port threw: boom"],
    [
      // A NON-ceiling reason on purpose: `capture-timeout` is the unconfirmed
      // class with its own honest wording, pinned by the test below.
      "the reason was never recorded",
      { outcome: "degraded", reason: "preview-unreachable", recorded: false },
      "without recording it",
    ],
  ])("ESCALATES the uncaptured-side class (%s) with a stated cause", (_label, attempt, needle) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = emptySummary();

    recordRepairedCaptureOutcome(summary, "repair-42", attempt);

    expect(summary.repairedCaptureMissing).toBe(1);
    expect(summary.repairedCaptured).toBe(0);
    expect(summary.repairedCaptureDegraded).toBe(0);
    // The repair id AND the cause are both in the log — the negative proof's
    // complaint was that nothing anywhere reported the missing side.
    expect(error).toHaveBeenCalledOnce();
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain("repair-42");
    expect(line).toContain(needle);
    expect(line).toContain("will show an uncaptured side");
  });

  it("states the CEILING class as UNCONFIRMED — it is counted, but never claimed as certain", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = emptySummary();

    recordRepairedCaptureOutcome(summary, "repair-7", {
      outcome: "degraded",
      reason: "capture-timeout",
      recorded: false,
    });

    // Still escalated — an unverifiable picture must reach ops.
    expect(summary.repairedCaptureMissing).toBe(1);
    const line = String(error.mock.calls[0][0]);
    // …but a capture that outran its ceiling was never cancelled and may yet
    // pin the picture, so the line must not assert the gate WILL be one-sided.
    expect(line).toContain("may yet land");
    expect(line).toContain("may show an uncaptured side");
    expect(line).not.toContain("will show an uncaptured side");
  });

  it("never throws out of the accounting itself", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = emptySummary();
    expect(() =>
      recordRepairedCaptureOutcome(summary, "repair-1", { outcome: "unavailable" }),
    ).not.toThrow();
  });
});
