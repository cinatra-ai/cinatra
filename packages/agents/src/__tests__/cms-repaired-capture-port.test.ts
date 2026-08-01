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
import {
  recordRepairedCaptureOutcome,
  reportRepairedCaptureIncident,
} from "../lifecycle-repair-cms-production-bridge";
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

/**
 * The PRE-COMMIT report. The counters are in-memory and are folded only after
 * `submitRepairResponse` durably lands, so the incident has to be on the record
 * BEFORE that commit — otherwise a crash in the window leaves a repair that
 * completed durably with no picture and no account of it anywhere, which is the
 * original silence in a narrower window (a codex round-3 finding).
 */
describe("the drain's PRE-COMMIT incident report", () => {
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

    reportRepairedCaptureIncident("repair-42", attempt);

    // The repair id AND the cause are both in the log — the negative proof's
    // complaint was that nothing anywhere reported the missing side.
    expect(error).toHaveBeenCalledOnce();
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain("repair-42");
    expect(line).toContain(needle);
    expect(line).toContain("will show an uncaptured side");
  });

  it("states the CEILING class as UNCONFIRMED — it is escalated, but never claimed as certain", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    reportRepairedCaptureIncident("repair-7", {
      outcome: "degraded",
      reason: "capture-timeout",
      recorded: false,
    });

    const line = String(error.mock.calls[0][0]);
    // A capture that outran its ceiling was never cancelled and may yet pin the
    // picture, so the line must not assert the gate WILL be one-sided.
    expect(line).toContain("may yet land");
    expect(line).toContain("may show an uncaptured side");
    expect(line).not.toContain("will show an uncaptured side");
  });

  it("speaks CONDITIONALLY about this target, never predicting a gate", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    reportRepairedCaptureIncident("repair-9", { outcome: "unavailable" });
    // It runs before `submitRepairResponse`, which may still reject (no gate at
    // all) and which a concurrent completion may win with a DIFFERENT target
    // (a gate this line says nothing about). So the claim is scoped to the
    // target, which is the part that is knowable here.
    expect(String(error.mock.calls[0][0])).toContain("a successor gate pinned to this target");
  });

  it("stays SILENT for the classes the gate itself can state", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    reportRepairedCaptureIncident("repair-1", { outcome: "captured" });
    reportRepairedCaptureIncident("repair-1", {
      outcome: "degraded",
      reason: "no-owned-regions",
      recorded: true,
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("never throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => reportRepairedCaptureIncident("repair-1", { outcome: "unavailable" })).not.toThrow();
  });
});

describe("the drain's repaired-capture accounting", () => {
  it("counts a capture", () => {
    const summary = emptySummary();
    recordRepairedCaptureOutcome(summary, "repair-1", { outcome: "captured" }, true);
    expect(summary.repairedCaptured).toBe(1);
    expect(summary.repairedCaptureDegraded).toBe(0);
    expect(summary.repairedCaptureMissing).toBe(0);
  });

  it("counts a RECORDED degrade separately from a missing picture, and warns rather than errors", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = emptySummary();

    recordRepairedCaptureOutcome(
      summary,
      "repair-1",
      { outcome: "degraded", reason: "no-owned-regions", recorded: true },
      true,
    );

    expect(summary.repairedCaptureDegraded).toBe(1);
    expect(summary.repairedCaptureMissing).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("no-owned-regions");
    expect(error).not.toHaveBeenCalled();
  });

  it("COUNTS the uncaptured-side class without logging it a second time", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = emptySummary();

    recordRepairedCaptureOutcome(summary, "repair-42", { outcome: "unavailable" }, true);

    expect(summary.repairedCaptureMissing).toBe(1);
    expect(summary.repairedCaptured).toBe(0);
    expect(summary.repairedCaptureDegraded).toBe(0);
    // `reportRepairedCaptureIncident` already put it on the record pre-commit.
    expect(error).not.toHaveBeenCalled();
  });

  /**
   * `submitRepairResponse` is IDEMPOTENT: an already-repaired repair returns its
   * EXISTING successor gate without checking the caller's target. So a
   * concurrent completion that won with a different production write would let
   * a losing drain's `ok` be read as confirmation for a gate its picture is not
   * pinned to (a codex round-3 finding).
   */
  it("REFUSES to count a capture pinned to a target the settled repair does not name", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = emptySummary();

    recordRepairedCaptureOutcome(summary, "repair-race", { outcome: "captured" }, false);

    // Counted as missing — not because the gate is KNOWN one-sided (the winner
    // may have pinned its own picture) but because nothing here can verify it.
    expect(summary.repairedCaptureMissing).toBe(1);
    expect(summary.repairedCaptured).toBe(0);
    expect(error).toHaveBeenCalledOnce();
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain("repair-race");
    expect(line).toContain("cannot verify");
    // It must NOT overclaim that the gate has no picture.
    expect(line).not.toContain("will show an uncaptured side");
  });

  it("does not claim a picture was PINNED when the attempt pinned nothing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = emptySummary();

    // `unavailable` never reached the store — no record of any role exists. The
    // mismatch line must describe what was ATTEMPTED, never a pinned picture.
    recordRepairedCaptureOutcome(summary, "repair-race", { outcome: "unavailable" }, false);

    const line = String(error.mock.calls[0][0]);
    expect(line).toContain("was taken against");
    expect(line).not.toContain("is pinned to");
  });

  it("the target check outranks a successful capture — a mismatch is never counted as captured", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = emptySummary();
    recordRepairedCaptureOutcome(
      summary,
      "repair-race",
      { outcome: "degraded", reason: "no-owned-regions", recorded: true },
      false,
    );
    expect(summary.repairedCaptureDegraded).toBe(0);
    expect(summary.repairedCaptureMissing).toBe(1);
  });

  it("never throws out of the accounting itself", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = emptySummary();
    expect(() =>
      recordRepairedCaptureOutcome(summary, "repair-1", { outcome: "unavailable" }, true),
    ).not.toThrow();
  });
});
