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
 *       step's place, with that step's ordinal and step number, and neither
 *       marked step's own entry is drawn. Each gate keeps its own label,
 *       "Review · <artifact>", as the approved drawing labels each review
 *       entry (specs/app-artifact-review.html I.3);
 *   N2  parked at the first marked step: its gate stands there, and the second
 *       marked step keeps its own entry, still to come;
 *   N3  the first review settled, the second pending: the pending gate stands
 *       in the second marked step's place and is the active entry;
 *   N4  a verification of the second step's gate follows it in that place;
 *   N5  a marked step answered as an ordinary pause raised no gate: the one
 *       group stands in the next marked step, and the answered step keeps its
 *       own entry;
 *   N6  a group beyond the marked steps and a gate of another prefix trail the
 *       spine under their own label, and a template with no marked step places
 *       nothing;
 *   N7  one pause's ten artifacts, created at one instant, keep the family's
 *       own order: `#10` after `#9`;
 *   N8  a marked step that pauses more than once (`gateCount` 2) cannot be
 *       tied by position, so no gate is placed and every gate trails;
 *   N9  two groups created at the same instant have no reach order, so no
 *       gate is placed;
 *   N10 a marked step that fell back with a bare approval (a submission with no
 *       values, `answered: false`) raised no gate: the group stands in the next
 *       marked step;
 *   N11 that fallen-back marked step reads passed, and the gate standing in the
 *       next marked step is the active entry, not the passed step;
 *   N12 a gate time that is not a time (a text that does not parse, an invalid
 *       Date) leaves the reach order unproven: no gate is placed;
 *   N13 two groups less than 2 ms apart have no proven reach order (the times
 *       are read in milliseconds from a microsecond column): no gate is placed;
 *   N14 where no gate is placed, the active entry is the pending gate trailing
 *       the spine, the row the live rail elects, never a step still to come;
 *   N15 the submission walk stopped at the first marked step (its order could
 *       not be proven), so that step's missing submission does not mean it is
 *       open: no gate is placed by position, and the second marked step's
 *       pending gate never stands in the first one's place.
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

function gate(
  reviewTaskId: string,
  status: RailGate["status"],
  minute: number,
  artifactName?: string,
): RailGate {
  return {
    gateId: `gate-${reviewTaskId}`,
    reviewTaskId,
    status,
    disposition: status === "resolved" ? "approved" : null,
    createdAt: `2026-09-29T10:${String(minute).padStart(2, "0")}:00Z`,
    ...(artifactName !== undefined ? { artifactName } : {}),
  };
}

/** The pipeline's two reviews in the drawing's order: the post first, then
 *  its featured image (specs/app-artifact-review.html I.3). */
const POST = "the post";
const IMAGE = "featured image";

