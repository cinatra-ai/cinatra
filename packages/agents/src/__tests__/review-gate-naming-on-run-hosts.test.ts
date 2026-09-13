/**
 * THE GATE HEADER'S NAMING LINE, ON THE SURFACES A RUN ACTUALLY PARKS ON
 * (cinatra#3080, fix leg 8).
 *
 * WHAT THE NINTH ROUND READ. "the mono naming line `run 1551362…` on the same
 * baseline — the naming line carries the run reference alone, not the agent name
 * plus step position the ratified drawing shows."
 *
 * THE DRAWING, IN ITS OWN MARKUP (Lifecycle cards §XIII.1, the in-run review
 * gate drawn outside a conversation):
 *
 *   <span …>Review</span>
 *   <span style="font-family:var(--font-mono);…">Outreach agent · run rn_8f31… · step 4 of 6</span>
 *
 * THREE SEGMENTS, AND WHO OWES THEM. `reviewGateNamingLine` already joins
 * whatever it is handed and leaves out what it cannot name truthfully — and
 * `review-gate-card.tsx` states whose job the facts are: "The naming is the
 * HOST's to supply, not the wire's: the run surface that draws this gate already
 * knows the agent, the run and the step". Four hosts mount the card. The review
 * page and the orchestrator stepper panel already hand down all three (fix leg
 * 7). The two the ninth round actually exercised — the run page's own panel, and
 * the setup run page's review step — handed down the run alone. This suite pins
 * every mount, so a fifth host cannot be added silently with two of three.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { reviewGateNamingLine } from "../review-gate-card";
import { railStepPosition } from "../run-step-rail";
import { runGateRailStepKeys, setupReviewStepPosition } from "../instance-screens";
import { runSurfaceRailNumberedCount } from "../run-surface-rail-step";

const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf-8");

/** Every `<ReviewGateCard …/>` element in a source file, as its own text. */
function gateMounts(src: string): string[] {
  const out: string[] = [];
  let at = src.indexOf("<ReviewGateCard");
  while (at >= 0) {
    const end = src.indexOf("/>", at);
    if (end < 0) break;
    out.push(src.slice(at, end + 2));
    at = src.indexOf("<ReviewGateCard", end);
  }
  return out;
}

const HOSTS: ReadonlyArray<readonly [string, string]> = [
  ["the run page's own panel", "agentic-run-panel.tsx"],
  ["the setup run page's review step", "instance-screens.tsx"],
  ["the orchestrator stepper panel", "orchestrator-stepper-panel.tsx"],
];

describe("§XIII.1 — every run-surface mount hands the header all three segments", () => {
  for (const [what, file] of HOSTS) {
    it(`${what} names the agent, the run and the step`, () => {
      const mounts = gateMounts(read(file));
      expect(mounts.length, `${file} mounts the card`).toBeGreaterThan(0);
      for (const mount of mounts) {
        expect(mount, `${file}: runId`).toContain("runId=");
        expect(mount, `${file}: agentLabel`).toContain("agentLabel=");
        expect(mount, `${file}: step`).toContain("step=");
      }
    });
  }
});

describe("the line the drawing prints, composed from what those hosts hand down", () => {
  it("reads agent · run · step, in the drawing's own order", () => {
    expect(
      reviewGateNamingLine({
        agentLabel: "Outreach agent",
        runId: "rn_8f3172c",
        step: { index: 4, total: 6 },
      }),
    ).toBe("Outreach agent · run rn_8f31… · step 4 of 6");
  });

  it("still names only what it can name truthfully", () => {
    expect(
      reviewGateNamingLine({ agentLabel: null, runId: "rn_8f3172c", step: null }),
    ).toBe("run rn_8f31…");
  });
});

describe("where the step position comes from", () => {
  const entries = [
    { key: "step:1" },
    { key: "gate:lifecycle-review:auto:1" },
    { key: "verification:lifecycle-review:auto:1" },
    { key: "step:2" },
  ];

  it("reads the gate's place off the run's own rail", () => {
    expect(railStepPosition(entries, "gate:lifecycle-review:auto:1")).toEqual({
      index: 2,
      total: 4,
    });
  });

  it("names nothing for a key the rail does not carry", () => {
    expect(railStepPosition(entries, "gate:absent")).toBeNull();
    expect(railStepPosition(entries, null)).toBeNull();
  });

  it("puts the setup page's review last, after the run's answered input steps", () => {
    expect(setupReviewStepPosition(0)).toEqual({ index: 3, total: 3 });
    expect(setupReviewStepPosition(2)).toEqual({ index: 5, total: 5 });
  });
});

describe("§XIII.1 — the header's numeral is the RAIL's numeral, not a count of entries", () => {
  // THE CONVERGENCE FINDING THIS PINS (cinatra#3080, fix leg 8). The rail beside
  // the gate does not number its work entries from one: the gate ROWS that head
  // it — a recommendation hold, the run's input forms, an armed schedule —
  // consume numerals first, and the rail's own panel draws each work entry as
  // `index + 1 + stepOffset` for exactly that reason (cinatra#3047). A header
  // counting `rail.entries` alone therefore named "step 3 of 5" beside a rail
  // row reading "4" — the line and the rail disagreeing about which step this
  // is, which is the one thing reading the position off the rail exists to make
  // impossible.
  const entries = [
    { key: "step:1" },
    { key: "gate:rt-1" },
    { key: "step:2" },
  ];

  it("offsets both halves of the reading by the numerals the gate rows consumed", () => {
    expect(railStepPosition(entries, "gate:rt-1", 0)).toEqual({ index: 2, total: 3 });
    expect(railStepPosition(entries, "gate:rt-1", 2)).toEqual({ index: 4, total: 5 });
  });

  it("is the SAME numeral the rail draws for that row", () => {
    // The rail's panel draws entry i as `i + 1 + stepOffset`; the gate is entry
    // index 1, so with two numerals consumed above it the row reads "4" — and
    // the header must read "step 4".
    const stepOffset = 2;
    const railNumeralForTheGate = 1 + 1 + stepOffset;
    expect(railStepPosition(entries, "gate:rt-1", stepOffset)?.index).toBe(railNumeralForTheGate);
  });

  it("takes its offset from the rail's own key list, in the rail's own order", () => {
    // The keys the run screen hands the numeral count come from one list, built
    // from the same predicates the rail's rows are built from — a recommendation
    // hold and an armed schedule each consume a numeral, and the Skills row that
    // draws a glyph consumes none (cinatra#3047).
    const keys = runGateRailStepKeys({
      hasRecommendationStep: true,
      inputStepsInRail: true,
      inputStepKeys: ["input:0", "input:1"] as never,
      hasScheduleStep: true,
      drawUpcoming: false,
    });
    expect(keys).toEqual(["recommendation", "input:0", "input:1", "schedule"]);
    // "recommendation" is the glyph row and consumes NO numeral; the two input
    // forms and the schedule consume three between them.
    expect(runSurfaceRailNumberedCount(keys)).toBe(3);
    expect(railStepPosition(entries, "gate:rt-1", runSurfaceRailNumberedCount(keys))).toEqual({
      index: 5,
      total: 6,
    });
  });

  it("answers nothing extra where no gate row heads the rail", () => {
    const keys = runGateRailStepKeys({
      hasRecommendationStep: false,
      inputStepsInRail: false,
      inputStepKeys: [],
      hasScheduleStep: false,
      drawUpcoming: false,
    });
    expect(keys).toEqual([]);
    expect(railStepPosition(entries, "gate:rt-1", runSurfaceRailNumberedCount(keys))).toEqual({
      index: 2,
      total: 3,
    });
  });
});
