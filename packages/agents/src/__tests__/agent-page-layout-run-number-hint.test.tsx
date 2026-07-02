// @vitest-environment jsdom
/**
 * Coverage for the run-title "(N)" suffix explainer (issue #815).
 *
 * ensureRunTitle (store.ts) auto-names runs `${templateName} (${n})`; the
 * bare "(1)" read as "you already have one" in UAT. AgentPageLayout now shows
 * an Info-icon tooltip (the run surface's established hint pattern) exactly
 * when the displayed name has the auto-generated shape.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agent-page-layout-run-number-hint.test.tsx
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Module stubs — keep the import graph client-pure for jsdom.
// ---------------------------------------------------------------------------

vi.mock("lucide-react", () => ({
  Info: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "info", className }),
  Check: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "check", className }),
  Pencil: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "pencil", className }),
}));

// saveRunName is a "use server" action (pulls store/DB) — stub it out.
vi.mock("../run-name-actions", () => ({
  saveRunName: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// AgentInstanceNav pulls next/navigation hooks — irrelevant to this test.
vi.mock("@/components/agent-instance-nav", () => ({
  AgentInstanceNav: () => null,
}));

// InlinePageTitle is exercised elsewhere; a minimal ref-accepting stub keeps
// this test focused on the layout's hint condition.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  InlinePageTitle: React.forwardRef(function InlinePageTitleStub(
    { value, placeholder }: { value: string; placeholder: string },
    _ref: React.Ref<unknown>,
  ) {
    return <h1>{value || placeholder}</h1>;
  }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentPageLayout, getAutoRunNumber } from "../agent-page-layout";

const HINT_LABEL = /numbered automatically/i;

function renderLayout(initialRunName: string, templateName = "Blog Pipeline Agent") {
  return render(
    <TooltipProvider>
      <AgentPageLayout
        agentId="blog-pipeline-agent"
        instanceId="inst-1"
        activeTab="run"
        templateName={templateName}
        initialRunName={initialRunName}
        runId="run-1"
      >
        <div />
      </AgentPageLayout>
    </TooltipProvider>,
  );
}

describe("getAutoRunNumber", () => {
  it("extracts the counter from the auto-generated shape", () => {
    expect(getAutoRunNumber("Blog Pipeline Agent (1)", "Blog Pipeline Agent")).toBe(1);
    expect(getAutoRunNumber("Blog Pipeline Agent (12)", "Blog Pipeline Agent")).toBe(12);
  });

  it("returns null for custom or non-matching names", () => {
    expect(getAutoRunNumber("My launch", "Blog Pipeline Agent")).toBeNull();
    expect(getAutoRunNumber("Blog Pipeline Agent", "Blog Pipeline Agent")).toBeNull();
    expect(getAutoRunNumber("Blog Pipeline Agent ()", "Blog Pipeline Agent")).toBeNull();
    expect(getAutoRunNumber("Blog Pipeline Agent (x)", "Blog Pipeline Agent")).toBeNull();
    expect(getAutoRunNumber("Other Agent (1)", "Blog Pipeline Agent")).toBeNull();
    expect(getAutoRunNumber("", "Blog Pipeline Agent")).toBeNull();
  });
});

describe("AgentPageLayout run-number hint", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the explainer next to an auto-numbered title", () => {
    renderLayout("Blog Pipeline Agent (1)");
    expect(screen.getByLabelText(HINT_LABEL)).not.toBeNull();
  });

  it("hides the explainer for a custom run name", () => {
    renderLayout("Q3 launch post");
    expect(screen.queryByLabelText(HINT_LABEL)).toBeNull();
  });

  it("hides the explainer when no run name is set yet", () => {
    renderLayout("");
    expect(screen.queryByLabelText(HINT_LABEL)).toBeNull();
  });
});
