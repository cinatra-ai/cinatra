// @vitest-environment jsdom
/**
 * Per-tab content-width coverage for AgentPageLayout (cinatra#1161).
 *
 * Owner decision: option 1 — per-tab widths, drawn from the design system's
 * graded content-width scale (Application Design system, §VII "Content widths"):
 *
 *   run     → Full   max-w-7xl (1280px) — entity-detail / run-output surface
 *   setup   → Medium max-w-2xl (672px)  — the /setup · onboarding column
 *   trigger → Narrow max-w-xl  (576px)  — single-column schedule/control form
 *   permissions / overview → Wide max-w-3xl (768px) — UNCHANGED (outside #1161)
 *
 * These assertions read the class list off the REAL rendered component so the
 * `/design-fixtures`-style visual proof (which reuses the same exact class
 * strings) is faithful by construction. The output-HITL widen selector must
 * survive on every tab.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agent-page-layout-width.test.tsx
 */
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

import { vi } from "vitest";

vi.mock("lucide-react", () => ({
  Info: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "info", className }),
}));

vi.mock("../run-name-actions", () => ({
  saveRunName: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// AgentInstanceNav pulls next/link + navigation — irrelevant to width.
vi.mock("@/components/agent-instance-nav", () => ({
  AgentInstanceNav: () => null,
}));

vi.mock("@cinatra-ai/sdk-ui", () => ({
  InlinePageTitle: React.forwardRef(function InlinePageTitleStub({
    value,
    placeholder,
  }: {
    value: string;
    placeholder: string;
  }) {
    return <h1>{value || placeholder}</h1>;
  }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AgentPageLayout,
  TAB_CONTENT_MAX_WIDTH,
} from "../agent-page-layout";
import type { AgentInstanceNavProps } from "@/components/agent-instance-nav";

type Tab = AgentInstanceNavProps["activeTab"];

// The HITL-output widen affordance is global (applies on every tab) and must be
// preserved verbatim by the change.
const HITL_WIDEN_CLASSES = [
  "[&:has([data-hitl-output='true'])]:max-w-[min(100%,1400px)]",
  "[&:has([data-hitl-output='true'])]:w-fit",
  "[&:has([data-hitl-output='true'])]:min-w-[min(48rem,100%)]",
];

function shellFor(activeTab: Tab): HTMLElement {
  const { container } = render(
    <TooltipProvider>
      <AgentPageLayout
        agentId="blog-pipeline-agent"
        instanceId="inst-1"
        activeTab={activeTab}
        templateName="Blog Pipeline Agent"
        initialRunName="Blog Pipeline Agent (1)"
        runId="run-1"
      >
        <div data-testid="content" />
      </AgentPageLayout>
    </TooltipProvider>,
  );
  const shell = container.querySelector<HTMLElement>(`[data-active-tab="${activeTab}"]`);
  if (!shell) throw new Error(`no shell rendered for activeTab=${activeTab}`);
  return shell;
}

/** The exact class string AgentPageLayout emits for a given base width. */
function expectedClassName(widthClass: string): string {
  return [
    `mx-auto w-full ${widthClass} px-5 sm:px-8 lg:px-0`,
    "transition-[max-width] duration-200 ease-out",
    ...HITL_WIDEN_CLASSES,
  ].join(" ");
}

afterEach(() => cleanup());

describe("AgentPageLayout — per-tab content width (#1161)", () => {
  it("maps each tab to its design-scale width (§VII)", () => {
    expect(TAB_CONTENT_MAX_WIDTH).toEqual({
      run: "max-w-7xl",
      setup: "max-w-2xl",
      trigger: "max-w-xl",
      permissions: "max-w-3xl",
      overview: "max-w-3xl",
    });
  });

  it("run-detail / HITL tab renders at Full (max-w-7xl) — matches PageContent", () => {
    const shell = shellFor("run");
    expect(shell.className).toBe(expectedClassName("max-w-7xl"));
    expect(shell.className).toContain("max-w-7xl");
    expect(shell.className).not.toContain("max-w-3xl");
  });

  it("setup tab renders at Medium (max-w-2xl) — the onboarding column", () => {
    const shell = shellFor("setup");
    expect(shell.className).toBe(expectedClassName("max-w-2xl"));
    expect(shell.className).not.toContain("max-w-7xl");
  });

  it("trigger tab renders at Narrow (max-w-xl) — single-column form", () => {
    const shell = shellFor("trigger");
    expect(shell.className).toBe(expectedClassName("max-w-xl"));
    expect(shell.className).not.toContain("max-w-7xl");
  });

  it("permissions + overview keep the prior Wide (max-w-3xl) default — unchanged by #1161", () => {
    expect(shellFor("permissions").className).toBe(expectedClassName("max-w-3xl"));
    expect(shellFor("overview").className).toBe(expectedClassName("max-w-3xl"));
  });

  it("preserves the output-HITL widen selector on EVERY tab", () => {
    for (const tab of ["run", "setup", "trigger", "permissions", "overview"] as Tab[]) {
      const cls = shellFor(tab).className;
      for (const widen of HITL_WIDEN_CLASSES) {
        expect(cls, `tab=${tab} must keep ${widen}`).toContain(widen);
      }
    }
  });
});
