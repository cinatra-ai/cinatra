// @vitest-environment jsdom
/**
 * A STEP IS NOT A CRUMB (cinatra#3223).
 *
 * The ratified drawing, components reference, the Breadcrumb section:
 *
 *   "The trail is the navigation hierarchy. A breadcrumb always reflects the
 *    navigation hierarchy — the route the page sits on, not the thing the page
 *    happens to be about. Every trail under the agents area starts with
 *    'Agents'; under an agent instance the trail names the agent's display
 *    name, as it is written there ('Agents › Blog Draft Writer Agent (1)'), and
 *    the page that starts a run reads 'Agents › Agent run', never 'Run agent'
 *    alone."
 *
 *   "A review has no trail of its own: there is no review page view outside
 *    the route of the agent's run, so 'Agents › Agent run › Review' is not a
 *    possible breadcrumb — the review is read on its run's own route, under
 *    that run's trail."
 *
 *   "an id never stands where a name belongs"
 *
 * The run page's layout used to append a third crumb naming the step the run
 * detail was showing. A step is a reading inside one route, not a route of its
 * own, so the drawing's conclusion is that it is not a crumb at all — not that
 * it is a non-navigable one.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agent-page-layout-no-step-crumb.test.tsx
 */
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  clearCrumbContributions,
  selectCrumbContributions,
} from "@/lib/breadcrumb-contributions";
import { buildBreadcrumbTrail } from "@/lib/breadcrumb-trail";

const AGENT_ID = "cinatra-ai/blog-draft-writer-agent";
const INSTANCE_ID = "run-3223";
const RUN_PATH = `/agents/${AGENT_ID}/${INSTANCE_ID}`;
const RUN_NAME = "Blog Draft Writer Agent (1)";
const EPOCH = "anon";

