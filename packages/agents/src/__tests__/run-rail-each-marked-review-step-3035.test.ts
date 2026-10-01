/**
 * EVERY MARKED REVIEW STEP HOLDS ITS OWN REVIEW ON THE RAIL (cinatra#3035).
 *
 * A template may mark more than one of its declared pauses as a step that opens
 * its review. Each such pause raises its review gates under one base id
 * (`wayflow-<task id>`, with `#2`, `#3`, … for every further artifact of the
 * same pause), and the gate row stores no step. The rail used to place the
 * gates only when exactly one step was marked; with two or more marked steps
 * every review trailed the whole spine as a second entry, and the steps after
 * it read as passed while the run waited.
 *
 * What this locks (N1..N6), on the pure builder, with generic steps only:
 *
 *   N1  both reviews settled: each group of gates stands in its own marked
 *       step's place, with that step's label, ordinal and step number, and
 *       neither marked step's own entry is drawn;
 *   N2  parked at the first marked step: its gate stands there, and the second
 *       marked step keeps its own entry, still to come;
 *   N3  the first review settled, the second pending: the pending gate stands
 *       in the second marked step's place and is the active entry;
 *   N4  a verification of the second step's gate follows it in that place;
 *   N5  a marked step answered as an ordinary pause raised no gate: the one
 *       group stands in the next marked step, and the answered step keeps its
 *       own entry;
 *   N6  a group beyond the marked steps and a gate of another prefix trail the
 *       spine as "Review", and a template with no marked step places nothing.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run --maxWorkers=2 --no-coverage \
 *     src/__tests__/run-rail-each-marked-review-step-3035.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  buildRunStepRail,
  type RailGate,
  type RailSubmissionMarker,
  type RailTemplateStep,
} from "../run-step-rail";

const FIRST_MARKED = 4;
const SECOND_MARKED = 9;

/** Four declared pauses; the second and the fourth mark their review. The
 *  policy step numbers differ from the display indices on purpose, so `onStep`
 *  is read as the step number and the ordinal as the display index. */
function templateSteps(marked: ReadonlyArray<number> = [FIRST_MARKED, SECOND_MARKED]): RailTemplateStep[] {
  return [
    { index: 1, stepNumber: 1, label: "Choose the input" },
    { index: 2, stepNumber: FIRST_MARKED, label: "First review step" },
    { index: 3, stepNumber: 7, label: "Middle step" },
    { index: 4, stepNumber: SECOND_MARKED, label: "Second review step" },
  ].map((step) => (marked.includes(step.stepNumber) ? { ...step, marksReview: true } : step));
}

const ANSWERED_UNMARKED: RailSubmissionMarker[] = [
  { stepIndex: 1, answered: true },
  { stepIndex: 3, answered: true },
];

function gate(reviewTaskId: string, status: RailGate["status"], minute: number): RailGate {
  return {
    gateId: `gate-${reviewTaskId}`,
    reviewTaskId,
    status,
    disposition: status === "resolved" ? "approved" : null,
    createdAt: `2026-09-29T10:${String(minute).padStart(2, "0")}:00Z`,
  };
}

