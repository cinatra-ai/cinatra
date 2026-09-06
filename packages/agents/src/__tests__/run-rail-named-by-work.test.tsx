// @vitest-environment jsdom
/**
 * A RAIL ENTRY IS NAMED BY ITS WORK, NEVER BY ITS POSITION (cinatra#3226).
 *
 * The ratified drawing, agent run and review surface, "The step rail — merged
 * steps and gate entries": "A work step shows what it did; a gate step opens
 * the gate's own surface in place", and "so the rail is the run's whole
 * lifecycle at a glance, not just its live tip." Its drawn rail names every
 * entry by the work done — "Skills", "Fetched Q3 cohort", "Drafted
 * re-engagement email", "Review", "Send sequence" — never by its position. An
 * ordinal defeats the glance: it is legible only by counting.
 *
 * THE ELECTED LADDER, at both sites that composed an ordinal: the executed
 * step's own recorded name; then its recorded description; then the name of
 * the work that step produced, as the run's own record of that step carries
 * it. Where none resolves, a surplus record is not drawn as a named work step
 * at all; a spine step keeps its rung (the ladder's positions are what the
 * live resolver and the replay map key on) and is titled by nothing.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-rail-named-by-work.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { buildRunStepRail, type RailTemplateStep } from "../run-step-rail";
import { buildRunStepperSteps } from "../run-stepper-steps";
import { RunStepRailPanel } from "../run-step-rail-panel";
import { stepRecordWorkName } from "../step-work-name";

const ORDINAL = /^Step \d+$/;

afterEach(() => {
  cleanup();
});

const tstep = (index: number, stepNumber: number, label: string): RailTemplateStep => ({
  index,
  stepNumber,
  label,
});

function renderPanel(entries: ReturnType<typeof buildRunStepRail>["entries"]) {
  return render(
    <RunStepRailPanel entries={entries} activeOrdinal={null} reviewHrefBase="/agents/v/p/run/review" />,
  );
}

function titles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-slot="stepper-title"]')).map(
    (t) => t.textContent ?? "",
  );
}

function markers(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-slot="stepper-indicator"]')).map(
    (m) => m.textContent ?? "",
  );
}

// ---------------------------------------------------------------------------
// Item 1 — no entry's label is an ordinal, named or not.
// ---------------------------------------------------------------------------
describe("no rail entry's label is an ordinal (item 1)", () => {
  it("names every entry by its work for a run whose steps carry names", () => {
    const rail = buildRunStepRail({
      templateSteps: [tstep(1, 10, "Fetched Q3 cohort")],
      stepResults: [{ out: "cohort" }, { name: "Drafted re-engagement email" }],
    });
    const { container } = renderPanel(rail.entries);
    const drawn = titles(container);
    expect(drawn).toEqual(["Fetched Q3 cohort", "Drafted re-engagement email"]);
    for (const label of drawn) expect(label).not.toMatch(ORDINAL);
  });

  it("draws no ordinal for a run whose surplus steps carry no name at all", () => {
    const rail = buildRunStepRail({
      templateSteps: [tstep(1, 10, "Fetched Q3 cohort")],
      stepResults: [{ out: "cohort" }, { out: "b" }, { out: "c" }],
    });
    const { container } = renderPanel(rail.entries);
    for (const label of titles(container)) expect(label).not.toMatch(ORDINAL);
    expect(container.textContent).not.toMatch(/Step \d+/);
  });
});

// ---------------------------------------------------------------------------
// Item 2 — the ladder at the rail projection (run-step-rail.ts).
// ---------------------------------------------------------------------------
describe("the elected ladder resolves at the rail projection (item 2)", () => {
  const spine = [tstep(1, 10, "Fetched Q3 cohort")];
  const surplus = (record: unknown) =>
    buildRunStepRail({ templateSteps: spine, stepResults: [{ out: "a" }, record] }).entries.find(
      (e) => e.key === "stepResult:1",
    );

  it("takes the recorded name first", () => {
    expect(surplus({ name: "Drafted re-engagement email", description: "wrote the draft" })?.label).toBe(
      "Drafted re-engagement email",
    );
  });

  it("takes the recorded description when there is no name", () => {
    expect(surplus({ description: "Drafted the re-engagement email" })?.label).toBe(
      "Drafted the re-engagement email",
    );
  });

  it("takes the name of the work the step produced when there is neither", () => {
    expect(surplus({ output_data: { title: "Re-engagement email" } })?.label).toBe("Re-engagement email");
    expect(
      surplus({ kind: "wayflow_response", a2aTaskId: "t1", output_data: { name: "Q3 draft" } })?.label,
    ).toBe("Q3 draft");
  });

  it("reads no name off a materialization outcome, which carries only identifiers", () => {
    // The real `RunArtifactMaterializationOutcome` (src/lib/artifacts/
    // run-artifact-materializer.ts): outputId, nodeId, extension, artifactId,
    // representationRevisionId, deduped — no title, no name. A record whose
    // only content is such outcomes names nothing and is not drawn.
    expect(
      surplus({
        kind: "external_a2a_response",
        a2aTaskId: "t1",
        artifact_materializations: [
          {
            ok: true,
            outputId: "draft",
            nodeId: "n1",
            extension: "@cinatra-ai/document-artifact",
            artifactId: "art-1",
            representationRevisionId: "rev-1",
            deduped: false,
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("keeps the ordinals the entries are RANKED by intact while their labels are names", () => {
    const rail = buildRunStepRail({
      templateSteps: spine,
      stepResults: [{ out: "a" }, { name: "Second" }, { name: "Third" }],
    });
    expect(rail.entries.map((e) => [e.key, e.ordinal, e.label])).toEqual([
      ["step:10", 1, "Fetched Q3 cohort"],
      ["stepResult:1", 2, "Second"],
      ["stepResult:2", 3, "Third"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Item 3 — the ladder at the spine projection (run-stepper-steps.ts).
// ---------------------------------------------------------------------------
describe("the elected ladder resolves at the spine projection (item 3)", () => {
  it("takes the produced work's name for a declaration with neither name nor description, composing no ordinal", () => {
    const steps = buildRunStepperSteps(
      [{ stepNumber: 4, xRenderer: "@cinatra-ai/email-drafts-agent:output" }],
      { stepResults: [{ output_data: { title: "Drafted re-engagement email" } }] },
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).toBe("Drafted re-engagement email");
    expect(steps[0]!.label).not.toMatch(ORDINAL);
    expect(steps[0]!.index).toBe(1);
    expect(steps[0]!.stepNumber).toBe(4);
  });

  it("still prefers the declaration's own name, then its description", () => {
    const records = { stepResults: [{ name: "from the record" }] };
    expect(buildRunStepperSteps([{ stepNumber: 1, xRenderer: "r", name: "Declared" }], records)[0]!.label).toBe(
      "Declared",
    );
    expect(
      buildRunStepperSteps([{ stepNumber: 1, xRenderer: "r", description: "Described" }], records)[0]!.label,
    ).toBe("Described");
  });

  it("composes no ordinal when nothing resolves, and keeps the rung", () => {
    const steps = buildRunStepperSteps([{ stepNumber: 7, xRenderer: "r" }]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.label).not.toMatch(ORDINAL);
    expect(steps[0]!.label).toBe("");
    expect(steps[0]!.index).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Item 4 — where nothing resolves, the entry is absent, not numbered.
// ---------------------------------------------------------------------------
describe("where nothing resolves the entry is not drawn as a named work step (item 4)", () => {
  it("omits a surplus record that names nothing rather than numbering it", () => {
    const rail = buildRunStepRail({
      templateSteps: [tstep(1, 10, "Fetched Q3 cohort")],
      stepResults: [{ out: "a" }, { out: "b" }],
    });
    expect(rail.entries.map((e) => e.key)).toEqual(["step:10"]);
    const { container } = renderPanel(rail.entries);
    expect(titles(container)).toEqual(["Fetched Q3 cohort"]);
  });

  it("omits a null surplus record the same way", () => {
    const rail = buildRunStepRail({ templateSteps: [], stepResults: [null, { name: "Named" }] });
    expect(rail.entries.map((e) => [e.key, e.label])).toEqual([["stepResult:1", "Named"]]);
  });

  it("reads nothing off a record that carries only identifiers", () => {
    // An orchestrator ledger entry: ids and a package name, no name of work.
    expect(
      stepRecordWorkName({
        childRunId: "run-1",
        packageName: "@cinatra-ai/blog-draft-writer-agent",
        packageVersion: "1.0.0",
        status: "completed",
        a2aTaskId: null,
        artifactIds: ["art-1"],
      }),
    ).toBeNull();
    expect(stepRecordWorkName({ name: "   " })).toBeNull();
    expect(stepRecordWorkName("a bare string")).toBeNull();
    expect(stepRecordWorkName(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Item 5 — the marker keeps the position; the label carries the work.
// ---------------------------------------------------------------------------
describe("the number drawn as the entry's own marker is untouched (item 5)", () => {
  it("still draws the position in the marker while the label names the work", () => {
    const rail = buildRunStepRail({
      templateSteps: [tstep(1, 10, "Fetched Q3 cohort"), tstep(2, 20, "Drafted re-engagement email")],
      stepResults: [null, null, { name: "Sent sequence" }],
    });
    const { container } = render(
      <RunStepRailPanel entries={rail.entries} activeOrdinal={1} reviewHrefBase="/agents/v/p/run/review" />,
    );
    // The two entries still ahead draw their position; the settled surplus
    // entry draws the rail's own settled glyph in the marker, as it always did
    // — the label is what changed, and it names the work.
    const drawn = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="stepper-indicator"]'));
    expect(drawn.length).toBe(3);
    expect(markers(container).slice(0, 2)).toEqual(["1", "2"]);
    expect(drawn[2]!.querySelector("svg")).not.toBeNull();
    expect(titles(container)).toEqual([
      "Fetched Q3 cohort",
      "Drafted re-engagement email",
      "Sent sequence",
    ]);
  });

  it("draws the position in the marker of a step the LADDER named, while its label names the work", () => {
    // A declaration that names nothing, named by the run's own record of it
    // (the spine ladder's third rung), drawn where its marker is still the
    // numeral: the entry is upcoming on the rail, so the marker carries its
    // position and the label carries the work — the two are independent.
    const spine = buildRunStepperSteps(
      [
        { stepNumber: 1, xRenderer: "r", name: "Setup" },
        { stepNumber: 2, xRenderer: "r" },
      ],
      { stepResults: [null, { output_data: { title: "Fetched Q3 cohort" } }] },
    ).map((s) => ({ index: s.index, stepNumber: s.stepNumber, label: s.label }));
    expect(spine.map((s) => s.label)).toEqual(["Setup", "Fetched Q3 cohort"]);
    // The run is paused on the first entry, so the ladder-named second entry
    // is still ahead: its marker is the numeral, not the settled glyph.
    const rail = buildRunStepRail({ templateSteps: spine, stepResults: [] });
    const { container } = render(
      <RunStepRailPanel entries={rail.entries} activeOrdinal={1} reviewHrefBase="/agents/v/p/run/review" />,
    );
    expect(markers(container)).toEqual(["1", "2"]);
    expect(titles(container)).toEqual(["Setup", "Fetched Q3 cohort"]);
  });
});
