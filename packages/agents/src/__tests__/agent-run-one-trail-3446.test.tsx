// @vitest-environment jsdom
/**
 * ONE TRAIL SHAPE FOR A RUN'S PAGES — the run page's half (cinatra#3446).
 *
 * The issue's Expected, in its own words: one trail shape for a run's pages —
 * the agent's name, then the run, then the step or surface (Review) — the same
 * words on the run page and on its review page.
 *
 * What was measured on two real runs: the run page read "Agents > Blog Draft
 * Writer Agent (4)" — the agent's name and the run's number folded into ONE
 * crumb, with no crumb for the agent at all — while the review page of the same
 * run read "Agents > 00220c95... > Review". This file pins the run page's half:
 * the layout that owns the run page's crumb publish composes the agent's own
 * crumb ahead of the run's, and the trail reads agent, then run.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agent-run-one-trail-3446.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  clearCrumbContributions,
  selectCrumbContributions,
} from "@/lib/breadcrumb-contributions";
import { buildBreadcrumbTrail } from "@/lib/breadcrumb-trail";

const AGENT_ID = "cinatra-ai/blog-draft-writer-agent";
const INSTANCE_ID = "00220c95-6a1f-4a2b-9d11-6c7c1f0a8e42";
const AGENT_PATH = `/agents/${AGENT_ID}`;
const RUN_PATH = `${AGENT_PATH}/${INSTANCE_ID}`;
const REVIEW_PATH = `${RUN_PATH}/review/task-3446`;
const AGENT_NAME = "Blog Draft Writer Agent";
const RUN_NAME = "Blog Draft Writer Agent (4)";
const EPOCH = "anon";

vi.mock("lucide-react", () => ({
  Info: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "info", className }),
  Check: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "check", className }),
  Pencil: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "pencil", className }),
}));
const nav = vi.hoisted(() => ({ pathname: "/" }));
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

/** The run page as the product renders it: the layout, on the run's own path. */
function renderRunPage(runName: string = RUN_NAME) {
  return render(
    <TooltipProvider>
      <AgentPageLayout
        agentId={AGENT_ID}
        instanceId={INSTANCE_ID}
        activeTab="run"
        templateName={AGENT_NAME}
        initialRunName={runName}
        runId={INSTANCE_ID}
      >
        <section data-reading="work">Drafted the post</section>
      </AgentPageLayout>
    </TooltipProvider>,
  );
}

function trailOn(pathname: string) {
  return buildBreadcrumbTrail(pathname, {
    contributions: selectCrumbContributions(pathname, EPOCH),
  });
}

beforeEach(() => {
  clearCrumbContributions();
  nav.pathname = RUN_PATH;
});

afterEach(() => {
  cleanup();
  clearCrumbContributions();
  nav.pathname = RUN_PATH;
});

describe("the run page draws the agent's name, then the run (cinatra#3446 item 2)", () => {
  it("reads 'Agents > <the agent's name> > <the run>'", () => {
    renderRunPage();
    expect(trailOn(RUN_PATH).map((c) => c.label)).toEqual([
      "Agents",
      AGENT_NAME,
      RUN_NAME,
    ]);
  });

  it("publishes the agent's own crumb AHEAD of the run's, on the one channel", () => {
    renderRunPage();
    const published = selectCrumbContributions(RUN_PATH, EPOCH);
    expect(
      published.map((c) => ({
        prefix: c.prefix,
        label: c.label,
        insertBefore: c.insertBefore ?? null,
      })),
    ).toEqual([
      { prefix: AGENT_PATH, label: AGENT_NAME, insertBefore: RUN_PATH },
      { prefix: RUN_PATH, label: RUN_NAME, insertBefore: null },
    ]);
  });

  it("draws the agent's crumb as a label — its level has no page to link to", () => {
    renderRunPage();
    const agentCrumb = trailOn(RUN_PATH)[1]!;
    expect(agentCrumb.label).toBe(AGENT_NAME);
    expect(agentCrumb.nonNavigable).toBe(true);
  });

  it("names no crumb with a raw identifier", () => {
    renderRunPage();
    for (const crumb of trailOn(RUN_PATH)) {
      expect(crumb.label).not.toMatch(/^[0-9a-f]{8}/i);
      expect(crumb.label).not.toMatch(/…$/);
    }
  });
});

describe("the run's review page reads the SAME first words (cinatra#3446 item 1)", () => {
  it("carries the run's crumbs onto the review route as 'agent > run > Review'", () => {
    nav.pathname = RUN_PATH;
    renderRunPage();
    const runTrail = trailOn(RUN_PATH);
    // The review route composes its own surface crumb from its path segment;
    // the two crumbs above it are the run's, and they are the run page's.
    const reviewTrail = buildBreadcrumbTrail(REVIEW_PATH, {
      contributions: selectCrumbContributions(RUN_PATH, EPOCH),
    });
    expect(reviewTrail.map((c) => c.label)).toEqual([
      "Agents",
      AGENT_NAME,
      RUN_NAME,
      "Review",
    ]);
    expect(reviewTrail.slice(0, 3)).toEqual(runTrail);
  });
});

/**
 * A SYSTEM RUN CARRIES NO TITLE OF ITS OWN (cinatra#3446). The run
 * screen names it with the AGENT's name — `ensureRunTitle` returns the base
 * name for a run with no owner — and the review page resolves it through the
 * same helper. The trail must then name the agent ONCE, and identically on both
 * pages, rather than drawing the same word on two levels.
 */
describe("a run named after its agent is named once (cinatra#3446 item 2)", () => {
  it("publishes a single crumb, and both pages read the same words", () => {
    renderRunPage(AGENT_NAME);
    const published = selectCrumbContributions(RUN_PATH, EPOCH);
    expect(published.map((c) => ({ prefix: c.prefix, label: c.label }))).toEqual([
      { prefix: RUN_PATH, label: AGENT_NAME },
    ]);
    const runTrail = trailOn(RUN_PATH).map((c) => c.label);
    const reviewTrail = buildBreadcrumbTrail(REVIEW_PATH, {
      contributions: published,
    }).map((c) => c.label);
    expect(runTrail).toEqual(["Agents", AGENT_NAME]);
    expect(reviewTrail).toEqual(["Agents", AGENT_NAME, "Review"]);
    expect(reviewTrail.slice(0, runTrail.length)).toEqual(runTrail);
  });
});