describe("every marked review step holds its own review on the rail (cinatra#3035)", () => {
  it("N1 both reviews settled: each group stands in its own marked step's place", () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: ANSWERED_UNMARKED,
      gates: [
        gate("wayflow-task-b", "resolved", 50, POST),
        gate("wayflow-task-a#2", "resolved", 41, IMAGE),
        gate("wayflow-task-a", "resolved", 40, POST),
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
      label: `Review · ${POST}`,
      status: "resolved",
      onStep: FIRST_MARKED,
    });
    const secondLeg = byKey.get("gate:wayflow-task-a#2");
    expect(secondLeg).toMatchObject({ label: `Review · ${IMAGE}`, onStep: FIRST_MARKED });
    expect(secondLeg!.ordinal).toBeGreaterThan(2);
    expect(secondLeg!.ordinal).toBeLessThan(3);
    expect(byKey.get("gate:wayflow-task-b")).toMatchObject({
      ordinal: 4,
      kind: "gate",
      label: `Review · ${POST}`,
      status: "resolved",
      onStep: SECOND_MARKED,
    });
    expect(byKey.has(`step:${FIRST_MARKED}`)).toBe(false);
    expect(byKey.has(`step:${SECOND_MARKED}`)).toBe(false);
    expect(rail.entries.some((e) => e.label === "First review step" || e.label === "Second review step")).toBe(false);
    expect(rail.activeOrdinal).toBeNull();
  });

  it("N2 parked at the first marked step: the second marked step keeps its own entry, still to come", () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: [{ stepIndex: 1, answered: true }],
      gates: [gate("wayflow-task-a", "pending", 40, POST)],
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
      label: `Review · ${POST}`,
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
        gate("wayflow-task-b", "pending", 50, IMAGE),
      ],
    });

    const pending = rail.entries.find((e) => e.key === "gate:wayflow-task-b");
    expect(pending).toMatchObject({
      ordinal: 4,
      label: `Review · ${IMAGE}`,
      status: "pending",
      onStep: SECOND_MARKED,
    });
    // No review trails the spine: every gate stands in a marked step's place.
    expect(rail.entries.filter((e) => e.kind === "gate").every((e) => e.onStep !== undefined)).toBe(true);
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
      gates: [gate("wayflow-task-b", "pending", 50, IMAGE)],
    });

    const byKey = new Map(rail.entries.map((e) => [e.key, e]));
    expect(byKey.get("gate:wayflow-task-b")).toMatchObject({
      ordinal: 4,
      label: `Review · ${IMAGE}`,
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

  it("N6 a group beyond the marked steps and a gate of another prefix trail under their own label; no marked step places nothing", () => {
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

  it("N7 one pause's ten artifacts created at one instant keep the family's own order", () => {
    const family = ["wayflow-task-a", ...Array.from({ length: 9 }, (_, i) => `wayflow-task-a#${i + 2}`)];
    const rail = buildRunStepRail({
      templateSteps: templateSteps([FIRST_MARKED]),
      submissions: [{ stepIndex: 1, answered: true }],
      // Handed over in reverse, so only the comparison can put them right.
      gates: [...family].reverse().map((id) => gate(id, "resolved", 40)),
    });

    const gateKeys = rail.entries.filter((e) => e.kind === "gate").map((e) => e.key);
    expect(gateKeys).toEqual(family.map((id) => `gate:${id}`));
    expect(rail.entries.filter((e) => e.kind === "gate").every((e) => e.onStep === FIRST_MARKED)).toBe(true);
  });

  it("N8 a marked step that pauses twice cannot be tied by position: no gate is placed", () => {
    const steps = templateSteps().map((step) =>
      step.stepNumber === FIRST_MARKED ? { ...step, gateCount: 2 } : step,
    );
    const rail = buildRunStepRail({
      templateSteps: steps,
      submissions: [{ stepIndex: 1, answered: true }],
      gates: [
        gate("wayflow-task-a1", "resolved", 40),
        gate("wayflow-task-a2", "resolved", 45),
        gate("wayflow-task-b", "pending", 50),
      ],
    });

    expect(rail.entries.some((e) => e.onStep !== undefined)).toBe(false);
    const keys = rail.entries.map((e) => e.key);
    expect(keys).toEqual([
      "step:1",
      `step:${FIRST_MARKED}`,
      "step:7",
      `step:${SECOND_MARKED}`,
      "gate:wayflow-task-a1",
      "gate:wayflow-task-a2",
      "gate:wayflow-task-b",
    ]);
  });

  it("N9 two groups created at the same instant have no reach order: no gate is placed", () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: [{ stepIndex: 1, answered: true }],
      gates: [gate("wayflow-task-b", "pending", 40), gate("wayflow-task-a", "pending", 40)],
    });

    expect(rail.entries.some((e) => e.onStep !== undefined)).toBe(false);
    expect(rail.entries.filter((e) => e.kind === "step").map((e) => e.key)).toEqual([
      "step:1",
      `step:${FIRST_MARKED}`,
      "step:7",
      `step:${SECOND_MARKED}`,
    ]);
  });

  it("N10 a marked step that fell back with a bare approval raised no gate: the group stands in the next marked step", () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: [
        { stepIndex: 1, answered: true },
        // The walk gave the first marked step an answer that stored no values.
        { stepIndex: 2, answered: false },
        { stepIndex: 3, answered: true },
      ],
      gates: [gate("wayflow-task-b", "pending", 50, IMAGE)],
    });

    const byKey = new Map(rail.entries.map((e) => [e.key, e]));
    expect(byKey.get("gate:wayflow-task-b")).toMatchObject({ ordinal: 4, onStep: SECOND_MARKED });
    expect(byKey.get(`step:${FIRST_MARKED}`)).toMatchObject({ ordinal: 2, kind: "step" });
    expect(byKey.has(`step:${SECOND_MARKED}`)).toBe(false);
  });

  it("N11 the fallen-back marked step reads passed and the gate in the next marked step is active", () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: [
        { stepIndex: 1, answered: true },
        { stepIndex: 2, answered: false },
        { stepIndex: 3, answered: true },
      ],
      gates: [gate("wayflow-task-b", "pending", 50, IMAGE)],
    });

    const byKey = new Map(rail.entries.map((e) => [e.key, e]));
    expect(byKey.get(`step:${FIRST_MARKED}`)).toMatchObject({ ordinal: 2, status: "completed" });
    expect(rail.activeOrdinal).toBe(4);
    expect(rail.entries.find((e) => e.ordinal === rail.activeOrdinal)?.key).toBe("gate:wayflow-task-b");
  });

  it("N12 a gate time that is not a time leaves the reach order unproven: no gate is placed", () => {
    for (const createdAt of ["not a time", new Date(Number.NaN)]) {
      const rail = buildRunStepRail({
        templateSteps: templateSteps(),
        submissions: [{ stepIndex: 1, answered: true }],
        gates: [{ ...gate("wayflow-task-a", "resolved", 40), createdAt }, gate("wayflow-task-b", "pending", 50)],
      });

      expect(rail.entries.some((e) => e.onStep !== undefined)).toBe(false);
      expect(rail.entries.filter((e) => e.kind === "step").map((e) => e.key)).toEqual([
        "step:1",
        `step:${FIRST_MARKED}`,
        "step:7",
        `step:${SECOND_MARKED}`,
      ]);
    }
  });

  it("N13 two groups less than 2 ms apart have no proven reach order: no gate is placed", () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: [{ stepIndex: 1, answered: true }],
      gates: [
        { ...gate("wayflow-task-a", "resolved", 40), createdAt: "2026-09-29T10:40:00.000Z" },
        { ...gate("wayflow-task-b", "pending", 40), createdAt: "2026-09-29T10:40:00.001Z" },
      ],
    });

    expect(rail.entries.some((e) => e.onStep !== undefined)).toBe(false);
    expect(rail.entries.map((e) => e.key)).toEqual([
      "step:1",
      `step:${FIRST_MARKED}`,
      "step:7",
      `step:${SECOND_MARKED}`,
      "gate:wayflow-task-a",
      "gate:wayflow-task-b",
    ]);
  });

  it("N14 where no gate is placed, the active entry is the pending trailing gate, never a step still to come", () => {
    const twice = buildRunStepRail({
      templateSteps: templateSteps().map((step) =>
        step.stepNumber === FIRST_MARKED ? { ...step, gateCount: 2 } : step,
      ),
      submissions: [{ stepIndex: 1, answered: true }],
      gates: [
        gate("wayflow-task-a1", "resolved", 40),
        gate("wayflow-task-a2", "resolved", 45),
        gate("wayflow-task-b", "pending", 50),
      ],
    });
    expect(twice.entries.find((e) => e.ordinal === twice.activeOrdinal)?.key).toBe("gate:wayflow-task-b");

    const oneInstant = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: [{ stepIndex: 1, answered: true }],
      gates: [gate("wayflow-task-b", "pending", 40), gate("wayflow-task-a", "pending", 40)],
    });
    expect(oneInstant.entries.find((e) => e.ordinal === oneInstant.activeOrdinal)?.key).toBe(
      "gate:wayflow-task-a",
    );
  });

  it("N15 a walk stopped at the first marked step leaves its place unproven: no gate is placed", () => {
    for (const stoppedAt of [FIRST_MARKED, 1, 404]) {
      const rail = buildRunStepRail({
        templateSteps: templateSteps(),
        // The first marked step may have fallen back and been answered; the
        // walk stopped there, so it holds no submission.
        submissions: [{ stepIndex: 1, answered: true }],
        submissionsStoppedAtStep: stoppedAt,
        gates: [gate("wayflow-task-b", "pending", 50, IMAGE)],
      });

      expect(rail.entries.some((e) => e.onStep !== undefined)).toBe(false);
      expect(rail.entries.filter((e) => e.kind === "step").map((e) => e.key)).toEqual([
        "step:1",
        `step:${FIRST_MARKED}`,
        "step:7",
        `step:${SECOND_MARKED}`,
      ]);
      expect(rail.entries.find((e) => e.ordinal === rail.activeOrdinal)?.key).toBe("gate:wayflow-task-b");
    }
  });
});
