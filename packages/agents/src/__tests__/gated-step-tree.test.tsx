// @vitest-environment jsdom
/**
 * GatedStepTree RTL coverage.
 *
 * Locks the rendering of the gated-step tree on the persistent Trigger tab:
 *   1. Empty gatedSteps → "No side-effect steps detected" copy.
 *   2. Single GatedStep → one <li> with agentPath joined by " → " + toolName.
 *   3. Three GatedSteps → three <li> items.
 *   4. inferredOrManual === "manual" → italic "manual" tag rendered.
 *   5. Non-empty tree uses "└─" tree glyph.
 *
 * Run:
 *   cd packages/agent-builder && pnpm exec vitest run src/__tests__/gated-step-tree.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { GatedStep } from "../trigger-infer-side-effects";

// ---------------------------------------------------------------------------
// trigger-tab-client.tsx imports run-actions (a "use server" module). vitest
// can't load Better Auth dependencies during render — mock the server actions
// to keep the import graph clean. The GatedStepTree itself does NOT call
// these actions; the mock only satisfies the import resolver.
// ---------------------------------------------------------------------------
vi.mock("../run-actions", () => ({
  deleteRunTrigger: vi.fn(),
  releaseTriggerNow: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { GatedStepTree } from "../trigger-tab-client";

afterEach(() => {
  cleanup();
});

function step(overrides: Partial<GatedStep> = {}): GatedStep {
  return {
    stepId: overrides.stepId ?? "step-1",
    stepNumber: overrides.stepNumber ?? 1,
    agentPath: overrides.agentPath ?? ["root"],
    label: overrides.label ?? "Step",
    toolName: overrides.toolName ?? "tool_name",
    inferredOrManual: overrides.inferredOrManual ?? "inferred",
  };
}

describe("GatedStepTree", () => {
  it("renders the empty-state copy when gatedSteps is empty", () => {
    render(<GatedStepTree gatedSteps={[]} />);
    expect(
      screen.getByText(/No side-effect steps detected/i),
    ).toBeDefined();
    // The empty container has its own testid for stable selection.
    expect(screen.getByTestId("gated-step-tree-empty")).toBeDefined();
    // No tree items rendered in the empty state.
    expect(screen.queryAllByTestId("gated-step-item")).toHaveLength(0);
  });

  it("renders a single GatedStep with agentPath joined by ' → ' and toolName in parens", () => {
    render(
      <GatedStepTree
        gatedSteps={[
          step({
            stepId: "s1",
            agentPath: ["root", "child"],
            toolName: "send_email",
          }),
        ]}
      />,
    );
    const items = screen.getAllByTestId("gated-step-item");
    expect(items).toHaveLength(1);
    // agentPath joined with " → "
    expect(items[0].textContent).toMatch(/root → child/);
    // toolName in parens
    expect(items[0].textContent).toMatch(/\(send_email\)/);
  });

  it("renders three GatedSteps as three list items", () => {
    render(
      <GatedStepTree
        gatedSteps={[
          step({ stepId: "a", agentPath: ["a"], toolName: "tool_a" }),
          step({ stepId: "b", agentPath: ["b"], toolName: "tool_b" }),
          step({ stepId: "c", agentPath: ["c"], toolName: "tool_c" }),
        ]}
      />,
    );
    expect(screen.getAllByTestId("gated-step-item")).toHaveLength(3);
  });

  it("renders the italic 'manual' tag when inferredOrManual === 'manual'", () => {
    render(
      <GatedStepTree
        gatedSteps={[
          step({
            stepId: "m1",
            agentPath: ["m"],
            toolName: "publish_post",
            inferredOrManual: "manual",
          }),
          step({
            stepId: "i1",
            agentPath: ["i"],
            toolName: "send_email",
            inferredOrManual: "inferred",
          }),
        ]}
      />,
    );
    // Exactly one "manual" tag (the inferred row should not get one).
    const manualTags = screen.getAllByText(/^manual$/i);
    expect(manualTags).toHaveLength(1);
  });

  it("uses the '└─' tree glyph for non-empty trees", () => {
    render(
      <GatedStepTree
        gatedSteps={[
          step({
            stepId: "g1",
            agentPath: ["root", "leaf"],
            toolName: "do_thing",
          }),
        ]}
      />,
    );
    const root = screen.getByTestId("gated-step-tree");
    expect(root.textContent ?? "").toContain("└─");
  });
});
