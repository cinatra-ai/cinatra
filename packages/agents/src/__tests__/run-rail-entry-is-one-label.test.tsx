// @vitest-environment jsdom
/**
 * A RAIL ENTRY IS ITS ONE NAME AND ITS STATE — NOTHING ELSE
 * (cinatra#3149, fix leg 4, finding 2).
 *
 * A proof round of this branch was refused on its own pictures: the rail's
 * review entry read "Review not classifiable", then the lattice's own word
 * beside it, then a whole sentence of reason beneath it — three pieces of text
 * where the drawing gives one.
 *
 * The ratified drawing, `specs/app-artifact-review.html` at design main
 * 033a697c, draws every rail entry the same way and draws it only once — a
 * glyph and ONE name:
 *
 *   div.step > span.glyph + span("Review")
 *
 * Its section I rule is what a settled entry gets on top of that name, and it
 * is a settlement, not a reason: "A resolved gate stays on the rail as
 * read-only history — its entry keeps its place and records how it was settled
 * (continued, superseded by a regeneration, changes requested)". Nowhere on the
 * rail does the drawing carry a reason sentence, a lattice layer or a machine
 * outcome, and the spec set carries no rail wording for a not-classifiable
 * review at all.
 *
 * SO THE PROJECTION'S LABEL ALREADY IS THE WHOLE ENTRY. `run-step-rail.ts`
 * builds "Review skipped", "Review not classifiable", "Review pending policy" —
 * the name with the settlement folded into it, exactly as the drawing folds
 * "Review · the post · continued" into one span. Anything past that label is
 * text the drawing does not give.
 *
 * THE MACHINE-CODE INSTRUMENT, HONESTLY. What the reader sees is
 * "NOT_CLASSIFIABLE", but the DOM carries `not_classifiable` and the badge's
 * own class uppercases it in CSS — so a bare `[A-Z_]{6,}` over `textContent`
 * would miss the very word the round photographed. Both instruments are
 * applied: the uppercase run over the text the reader SEES (the `uppercase`
 * styling applied), and an underscored identifier over the text the DOM
 * carries. A drawn label trips neither.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-rail-entry-is-one-label.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Stepper, StepperItem, StepperNav } from "@/components/reui/stepper";

import type { RunStepRailEntry } from "../run-step-rail";
import { RunStepRailPanel } from "../run-step-rail-panel";
import { RailExtraEntry, railSettlementWord } from "../run-step-rail-extra-entry";

afterEach(() => {
  cleanup();
});

const REVIEW_HREF_BASE = "/agents/acme/outreach/run-3149/review";

/** The sentence the refused round photographed under the label. */
const REASON = "the artifact was deleted before the review checkpoint could classify it";

/** The one drawn name of a not-classifiable review, as the projection builds it. */
const LIFECYCLE_LABEL = "Review not classifiable";

function lifecycleEntry(): RunStepRailEntry {
  return {
    key: "lifecycle:ev-1",
    ordinal: 4,
    kind: "lifecycleDecision",
    label: LIFECYCLE_LABEL,
    status: "skipped",
    sources: ["lifecycleDecision"],
    lifecycleDecision: {
      eventId: "ev-1",
      artifactId: "artifact-1",
      outcome: "not_classifiable",
      decidedBy: "fail-closed",
      latticeOutcome: "forbidden",
      reason: REASON,
    },
  } as RunStepRailEntry;
}

/** The rail a run that raised a gate, audited it and then hit a policy decision
 *  actually leaves — every kind of entry this component draws, side by side. */
function railEntries(): RunStepRailEntry[] {
  return [
    {
      key: "step:1",
      ordinal: 1,
      kind: "step",
      label: "Drafted the post",
      status: "completed",
      sources: ["template"],
    },
    {
      key: "gate:g1",
      ordinal: 2,
      kind: "gate",
      label: "Review",
      status: "resolved",
      sources: ["gate"],
      gate: {
        gateId: "g1",
        reviewTaskId: "task-1",
        disposition: "approved",
        resolved: true,
      },
    },
    {
      key: "verification:g1",
      ordinal: 3,
      kind: "verification",
      label: "Audit",
      status: "resolved",
      sources: ["verification"],
      verification: { gateId: "g1", reviewTaskId: "task-1", outcome: "verified" },
    },
    lifecycleEntry(),
  ] as RunStepRailEntry[];
}