describe("every marked review step holds its own review on the rail (cinatra#3035)", () => {
  it("N1 both reviews settled: each group stands in its own marked step's place", () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: ANSWERED_UNMARKED,
      gates: [
        gate("wayflow-task-b", "resolved", 50),
        gate("wayflow-task-a#2", "resolved", 41),
        gate("wayflow-task-a", "resolved", 40),
      ],
    });

    expect(rail.entries.map((e) => e.key)).toEqual([
      "step:1",
      "gate:wayflow-task-a",
      "gate:wayflow-task-a#2",
      "step:7",
      "gate:wayflow-task-b",
    ]);
    const byKey = new Map(rail.entries.map((e) => [e.key, e]));
    expect(byKey.get("gate:wayflow-task-a")).toMatchObject({
      ordinal: 2,
      kind: "gate",
      label: "First review step",
      status: "resolved",
      onStep: FIRST_MARKED,
    });
    const secondLeg = byKey.get("gate:wayflow-task-a#2");
    expect(secondLeg).toMatchObject({ label: "First review step", onStep: FIRST_MARKED });
    expect(secondLeg!.ordinal).toBeGreaterThan(2);
    expect(secondLeg!.ordinal).toBeLessThan(3);
    expect(byKey.get("gate:wayflow-task-b")).toMatchObject({
      ordinal: 4,
      kind: "gate",
      label: "Second review step",
      status: "resolved",
      onStep: SECOND_MARKED,
    });
    expect(byKey.has(`step:${FIRST_MARKED}`)).toBe(false);
    expect(byKey.has(`step:${SECOND_MARKED}`)).toBe(false);
    expect(rail.activeOrdinal).toBeNull();
  });

  it("N2 parked at the first marked step: the second marked step keeps its own entry, still to come", () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: [{ stepIndex: 1, answered: true }],
      gates: [gate("wayflow-task-a", "pending", 40)],
    });

    expect(rail.entries.map((e) => e.key)).toEqual([
      "step:1",
      "gate:wayflow-task-a",
      "step:7",
      `step:${SECOND_MARKED}`,
    ]);
    const byKey = new Map(rail.entries.map((e) => [e.key, e]));
    expect(byKey.get("gate:wayflow-task-a")).toMatchObject({
      ordinal: 2,
      label: "First review step",
      status: "pending",
      onStep: FIRST_MARKED,
    });
    expect(byKey.get(`step:${SECOND_MARKED}`)).toMatchObject({
      ordinal: 4,
      kind: "step",
      label: "Second review step",
      status: "upcoming",
    });
    expect(byKey.get(`step:${SECOND_MARKED}`)!.onStep).toBeUndefined();
    expect(rail.activeOrdinal).toBe(2);
  });

  it("N3 the first review settled and the second pending: the pending gate stands in the second marked step and is active", () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: ANSWERED_UNMARKED,
      gates: [
        gate("wayflow-task-a", "resolved", 40),
        gate("wayflow-task-a#2", "resolved", 41),
        gate("wayflow-task-b", "pending", 50),
      ],
    });

    const pending = rail.entries.find((e) => e.key === "gate:wayflow-task-b");
    expect(pending).toMatchObject({
      ordinal: 4,
      label: "Second review step",
      status: "pending",
      onStep: SECOND_MARKED,
    });
    expect(rail.entries.some((e) => e.label === "Review")).toBe(false);
    expect(rail.activeOrdinal).toBe(4);
  });

  it("N4 a verification of the second step's gate follows it in that step's place", () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: ANSWERED_UNMARKED,
      gates: [
        gate("wayflow-task-a", "resolved", 40),
        gate("wayflow-task-b", "resolved", 50),
      ],
      verifications: [
        { gateId: "gate-wayflow-task-b", reviewTaskId: "wayflow-task-b", outcome: "verified" },
      ],
    });

    const keys = rail.entries.map((e) => e.key);
    expect(keys.indexOf("verification:wayflow-task-b")).toBe(keys.indexOf("gate:wayflow-task-b") + 1);
    expect(rail.entries.find((e) => e.key === "verification:wayflow-task-b")).toMatchObject({
      ordinal: 4,
      kind: "verification",
      onStep: SECOND_MARKED,
    });
  });

  it("N5 a marked step answered as an ordinary pause raised no gate: the group stands in the next marked step", () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: [
        { stepIndex: 1, answered: true },
        { stepIndex: 2, answered: true },
        { stepIndex: 3, answered: true },
      ],
      gates: [gate("wayflow-task-b", "pending", 50)],
    });

    const byKey = new Map(rail.entries.map((e) => [e.key, e]));
    expect(byKey.get("gate:wayflow-task-b")).toMatchObject({
      ordinal: 4,
      label: "Second review step",
      status: "pending",
      onStep: SECOND_MARKED,
    });
    expect(byKey.get(`step:${FIRST_MARKED}`)).toMatchObject({
      ordinal: 2,
      kind: "step",
      label: "First review step",
      status: "completed",
    });
    expect(byKey.get(`step:${FIRST_MARKED}`)!.onStep).toBeUndefined();
    expect(byKey.has(`step:${SECOND_MARKED}`)).toBe(false);
    expect(rail.activeOrdinal).toBe(4);
  });

  it("N6 a group beyond the marked steps and a gate of another prefix trail as Review; no marked step places nothing", () => {
    const gates = [
      gate("wayflow-task-a", "resolved", 40),
      gate("wayflow-task-b", "resolved", 50),
      gate("wayflow-task-c", "pending", 55),
      gate("lifecycle-review:event-x", "resolved", 30),
    ];
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: ANSWERED_UNMARKED,
      gates,
    });
    for (const key of ["gate:wayflow-task-c", "gate:lifecycle-review:event-x"]) {
      const entry = rail.entries.find((e) => e.key === key);
      expect(entry).toMatchObject({ kind: "gate", label: "Review" });
      expect(entry!.onStep).toBeUndefined();
      expect(entry!.ordinal).toBeGreaterThan(4);
    }

    const unmarked = buildRunStepRail({
      templateSteps: templateSteps([]),
      submissions: ANSWERED_UNMARKED,
      gates,
    });
    expect(unmarked.entries.some((e) => e.onStep !== undefined)).toBe(false);
    expect(unmarked.entries.filter((e) => e.kind === "gate").map((e) => e.label)).toEqual([
      "Review",
      "Review",
      "Review",
      "Review",
    ]);
    expect(unmarked.entries.filter((e) => e.kind === "step").map((e) => e.key)).toEqual([
      "step:1",
      `step:${FIRST_MARKED}`,
      "step:7",
      `step:${SECOND_MARKED}`,
    ]);
  });
});
