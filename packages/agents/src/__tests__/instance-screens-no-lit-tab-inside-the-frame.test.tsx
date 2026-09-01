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

function strip(inputStepIsOpen: boolean, showTriggerTab = false): string {
  return renderToStaticMarkup(
    <AgentInstanceNav
      agentId="acme/blog-idea-generator-agent"
      instanceId="run-1"
      activeTab={runPageActiveTab({ inputStepIsOpen })}
      showTriggerTab={showTriggerTab}
    />,
  );
}

describe("the run page's tab strip while a step is drawn inside the frame", () => {
  it("draws NO tab selected while the input step is the step in the frame", () => {
    const html = strip(true);
    expect(html).not.toContain(ACTIVE_STATE);
    expect(html).not.toContain(SELECTED);
  });

  it("still carries the SAME tabs -- the strip is part of the constant frame", () => {
    const html = strip(true);
    expect(html).toContain(">Setup<");
    expect(html).toContain(">Permissions<");
    expect(strip(true, true)).toContain(">Schedule<");
  });

  it("lights Setup again for every other moment on the run's own path", () => {
    const html = strip(false);
    expect(html).toContain(ACTIVE_STATE);
    expect(runPageActiveTab({ inputStepIsOpen: false })).toBe("setup");
  });
});

describe("the screen's JSX asks that question instead of hard-coding the tab", () => {
  it("hands the layout the answer, not the literal", () => {
    expect(SCREEN_SRC).toContain(
      "activeTab={runPageActiveTab({ inputStepIsOpen })}",
    );
    expect(SCREEN_SRC).not.toContain(`activeTab=${JSON.stringify("setup")}`);
  });
});
