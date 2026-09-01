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

import { runPageActiveTab } from "../instance-screens";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

const ACTIVE_STATE = `data-state=${JSON.stringify("active")}`;
const SELECTED = `aria-selected=${JSON.stringify("true")}`;

function strip(
  moment: { inputStepIsOpen: boolean; inputStepsInRail: boolean },
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
const OPEN = { inputStepIsOpen: true, inputStepsInRail: true };
/** The same step, answered -- its row still on the rail, its screen read-only. */
const SETTLED = { inputStepIsOpen: false, inputStepsInRail: true };
/** Every moment on this path that draws no input step at all. */
const NO_INPUT_STEP = { inputStepIsOpen: false, inputStepsInRail: false };

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

describe("the screen's JSX asks that question instead of hard-coding the tab", () => {
  it("hands the layout the answer, not the literal", () => {
    expect(SCREEN_SRC).toContain(
      "activeTab={runPageActiveTab({ inputStepIsOpen, inputStepsInRail })}",
    );
    expect(SCREEN_SRC).not.toContain(`activeTab=${JSON.stringify("setup")}`);
  });
});
