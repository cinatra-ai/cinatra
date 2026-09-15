/**
 * A STEP SHOWN INSIDE THE FRAME LIGHTS NO TAB (cinatra#3068, fix leg 3).
 *
 * The ratified drawing, in the run view's conditional-tab section: "A step shown
 * inside the frame selects nothing ... no tab is drawn selected."
 *
 * WHAT WAS MEASURED. On the third graded reading of this branch, while the run's
 * first step -- the agent's own input form -- was drawn inside the frame on the
 * run's own path, the Setup tab drew lit: a 2 CSS px primary underline under it,
 * `aria-selected` true, `data-state` active. The strip claimed the reader was in
 * the body of a tab while what stood there was a step.
 *
 * NOT THE SAME ROUTE as the schedule step's reading tracked elsewhere: this is
 * the run's own path, where the input step is drawn, and the page hard-coded the
 * Setup tab for every moment on it.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/instance-screens-no-lit-tab-inside-the-frame.test.tsx
 */
import * as fs from "node:fs";
import * as path from "node:path";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentInstanceNav } from "@/components/agent-instance-nav";

import {
  recommendationRailEntry,
  recommendationRailStepOpens,
} from "../recommendation-rail-entry";

import { runGateStepInFrame, runPageActiveTab } from "../instance-screens";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

const ACTIVE_STATE = `data-state=${JSON.stringify("active")}`;
const SELECTED = `aria-selected=${JSON.stringify("true")}`;

function strip(
  moment: {
    inputStepIsOpen: boolean;
    inputStepsInRail: boolean;
    scheduleStepInFrame: boolean;
    gateStepInFrame: boolean;
  },
  showTriggerTab = false,
): string {
  return renderToStaticMarkup(
    <AgentInstanceNav
      agentId="acme/blog-idea-generator-agent"
      instanceId="run-1"
      activeTab={runPageActiveTab(moment)}
      showTriggerTab={showTriggerTab}
    />,
  );
}

/** The form the run is asking right now. */
const OPEN = {
  inputStepIsOpen: true,
  inputStepsInRail: true,
  scheduleStepInFrame: false,
  gateStepInFrame: false,
};
/** The same step, answered -- its row still on the rail, its screen read-only. */
const SETTLED = {
  inputStepIsOpen: false,
  inputStepsInRail: true,
  scheduleStepInFrame: false,
  gateStepInFrame: false,
};
/** Every moment on this path that draws no input step at all. */
const NO_INPUT_STEP = {
  inputStepIsOpen: false,
  inputStepsInRail: false,
  scheduleStepInFrame: false,
  gateStepInFrame: false,
};
/** No input step, and the SCHEDULE step is the one in the frame (cinatra#3182). */
const SCHEDULE_STEP = {
  inputStepIsOpen: false,
  inputStepsInRail: false,
  scheduleStepInFrame: true,
  gateStepInFrame: false,
};
/**
 * THE SKILLS GATE IS THE STEP IN THE FRAME (cinatra#3184 item 3). One fixture
 * for BOTH of its readings, because the span the page answers holds both: the
 * gate is the step in the frame for as long as its row CAN BE OPENED and the run
 * has produced no execution record -- while the question is held, and after it
 * is settled and its row is re-opened.
 */
const GATE_STEP = {
  inputStepIsOpen: false,
  inputStepsInRail: false,
  scheduleStepInFrame: false,
  gateStepInFrame: true,
};

describe("the run page's tab strip while a step is drawn inside the frame", () => {
  it("draws NO tab selected while the input step is the step in the frame", () => {
    const html = strip(OPEN);
    expect(html).not.toContain(ACTIVE_STATE);
    expect(html).not.toContain(SELECTED);
  });

  // THE ANSWERED FORM IS STILL THAT STEP. A person answers the run's first step
  // and presses its row: the rail keeps the entry, the frame draws the step's
  // read-only screen -- and the first reading of this fix lit Setup under it
  // again, which is the very reading the drawing forbids.
  it("draws NO tab selected while the SETTLED input step is the step in the frame", () => {
    const html = strip(SETTLED);
    expect(html).not.toContain(ACTIVE_STATE);
    expect(html).not.toContain(SELECTED);
    expect(runPageActiveTab(SETTLED)).toBe("none");
  });

  it("still carries the SAME tabs -- the strip is part of the constant frame", () => {
    const html = strip(OPEN);
    expect(html).toContain(">Setup<");
    expect(html).toContain(">Permissions<");
    expect(strip(SETTLED)).toContain(">Setup<");
    expect(strip(OPEN, true)).toContain(">Schedule<");
  });

  it("lights Setup again for every moment that draws no input step", () => {
    const html = strip(NO_INPUT_STEP);
    expect(html).toContain(ACTIVE_STATE);
    expect(runPageActiveTab(NO_INPUT_STEP)).toBe("setup");
  });
});

// THE TWO SPANS ANSWER ONE PROP (the merge-forward with cinatra#3182 item 8).
// The run page draws ONE tab strip, so the run's own input span and the
// schedule step's span cannot each hand it an answer. This reading owns both,
// and neither span loses the answer the drawing gives it.
describe("either step drawn inside the frame lights no tab", () => {
  it("still draws NO tab selected while the SCHEDULE step is the step in the frame", () => {
    expect(runPageActiveTab(SCHEDULE_STEP)).toBe("none");
    const html = strip(SCHEDULE_STEP);
    expect(html).not.toContain(ACTIVE_STATE);
    expect(html).not.toContain(SELECTED);
  });

  it("lights Setup only when NEITHER step is in the frame", () => {
    expect(runPageActiveTab(NO_INPUT_STEP)).toBe("setup");
    expect(
      runPageActiveTab({ ...OPEN, scheduleStepInFrame: true }),
    ).toBe("none");
    expect(
      runPageActiveTab({ ...SETTLED, scheduleStepInFrame: true }),
    ).toBe("none");
  });
});

