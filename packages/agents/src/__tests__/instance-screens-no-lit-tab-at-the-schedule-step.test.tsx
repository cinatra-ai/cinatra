// @vitest-environment jsdom
/**
 * NO TAB IS LIT WHILE THE SCHEDULE STEP STANDS IN THE FRAME (cinatra#3182,
 * item 8; the same answer settles cinatra#3168's dangling reference).
 *
 * Application Design — Agents, the run view's conditional-tab section: "Then
 * the strip is the two-tab reading — Setup and Permissions — and no tab is
 * drawn selected: what sits under the strip is that step, not the body of a
 * tab, so none of the tabs is lit for it. ... A step drawn inside this frame
 * never lights a tab the strip does not carry."
 *
 * Two mounts draw that step, and both were telling the reader they were in the
 * body of a tab:
 *   - the RUN PAGE's own schedule step (`runDetailPanelKind` answers "trigger"),
 *     which lit Setup;
 *   - the /trigger route while the run carries no persistent schedule tab,
 *     which named a tab the strip does not render at all.
 *
 *   pnpm exec vitest run packages/agents/src/__tests__/instance-screens-no-lit-tab-at-the-schedule-step.test.tsx
 */
import * as fs from "node:fs";
import * as path from "node:path";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentInstanceNav } from "@/components/agent-instance-nav";

import {
  runPageScheduleStepActiveTab,
  scheduleRouteActiveTab,
} from "../instance-screens";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

const ACTIVE_STATE = 'data-state="active"';

function strip(
  activeTab: React.ComponentProps<typeof AgentInstanceNav>["activeTab"],
  showTriggerTab = false,
): string {
  return renderToStaticMarkup(
    <AgentInstanceNav
      agentId="acme/blog-idea-generator-agent"
      instanceId="run-1"
      activeTab={activeTab}
      showTriggerTab={showTriggerTab}
    />,
  );
}

describe("the run page's own schedule step lights no tab", () => {
  it("answers 'none' while the schedule step is the step in the frame", () => {
    expect(runPageScheduleStepActiveTab({ scheduleStepInFrame: true })).toBe("none");
    expect(strip(runPageScheduleStepActiveTab({ scheduleStepInFrame: true }))).not.toContain(
      ACTIVE_STATE,
    );
  });

  it("lights Setup again for every moment that draws no schedule step", () => {
    expect(runPageScheduleStepActiveTab({ scheduleStepInFrame: false })).toBe("setup");
    expect(strip(runPageScheduleStepActiveTab({ scheduleStepInFrame: false }))).toContain(
      ACTIVE_STATE,
    );
  });

  it("hands the layout that answer instead of the literal", () => {
    expect(SCREEN_SRC).toContain(
      'activeTab={runPageScheduleStepActiveTab({ scheduleStepInFrame: runDetailPanel === "trigger" })}',
    );
    expect(SCREEN_SRC).not.toContain(`activeTab=${JSON.stringify("setup")}`);
  });
});

describe("the schedule route lights no tab the strip does not carry", () => {
  it("answers 'none' while no persistent schedule tab is drawn (cinatra#3168)", () => {
    expect(scheduleRouteActiveTab({ persistentScheduleTab: false })).toBe("none");
    expect(strip(scheduleRouteActiveTab({ persistentScheduleTab: false }), false)).not.toContain(
      ACTIVE_STATE,
    );
  });

  it("lights the Schedule tab once the run actually carries one", () => {
    expect(scheduleRouteActiveTab({ persistentScheduleTab: true })).toBe("trigger");
    const html = strip(scheduleRouteActiveTab({ persistentScheduleTab: true }), true);
    expect(html).toContain(ACTIVE_STATE);
    expect(/<a\b[^>]*>(?=Schedule<\/a>)/.exec(html)?.[0]).toContain(ACTIVE_STATE);
  });

  it("hands the layout that answer instead of the literal", () => {
    expect(SCREEN_SRC).toContain(
      "activeTab={scheduleRouteActiveTab({ persistentScheduleTab: showPersistentTab })}",
    );
    expect(SCREEN_SRC).not.toContain(`activeTab=${JSON.stringify("trigger")}`);
  });
});

describe("the strip itself is unchanged — the frame is constant", () => {
  it("carries the same tabs whether or not a tab is lit", () => {
    const none = strip("none");
    const setup = strip("setup");
    for (const html of [none, setup]) {
      expect(html).toContain(">Setup<");
      expect(html).toContain(">Permissions<");
      expect(html).not.toContain(">Schedule<");
    }
    expect(strip("none", true)).toContain(">Schedule<");
  });
});
