// @vitest-environment jsdom
/**
 * Frame / body-inset width coverage for AgentPageLayout (cinatra#2487).
 *
 * Governing spec: Application Design — Agents (design spec
 * `specs/app-agents.html` @ c669997bfb335a0db8ff66ba11d4f228825abdf5), which
 * supersedes the per-tab width table from cinatra#1161:
 *
 *   §I   The frame is ONE container — title row, tab strip, etched rule, body —
 *        and its width is CONSTANT on every tab. Tab identity never assigns a
 *        width.
 *   §II  Exactly two base widths: Frame = Wide max-w-3xl (768px);
 *        Body inset = Narrow max-w-xl (576px), flush-left, never re-centred.
 *        max-w-2xl / max-w-md / max-w-7xl are NOT agent-frame widths.
 *   §III The body role is DECLARED by the panel, never derived from the tab.
 *   §IV  The only thing that moves the frame is the conditional widen driven by
 *        a panel marked as wide monitoring output — floor min(48rem,100%),
 *        ceiling min(100%,1400px), centred.
 *
 * These assertions read the class list off the REAL rendered component so the
 * Playwright conformance proof (same class strings) is faithful by construction.
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
  AgentPanelBody,
  AGENT_FRAME_MAX_WIDTH,
  AGENT_BODY_INSET_MAX_WIDTH,
} from "../agent-page-layout";
import type { AgentInstanceNavProps } from "@/components/agent-instance-nav";

type Tab = AgentInstanceNavProps["activeTab"];

/** Every tab the shell can render. */
const ALL_TABS: Tab[] = ["run", "setup", "trigger", "permissions"];

// The §IV widen affordance is a state of the FRAME and must survive on every tab.
const WIDEN_CLASSES = [
  "[&:has([data-hitl-output='true'])]:max-w-[min(100%,1400px)]",
  "[&:has([data-hitl-output='true'])]:w-fit",
  "[&:has([data-hitl-output='true'])]:min-w-[min(48rem,100%)]",
];

/** Widths §II explicitly rules out as agent-frame widths. */
const FORBIDDEN_BASE_WIDTHS = ["max-w-7xl", "max-w-2xl", "max-w-md"];

function shellFor(activeTab: Tab, children?: React.ReactNode): HTMLElement {
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
        {children ?? <div data-testid="content" />}
      </AgentPageLayout>
    </TooltipProvider>,
  );
  const shell = container.querySelector<HTMLElement>(`[data-active-tab="${activeTab}"]`);
  if (!shell) throw new Error(`no shell rendered for activeTab=${activeTab}`);
  return shell;
}

/** The exact class string AgentPageLayout emits for the frame. */
function expectedFrameClassName(): string {
  return [
    `mx-auto w-full ${AGENT_FRAME_MAX_WIDTH} px-5 sm:px-8 lg:px-0`,
    "transition-[max-width] duration-200 ease-out",
    ...WIDEN_CLASSES,
  ].join(" ");
}

afterEach(() => cleanup());

describe("AgentPageLayout — the frame (Application Design — Agents §I/§II)", () => {
  it("binds the two — and only two — widths to the design system's named steps", () => {
    expect(AGENT_FRAME_MAX_WIDTH).toBe("max-w-3xl"); // Wide · 48rem · 768px
    expect(AGENT_BODY_INSET_MAX_WIDTH).toBe("max-w-xl"); // Narrow · 36rem · 576px
  });

  it("renders the frame at Wide on EVERY tab — byte-identical class strings", () => {
    const rendered = ALL_TABS.map((tab) => shellFor(tab).className);
    for (const [i, cls] of rendered.entries()) {
      expect(cls, `tab=${ALL_TABS[i]}`).toBe(expectedFrameClassName());
    }
    // §I: "selecting a different tab changes the body and nothing else."
    expect(new Set(rendered).size).toBe(1);
  });

  it("never emits a width §II rules out (7xl / 2xl / md)", () => {
    for (const tab of ALL_TABS) {
      const cls = shellFor(tab).className;
      for (const forbidden of FORBIDDEN_BASE_WIDTHS) {
        expect(cls, `tab=${tab} must not carry ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("keeps the §IV widen — floor, ceiling and centring — on every tab", () => {
    for (const tab of ALL_TABS) {
      const cls = shellFor(tab).className;
      for (const widen of WIDEN_CLASSES) {
        expect(cls, `tab=${tab} must keep ${widen}`).toContain(widen);
      }
      expect(cls).toContain("mx-auto");
    }
  });
});

describe("AgentPanelBody — the declared body role (§II/§III)", () => {
  it("insets a narrow panel to Narrow and keeps it flush-left (no mx-auto)", () => {
    const shell = shellFor(
      "trigger",
      <AgentPanelBody role="narrow">
        <div data-testid="content" />
      </AgentPanelBody>,
    );
    const body = shell.querySelector<HTMLElement>('[data-panel-body="narrow"]');
    expect(body).not.toBeNull();
    expect(body!.className).toContain(AGENT_BODY_INSET_MAX_WIDTH);
    // §II: "Centring the inset inside the frame would make the body's left edge
    // disagree with the title row and the first tab above it."
    expect(body!.className).not.toContain("mx-auto");
  });

  it("gives a frame-role panel no width cap of its own", () => {
    const shell = shellFor(
      "setup",
      <AgentPanelBody role="frame">
        <div data-testid="content" />
      </AgentPanelBody>,
    );
    const body = shell.querySelector<HTMLElement>('[data-panel-body="frame"]');
    expect(body).not.toBeNull();
    expect(body!.className).not.toContain("max-w-");
  });

  it("does NOT change the frame — the same tab hosting either role is one width", () => {
    const narrowFrame = shellFor(
      "setup",
      <AgentPanelBody role="narrow">
        <div />
      </AgentPanelBody>,
    ).className;
    const frameFrame = shellFor(
      "setup",
      <AgentPanelBody role="frame">
        <div />
      </AgentPanelBody>,
    ).className;
    expect(narrowFrame).toBe(frameFrame);
    expect(narrowFrame).toBe(expectedFrameClassName());
  });

  it("passes through extra classes without dropping the declared role", () => {
    const shell = shellFor(
      "run",
      <AgentPanelBody role="frame" className="flex flex-col gap-6">
        <div />
      </AgentPanelBody>,
    );
    const body = shell.querySelector<HTMLElement>('[data-panel-body="frame"]');
    expect(body!.className).toBe("w-full flex flex-col gap-6");
  });
});