// THE SKILLS GATE IS A STEP IN THIS FRAME TOO (cinatra#3184 item 3).
//
// Application Design - Agents, the run view's conditional-tab section: "A step
// shown inside the frame selects nothing ... no tab is drawn selected. ... The
// frame, the title row and the etched rule are unchanged", and "A step drawn
// inside this frame never lights a tab the strip does not carry."
//
// WHAT WAS MEASURED. A run held at its skills question drew that step inside the
// frame and the strip lit Setup under it -- the same contradiction the input and
// schedule spans already answer, on the one step neither of them covers.
describe("the skills gate drawn inside the frame lights no tab", () => {
  it("draws NO tab selected while the skills gate is the step in the frame", () => {
    expect(runPageActiveTab(GATE_STEP)).toBe("none");
    const html = strip(GATE_STEP);
    expect(html).not.toContain(ACTIVE_STATE);
    expect(html).not.toContain(SELECTED);
  });

  it("still carries the SAME tabs under the gate step -- the frame is unchanged", () => {
    const html = strip(GATE_STEP);
    expect(html).toContain(">Setup<");
    expect(html).toContain(">Permissions<");
    expect(strip(GATE_STEP, true)).toContain(">Schedule<");
  });

  // THE SPAN, NOT THE MOMENT. The strip's answer is a server prop and the rail's
  // selection is the reader's own, so an answer scoped to "the gate is open right
  // now" would light Setup again the moment a reader re-opened the settled row.
  // The span the page answers is therefore the whole span in which the gate's
  // row can be opened and the run has produced no execution record -- the held
  // reading and the re-opened settled reading both fall inside it.
  it("reads the whole span the gate's row can be opened, held or settled", () => {
    expect(
      runGateStepInFrame({ gateStepOpens: true, hasExecution: false }),
    ).toBe(true);
    expect(
      runGateStepInFrame({ gateStepOpens: false, hasExecution: false }),
    ).toBe(false);
    // WHERE THE SPAN STOPS, PINNED SO IT IS NOT MISTAKEN FOR AN OVERSIGHT: a run
    // that has produced an execution record is showing its own progress, and the
    // moment a reader re-opens the settled row there is client state the strip's
    // server-rendered answer cannot see. That reading is named as outstanding,
    // not silently covered.
    expect(
      runGateStepInFrame({ gateStepOpens: true, hasExecution: true }),
    ).toBe(false);
  });

  // A GATE THAT CANNOT BE OPENED IS NOT A STEP IN THE FRAME (convergence round).
  //
  // A hold that expires undecided leaves a terminal `policy_unresolved` park with
  // no evidence: the entry still reads "settled" so the rail keeps the row, but
  // the row is muted and opens nothing, and the frame shows the run detail. The
  // strip must keep lighting Setup there -- reading the bare ENTRY would darken
  // the strip over a page that is drawing no step at all.
  it("keeps Setup lit for a terminal gate whose row opens nothing", () => {
    const opens = recommendationRailStepOpens({
      entry: recommendationRailEntry({ hasPark: true, held: false }),
      parkStatus: "policy_unresolved",
      decided: false,
    });
    expect(opens).toBe(false);
    const gateStepInFrame = runGateStepInFrame({
      gateStepOpens: opens,
      hasExecution: false,
    });
    expect(gateStepInFrame).toBe(false);
    expect(runPageActiveTab({ ...NO_INPUT_STEP, gateStepInFrame })).toBe(
      "setup",
    );

    // …and the SAME park, once a person actually released it, opens the row and
    // darkens the strip: the two readings differ by the decision, not by luck.
    const releasedOpens = recommendationRailStepOpens({
      entry: recommendationRailEntry({ hasPark: true, held: false }),
      parkStatus: "released",
      decided: true,
    });
    expect(releasedOpens).toBe(true);
    expect(
      runPageActiveTab({
        ...NO_INPUT_STEP,
        gateStepInFrame: runGateStepInFrame({
          gateStepOpens: releasedOpens,
          hasExecution: false,
        }),
      }),
    ).toBe("none");
  });

  it("lights Setup only when NO step of any kind is in the frame", () => {
    expect(runPageActiveTab(NO_INPUT_STEP)).toBe("setup");
    expect(runPageActiveTab({ ...OPEN, gateStepInFrame: true })).toBe("none");
    expect(runPageActiveTab({ ...SETTLED, gateStepInFrame: true })).toBe("none");
    expect(runPageActiveTab({ ...SCHEDULE_STEP, gateStepInFrame: true })).toBe(
      "none",
    );
  });
});

describe("the screen's JSX asks that question instead of hard-coding the tab", () => {
  it("hands the layout the answer, not the literal", () => {
    expect(SCREEN_SRC).toContain(
      [
        "activeTab={runPageActiveTab({",
        "          inputStepIsOpen,",
        "          inputStepsInRail,",
        '          scheduleStepInFrame: runDetailPanel === "trigger",',
        "          gateStepInFrame: runGateStepInFrame({",
        "            gateStepOpens: recommendationRailStepReached,",
        "            hasExecution: runHasExecution,",
        "          }),",
        "        })}",
      ].join("\n"),
    );
    expect(SCREEN_SRC).not.toContain(`activeTab=${JSON.stringify("setup")}`);
  });
});
