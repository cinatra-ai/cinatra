import { describe, expect, it } from "vitest";
import { buildRunStepRail } from "../run-step-rail";

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
});
