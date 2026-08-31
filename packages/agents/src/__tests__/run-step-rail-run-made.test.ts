import { describe, expect, it } from "vitest";
import { buildRunStepRail, TERMINAL_RAIL_STATUSES, type RailStatus } from "../run-step-rail";

// ---------------------------------------------------------------------------
// The rail's LAST entry — the run's own record (cinatra#3029, epic #3023 W5).
// The ratified drawing: "A finished run says what it made. The rail's last entry
// is the run's own record, and its page lists the run's work."
// ---------------------------------------------------------------------------

const steps = [
  { stepNumber: 1, index: 1, label: "Choose the idea" },
  { stepNumber: 2, index: 2, label: "Drafted the post" },
];

describe("the run's own record on the rail", () => {
  it("is the LAST entry, however the spine was merged", () => {
    const rail = buildRunStepRail({
      templateSteps: steps,
      stepResults: [{}, {}],
      gates: [
        {
          gateId: "g1",
          reviewTaskId: "t1",
          status: "resolved",
          disposition: "approved",
          createdAt: new Date("2026-08-01T00:00:00Z"),
        },
      ],
      runMade: { runId: "run-1", artifactCount: 5 },
    });
    const last = rail.entries[rail.entries.length - 1];
    expect(last.kind).toBe("runMade");
    expect(last.key).toBe("runMade:run-1");
    expect(last.label).toBe("Done");
    expect(last.runMade).toEqual({ artifactCount: 5 });
    // It trails EVERY other entry, gates included.
    expect(last.ordinal).toBeGreaterThan(
      Math.max(...rail.entries.slice(0, -1).map((e) => e.ordinal)),
    );
  });

  it("is terminal history — never the 'you are here' anchor of a finished run", () => {
    const rail = buildRunStepRail({
      templateSteps: steps,
      stepResults: [{}, {}],
      runMade: { runId: "run-1", artifactCount: 2 },
    });
    expect(rail.entries[rail.entries.length - 1].status).toBe("resolved");
    expect(rail.activeOrdinal).toBeNull();
  });

  it("an EMPTY run still gets the entry — zero is a reading, not an absence", () => {
    const rail = buildRunStepRail({
      templateSteps: steps,
      stepResults: [{}, {}],
      runMade: { runId: "run-2", artifactCount: 0 },
    });
    const last = rail.entries[rail.entries.length - 1];
    expect(last.kind).toBe("runMade");
    expect(last.runMade).toEqual({ artifactCount: 0 });
  });

  it("a run that has NOT finished carries no such entry", () => {
    const rail = buildRunStepRail({ templateSteps: steps, stepResults: [{}] });
    expect(rail.entries.some((e) => e.kind === "runMade")).toBe(false);
    // The rail is otherwise untouched by this slice.
    expect(rail.entries.map((e) => e.label)).toEqual([
      "Choose the idea",
      "Drafted the post",
    ]);
  });

  it("dedupes with nothing — it is not a step the run executed", () => {
    const rail = buildRunStepRail({
      templateSteps: steps,
      stepResults: [{}, {}],
      runMade: { runId: "run-1", artifactCount: 1 },
    });
    const runMadeEntries = rail.entries.filter((e) => e.kind === "runMade");
    expect(runMadeEntries).toHaveLength(1);
    expect(runMadeEntries[0].sources).toEqual(["runMade"]);
  });

  // -------------------------------------------------------------------------
  // THE RAIL CANNOT READ TWO WAYS AT ONCE (second capture, 2026-08-30).
  //
  // Measured on the default road: the rail's last entry read "Done" RESOLVED
  // while the "Review" entry ABOVE it read pending and the page said "Awaiting
  // your decision". Both underlying facts are real — the run reached its
  // terminal status, and the review gate the default-road pickup opened after
  // it is genuinely still open — so the defect is not in the data. It is in
  // this derivation: the run's own record claimed TERMINAL history while an
  // EARLIER entry on the same ordered rail was still open, and a stepper whose
  // step 3 is finished while its step 2 is not tells the reader nothing true.
  //
  // The rail is ORDERED. The invariant asserted here is exactly that: once an
  // entry is not terminal, nothing after it may read as terminal.
  // -------------------------------------------------------------------------


  /** No terminal entry may sit after a non-terminal one. */
  function readsOneWay(entries: readonly { status: RailStatus; label: string }[]) {
    const firstOpen = entries.findIndex((e) => !TERMINAL_RAIL_STATUSES.has(e.status));
    if (firstOpen === -1) return true;
    return entries.slice(firstOpen + 1).every((e) => !TERMINAL_RAIL_STATUSES.has(e.status));
  }

  it("does NOT read resolved while an earlier gate is still pending", () => {
    const rail = buildRunStepRail({
      templateSteps: steps,
      stepResults: [{}, {}],
      gates: [
        {
          gateId: "g-open",
          reviewTaskId: "t-open",
          status: "pending",
          disposition: null,
          createdAt: new Date("2026-08-30T22:08:52Z"),
        },
      ],
      // The run itself reached its terminal status BEFORE the default-road
      // pickup opened that gate — the exact ten-second ordering the capture's
      // database trace recorded.
      runMade: { runId: "9ba0cb98", artifactCount: 1 },
    });

    const last = rail.entries[rail.entries.length - 1];
    expect(last.kind).toBe("runMade");
    expect(last.status).not.toBe("resolved");
    expect(last.status).not.toBe("completed");

    // The whole rail reads one way, top to bottom.
    expect(readsOneWay(rail.entries)).toBe(true);

    // The open gate is still the "you are here" anchor — untouched.
    const gate = rail.entries.find((e) => e.kind === "gate");
    expect(gate!.status).toBe("pending");
    expect(rail.activeOrdinal).toBe(gate!.ordinal);
  });

  it("still reads resolved once every earlier entry is terminal", () => {
    const rail = buildRunStepRail({
      templateSteps: steps,
      stepResults: [{}, {}],
      gates: [
        {
          gateId: "g-done",
          reviewTaskId: "t-done",
          status: "resolved",
          disposition: "approved",
          createdAt: new Date("2026-08-30T22:08:52Z"),
        },
      ],
      runMade: { runId: "9ba0cb98", artifactCount: 1 },
    });
    const last = rail.entries[rail.entries.length - 1];
    expect(last.status).toBe("resolved");
    expect(rail.activeOrdinal).toBeNull();
    expect(readsOneWay(rail.entries)).toBe(true);
  });

  it("a SKIPPED review is terminal — it does not hold the run's record open", () => {
    const rail = buildRunStepRail({
      templateSteps: steps,
      stepResults: [{}, {}],
      lifecycleDecisions: [
        {
          eventId: "e1",
          artifactId: "a1",
          outcome: "skipped",
          gateId: null,
          decidedBy: "policy",
          latticeOutcome: null,
          reason: "the policy did not fire this checkpoint",
          createdAt: new Date("2026-08-30T22:08:52Z"),
        },
      ],
      runMade: { runId: "9ba0cb98", artifactCount: 1 },
    });
    const last = rail.entries[rail.entries.length - 1];
    expect(last.status).toBe("resolved");
    expect(readsOneWay(rail.entries)).toBe(true);
  });
});