vi.mock("lucide-react", () => ({
  Info: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "info", className }),
  Check: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "check", className }),
  Pencil: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "pencil", className }),
}));
/** The route the layout is mounted on — the run's own path unless a test moves it. */
const nav = vi.hoisted(() => ({ pathname: "/agents/cinatra-ai/blog-draft-writer-agent/run-3223" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../run-name-actions", () => ({
  saveRunName: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/components/agent-instance-nav", () => ({
  AgentInstanceNav: () => null,
}));
vi.mock("@cinatra-ai/sdk-ui", () => ({
  InlinePageTitle: React.forwardRef(function InlinePageTitleStub(
    { value, placeholder }: { value: string; placeholder: string },
    _ref: React.Ref<unknown>,
  ) {
    return <h1>{value || placeholder}</h1>;
  }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentPageLayout } from "../agent-page-layout";

/** The run detail's readings the trail must not follow: the schedule step, a
 *  work step, a gate step — each drawn under the layout on the run's own path. */
const READINGS = [
  { name: "the schedule step", activeTab: "trigger" as const, body: <form data-reading="schedule" /> },
  { name: "a work step", activeTab: "run" as const, body: <section data-reading="work">Drafted the post</section> },
  { name: "a gate step", activeTab: "run" as const, body: <section data-reading="gate">Review</section> },
];

function renderReading(reading: (typeof READINGS)[number]) {
  return render(
    <TooltipProvider>
      <AgentPageLayout
        agentId={AGENT_ID}
        instanceId={INSTANCE_ID}
        activeTab={reading.activeTab}
        templateName="Blog Draft Writer Agent"
        initialRunName={RUN_NAME}
        runId="run-3223"
      >
        {reading.body}
      </AgentPageLayout>
    </TooltipProvider>,
  );
}

function trailOn(pathname: string, contributions = selectCrumbContributions(pathname, EPOCH)) {
  return buildBreadcrumbTrail(pathname, { contributions }).map((c) => ({
    label: c.label,
    href: c.href,
  }));
}

beforeEach(() => {
  clearCrumbContributions();
});

afterEach(() => {
  cleanup();
  clearCrumbContributions();
  nav.pathname = RUN_PATH;
});

describe("under an agent instance the trail is exactly the drawing's levels (item 1)", () => {
  for (const reading of READINGS) {
    it(`publishes the instance crumb under 'Agents' and no '#step' contribution while ${reading.name} is open`, () => {
      renderReading(reading);
      const published = selectCrumbContributions(RUN_PATH, EPOCH);
      expect(published.map((c) => ({ prefix: c.prefix, label: c.label }))).toEqual([
        { prefix: RUN_PATH, label: RUN_NAME },
      ]);
      expect(published.some((c) => c.prefix.includes("#step"))).toBe(false);
      expect(published.some((c) => c.appendAfter !== undefined)).toBe(false);
      expect(trailOn(RUN_PATH).map((c) => c.label)).toEqual(["Agents", RUN_NAME]);
    });
  }
});

describe("the trail is byte-identical across the run's step readings (item 2)", () => {
  it("composes one and the same trail for the schedule step, a work step and a gate step", () => {
    const trails = READINGS.map((reading) => {
      cleanup();
      clearCrumbContributions();
      renderReading(reading);
      return JSON.stringify(trailOn(RUN_PATH));
    });
    expect(new Set(trails).size).toBe(1);
    expect(JSON.parse(trails[0]!)).toEqual([
      { label: "Agents", href: "/agents" },
      { label: RUN_NAME, href: RUN_PATH },
    ]);
  });
});

describe("the scheduling route composes the same trail as every other reading (item 2)", () => {
  // THE READING THE FIRST PROOF ROUND FAILED (cinatra#3223, fix leg 2). The
  // block above proves the trail on the run's OWN path, where the layout had
  // already stopped publishing a step contribution. The scheduling step of the
  // same run answers at a sub-route of that path, and the trail's own producer
  // named that segment "Schedule" — so the graded reading of one run read two
  // crumbs on its gate reading and three on its scheduling reading.
  //
  // The ratified drawing: "A breadcrumb always reflects the navigation
  // hierarchy — the route the page sits on, not the thing the page happens to
  // be about", and "'Agents > Agent run > Review' is not a possible breadcrumb
  // — the review is read on its run's own route, under that run's trail." A
  // step is a reading inside the run, so the trail is the same trail whichever
  // step is open, whatever path that step happens to answer at.
  const SCHEDULE_ROUTE = `${RUN_PATH}/trigger`;

  it("reads two crumbs on the scheduling route, byte-identical to the gate reading", () => {
    nav.pathname = RUN_PATH;
    renderReading(READINGS[2]!);
    const gateTrail = JSON.stringify(trailOn(RUN_PATH));

    cleanup();
    clearCrumbContributions();
    nav.pathname = SCHEDULE_ROUTE;
    renderReading(READINGS[0]!);
    const scheduleTrail = JSON.stringify(trailOn(SCHEDULE_ROUTE));

    expect(JSON.parse(scheduleTrail)).toEqual([
      { label: "Agents", href: "/agents" },
      { label: RUN_NAME, href: RUN_PATH },
    ]);
    expect(scheduleTrail).toBe(gateTrail);
  });

  it("names no step at the sub-route position, with or without a contribution", () => {
    expect(
      buildBreadcrumbTrail(SCHEDULE_ROUTE, {
        contributions: [{ prefix: RUN_PATH, label: RUN_NAME }],
      }).map((c) => c.label),
    ).toEqual(["Agents", RUN_NAME]);
    expect(buildBreadcrumbTrail(SCHEDULE_ROUTE).length).toBe(2);
  });

  it("leaves every OTHER sub-route under an instance named as it was", () => {
    // Only the run's STEP sub-routes are elided. A genuine page of its own
    // under the instance keeps its crumb, so this change removes one departure
    // rather than the sub-route level itself.
    expect(
      buildBreadcrumbTrail(`${RUN_PATH}/permissions`, {
        contributions: [{ prefix: RUN_PATH, label: RUN_NAME }],
      }).map((c) => c.label),
    ).toEqual(["Agents", RUN_NAME, "Permissions"]);
  });
});

describe("the run-starting page keeps the trail the drawing gives it (item 3)", () => {
  it("reads 'Agents' then the run-starting page's own name, and nothing after it", () => {
    // The page that starts a run answers under the instance branch with the
    // fresh-run placeholder segment (`instanceId === "new"`, instance-screens),
    // under this same layout — THE producer of the crumb, rendered here rather
    // than a fabricated contribution. With no run name yet, the layout names
    // the page by the template (`runName || templateName`), and no step crumb
    // follows it, before or after this change. The drawing's literal wording
    // for this page ("Agent run") is not what the layout composes today; that
    // wording is outside cinatra#3223, which removes the step crumb only.
    const NEW_RUN_PATH = `/agents/${AGENT_ID}/new`;
    nav.pathname = NEW_RUN_PATH;
    render(
      <TooltipProvider>
        <AgentPageLayout
          agentId={AGENT_ID}
          instanceId="new"
          activeTab="run"
          templateName="Blog Draft Writer Agent"
          initialRunName=""
          runId={null}
        >
          <form data-reading="start" />
        </AgentPageLayout>
      </TooltipProvider>,
    );
    const published = selectCrumbContributions(NEW_RUN_PATH, EPOCH);
    expect(published.map((c) => ({ prefix: c.prefix, label: c.label }))).toEqual([
      { prefix: NEW_RUN_PATH, label: "Blog Draft Writer Agent" },
    ]);
    expect(trailOn(NEW_RUN_PATH)).toEqual([
      { label: "Agents", href: "/agents" },
      { label: "Blog Draft Writer Agent", href: NEW_RUN_PATH },
    ]);
  });
});

describe("no identifier stands where a name belongs (item 4)", () => {
  it("draws no crumb on the run route that reads as an opaque identifier", () => {
    renderReading(READINGS[1]!);
    for (const crumb of trailOn(RUN_PATH)) {
      expect(crumb.label).not.toMatch(/^[0-9a-f]{8,}/i);
      expect(crumb.label).not.toMatch(/^run-\d+/);
      expect(crumb.label).not.toMatch(/…$/);
    }
  });
});

function repoFile(relative: string): string {
  const cwd = process.cwd();
  for (const candidate of [`${cwd}/${relative}`, `${cwd}/../../${relative}`]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error(`file not found: ${relative}`);
}

describe("stepCrumbLabel is removed, not left unused (item 5)", () => {
  it("has no producer and no consumer of the symbol left in the layout or the screen", () => {
    expect(repoFile("packages/agents/src/agent-page-layout.tsx")).not.toContain("stepCrumbLabel");
    expect(repoFile("packages/agents/src/instance-screens.tsx")).not.toContain("stepCrumbLabel");
    expect(repoFile("packages/agents/src/agent-page-layout.tsx")).not.toContain("#step");
  });
});