/** The text the DOM carries for this row, whitespace collapsed. */
function domText(row: Element): string {
  return (row.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The text the READER sees: the same text with every `uppercase`-styled part
 * rendered the way the rail styles it. jsdom applies no stylesheet, so the
 * class is read off the element rather than off a computed style.
 */
function visualText(row: Element): string {
  const parts: string[] = [];
  const walk = (node: Node, upper: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? "";
      parts.push(upper ? t.toUpperCase() : t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const isUpper = upper || el.classList.contains("uppercase");
    for (const child of Array.from(el.childNodes)) walk(child, isUpper);
  };
  walk(row, false);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** A machine code as the reader meets it: a run of shouted letters. */
const SHOUTED_CODE = /[A-Z_]{6,}/;
/** A machine code as the DOM carries it: an underscored identifier. */
const IDENTIFIER = /[A-Za-z]+_[A-Za-z_]+/;

/**
 * The words the drawing DOES give a settled entry beside its name — "records
 * how it was settled" (section I). They are read off the entry itself rather
 * than listed here, and taken out of the text before the shouted-code
 * instrument runs: a settlement the drawing gives is not a machine code,
 * however the rail styles it.
 */
function settlementWords(entry: RunStepRailEntry): string[] {
  return [
    // THE WORD THE ROW ACTUALLY DRAWS, not the engine's own disposition
    // (cinatra#3149, fix leg 6, defect A). The row stopped printing the raw
    // value, so reading it off the entry would strip a word the row no longer
    // carries and leave the drawn one standing in front of the instrument.
    railSettlementWord(entry.gate?.disposition),
    entry.verification?.outcome,
  ].filter((w): w is string => typeof w === "string" && w.length > 0);
}

/** The visual text with the drawn settlement taken out. */
function textPastTheDrawnState(row: Element, entry: RunStepRailEntry): string {
  let text = visualText(row);
  for (const word of settlementWords(entry)) {
    text = text.split(word.toUpperCase()).join(" ").split(word).join(" ");
  }
  return text;
}

/** Every entry the rail drew, paired with the entry it was drawn from. */
function rows(container: HTMLElement): { row: HTMLElement; entry: RunStepRailEntry }[] {
  const drawn = Array.from(container.querySelectorAll<HTMLElement>("[data-rail-kind]"));
  const byKind = railEntries();
  return drawn.map((row) => {
    const kind = row.getAttribute("data-rail-kind");
    const entry = byKind.find((e) => e.kind === kind)!;
    return { row, entry };
  });
}

describe("every rail entry carries its one label and its drawn state", () => {
  it("draws a lifecycle decision as its label and nothing else", () => {
    const { container } = render(
      <RunStepRailPanel
        entries={railEntries()}
        activeOrdinal={null}
        reviewHrefBase={REVIEW_HREF_BASE}
      />,
    );

    const row = container.querySelector<HTMLElement>(
      '[data-rail-kind="lifecycleDecision"]',
    )!;
    expect(row).not.toBeNull();
    // The whole entry, on the drawing's own terms: one name.
    expect(domText(row)).toBe(LIFECYCLE_LABEL);
  });

  it("draws no reason sentence on the rail — the drawing gives it no place there", () => {
    const { container } = render(
      <RunStepRailPanel
        entries={railEntries()}
        activeOrdinal={null}
        reviewHrefBase={REVIEW_HREF_BASE}
      />,
    );

    expect(container.querySelector("[data-rail-lifecycle-reason]")).toBeNull();
    expect(container.textContent ?? "").not.toContain(REASON);
  });

  it("carries NO machine code in any entry, in the DOM or on the reader's screen", () => {
    const { container } = render(
      <RunStepRailPanel
        entries={railEntries()}
        activeOrdinal={null}
        reviewHrefBase={REVIEW_HREF_BASE}
      />,
    );

    const drawn = rows(container);
    expect(drawn.length).toBe(4);
    for (const { row, entry } of drawn) {
      const past = textPastTheDrawnState(row, entry);
      expect(
        SHOUTED_CODE.test(past),
        `the reader sees a machine code in "${visualText(row)}"`,
      ).toBe(false);
      expect(
        IDENTIFIER.test(domText(row)),
        `the row carries a machine identifier in "${domText(row)}"`,
      ).toBe(false);
    }
  });

  it("draws each entry as ONE line — no second block beneath the name", () => {
    const { container } = render(
      <RunStepRailPanel
        entries={railEntries()}
        activeOrdinal={null}
        reviewHrefBase={REVIEW_HREF_BASE}
      />,
    );

    for (const { row } of rows(container)) {
      // A `block` inside a row's TITLE is a second line by construction — the
      // reason was drawn exactly that way.
      expect(
        row.querySelectorAll('[data-slot="stepper-title"] .block'),
      ).toHaveLength(0);
    }
  });

  it("tells the reader nothing extra through a tooltip either", () => {
    const { container } = render(
      <RunStepRailPanel
        entries={railEntries()}
        activeOrdinal={null}
        reviewHrefBase={REVIEW_HREF_BASE}
      />,
    );

    for (const { row } of rows(container)) {
      expect(row.getAttribute("title")).toBeNull();
    }
  });

  it("keeps the lattice's own words as passive data, never as drawn text", () => {
    // The outcome and the decider are still on the row for a proof to read —
    // they are simply not text the reader is shown.
    const { container } = render(
      <RunStepRailPanel
        entries={railEntries()}
        activeOrdinal={null}
        reviewHrefBase={REVIEW_HREF_BASE}
      />,
    );

    const row = container.querySelector<HTMLElement>(
      '[data-rail-kind="lifecycleDecision"]',
    )!;
    expect(row.getAttribute("data-rail-lifecycle-decision")).toBe("not_classifiable");
    expect(row.getAttribute("data-rail-lifecycle-decided-by")).toBe("fail-closed");
  });
});

// ---------------------------------------------------------------------------
// A SETTLED GATE ENTRY RECORDS ITS SETTLEMENT IN THE DRAWING'S WORD
// (cinatra#3149, fix leg 6, defect A)
// ---------------------------------------------------------------------------
//
// The fifth proof round read the engine's own decision verb on this row --
// "APPROVE", the gate row's `disposition` column printed verbatim and shouted
// by the badge's `uppercase` class. Section I gives a settled entry a word:
// "records how it was settled (continued, superseded by a regeneration, changes
// requested)"; section XI: "Continued is the only settled reading a display
// has"; and the drawing's own settled entry reads "Review the post continued".

/** A resolved gate entry, settled with the engine's own disposition. */
function settledGateEntry(disposition: string): RunStepRailEntry {
  return {
    key: "gate:g1",
    ordinal: 2,
    kind: "gate",
    label: "Review",
    status: "resolved",
    sources: ["gate"],
    gate: {
      gateId: "g1",
      reviewTaskId: "task-1",
      disposition,
      resolved: true,
    },
  } as RunStepRailEntry;
}

function renderSettledGate(disposition: string) {
  return render(
    <Stepper value={1}>
      <StepperNav>
        <StepperItem step={1}>
          <RailExtraEntry
            entry={settledGateEntry(disposition)}
            reviewHrefBase={REVIEW_HREF_BASE}
          />
        </StepperItem>
      </StepperNav>
    </Stepper>,
  );
}

function gateRow(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-rail-kind="gate"]')!;
}

describe("a settled gate entry records its settlement in the drawing's word", () => {
  it("reads 'continued' for an approve — never the engine's own verb", () => {
    const { container } = renderSettledGate("approve");
    const row = gateRow(container);

    // The settlement the row draws, on the drawing's own terms. (The name and
    // the settlement are two spans set apart by the row's own margin, so the DOM
    // carries no whitespace between them — the word is read off its own element
    // and the whole entry is then read as those two pieces and nothing else.)
    expect(row.querySelector("[data-rail-gate-settlement]")!.textContent).toBe(
      "continued",
    );
    expect(domText(row)).toBe("Reviewcontinued");
    // And what the READER sees is the same word — the badge no longer shouts it.
    expect(visualText(row)).toBe("Reviewcontinued");
    expect(visualText(row)).not.toContain("APPROVE");
    expect(domText(row).toLowerCase()).not.toContain("approve");
  });

  it("maps every disposition that can resolve a gate to a drawn word, and to no code", () => {
    const cases: Array<[string, string]> = [
      ["approve", "continued"],
      ["approved", "continued"],
      ["reject", "superseded by a regeneration"],
      ["rejected", "superseded by a regeneration"],
      ["changes_requested", "changes requested"],
    ];
    for (const [disposition, word] of cases) {
      const { container } = renderSettledGate(disposition);
      const row = gateRow(container);
      expect(
        row.querySelector("[data-rail-gate-settlement]")!.textContent,
        disposition,
      ).toBe(word);
      // The entry is its one name and that settlement, and nothing else.
      expect(domText(row), disposition).toBe(`Review${word}`);
      // The same two instruments the rest of this suite uses: no shouted code on
      // the reader's screen, no underscored identifier in the DOM.
      expect(SHOUTED_CODE.test(visualText(row)), disposition).toBe(false);
      expect(IDENTIFIER.test(domText(row)), disposition).toBe(false);
      cleanup();
    }
  });

  it("answers the drawing's own word to a row that already carries it", () => {
    // Not every feed of this rail speaks the engine's vocabulary: a surface
    // that declares its own rows carries the settlement section I names. A map
    // that answered null to the drawing's own word would take the settled
    // reading off the row entirely -- the opposite of what section I asks for.
    for (const [declared, word] of [
      ["continued", "continued"],
      ["superseded by a regeneration", "superseded by a regeneration"],
      ["changes requested", "changes requested"],
    ] as Array<[string, string]>) {
      const { container } = renderSettledGate(declared);
      const row = gateRow(container);
      expect(
        row.querySelector("[data-rail-gate-settlement]")!.textContent,
        declared,
      ).toBe(word);
      expect(domText(row), declared).toBe(`Review${word}`);
      expect(SHOUTED_CODE.test(visualText(row)), declared).toBe(false);
      cleanup();
    }
  });

  it("draws NO settlement at all for a value it cannot name — never the raw one", () => {
    const { container } = renderSettledGate("escalated_to_org_route");
    const row = gateRow(container);

    // The entry keeps its place and its one label, which is what section I gives
    // it before any settlement is added.
    expect(domText(row)).toBe("Review");
    expect(row.querySelector("[data-rail-gate-settlement]")).toBeNull();
    expect(IDENTIFIER.test(domText(row))).toBe(false);
  });

  it("keeps the engine's own disposition as passive data a walk can still read", () => {
    const { container } = renderSettledGate("approve");
    // Not text the reader is shown — the same treatment fix leg 4 gave the
    // lattice's own words.
    expect(gateRow(container).getAttribute("data-rail-gate-disposition")).toBe("approve");
  });

  it("leaves a PENDING gate exactly as it was — a settlement is for a settled entry", () => {
    const entry = { ...settledGateEntry("approve"), status: "pending" } as RunStepRailEntry;
    const { container } = render(
      <Stepper value={1}>
        <StepperNav>
          <StepperItem step={1}>
            <RailExtraEntry entry={entry} reviewHrefBase={REVIEW_HREF_BASE} />
          </StepperItem>
        </StepperNav>
      </Stepper>,
    );
    const row = gateRow(container);
    expect(domText(row)).toBe("Review");
    expect(row.querySelector("[data-rail-gate-settlement]")).toBeNull();
  });
});

describe("the same reading on the live rail's own row component", () => {
  it("RailExtraEntry draws the lifecycle entry as its one label", () => {
    const { container } = render(
      <Stepper value={1}>
        <StepperNav>
          <StepperItem step={1}>
            <RailExtraEntry
              entry={lifecycleEntry()}
              reviewHrefBase={REVIEW_HREF_BASE}
            />
          </StepperItem>
        </StepperNav>
      </Stepper>,
    );

    const row = container.querySelector<HTMLElement>(
      '[data-rail-kind="lifecycleDecision"]',
    )!;
    expect(domText(row)).toBe(LIFECYCLE_LABEL);
    expect(container.querySelector("[data-rail-lifecycle-reason]")).toBeNull();
    expect(SHOUTED_CODE.test(textPastTheDrawnState(row, lifecycleEntry()))).toBe(false);
    expect(IDENTIFIER.test(domText(row))).toBe(false);
  });
});
