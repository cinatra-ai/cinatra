// @vitest-environment jsdom
//
// THE AUDIT LANE'S DISPLAY LABEL.
//
// The lane that writes the review's audit reading is called the AUDIT lane
// wherever a person can read it. This suite pins the two places the label is
// actually printed — the suggestion-chip row's heading inside the review card,
// and the run rail's entry for the verification record — so the old "Core
// analysis" wording cannot come back through either surface.
//
// It pins the DISPLAY only. The lane's identity (`core-analysis-lane`), the
// module names, the route segments and the `data-verification-chrome` anchor
// are deliberately NOT part of this contract: they are identifiers, they are
// what the stores and the conformance gates key on, and renaming them would
// rewrite records rather than a label.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import type {
  LifecycleCardState,
  LifecycleSuggestion,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";
import { buildRunStepRail } from "../run-step-rail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-audit-label-001",
};

const SUGGESTION: LifecycleSuggestion = {
  id: "sug-1",
  label: "content.body",
  op: "replace",
  message: "Tighten the opening sentence.",
};

const PENDING_WITH_SUGGESTIONS: LifecycleCardState = {
  state: "pending",
  canDecide: true,
  canComment: true,
  suggestions: [SUGGESTION],
};

function mockResolve(state: LifecycleCardState): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "artifact_review_gate", state, body: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

/** Let the resolve settle without crossing the island's load timeout. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("the audit lane is labelled 'Audit' wherever a person reads it", () => {
  it("heads the suggestion chips 'Audit · Suggestions' on every host that draws them", async () => {
    for (const host of ["chat_thread", "run_card", "page_gate_region"] as const) {
      mockResolve(PENDING_WITH_SUGGESTIONS);
      const { container } = render(
        <LifecycleCardSurfaceProvider host={host}>
          <ReviewGateCard view={VIEW} />
        </LifecycleCardSurfaceProvider>,
      );
      await settle();
      const chips = container.querySelector('[data-conformance-id="suggestion-chips"]');
      expect(chips, `no suggestion chip row drawn on ${host}`).not.toBeNull();
      expect(chips!.firstElementChild?.textContent, `chips heading on ${host}`).toBe(
        "Audit · Suggestions",
      );
      expect(container.textContent, `stale label on ${host}`).not.toContain("Core analysis");
      cleanup();
    }
  });

  it("labels the run rail's verification entry 'Audit'", () => {
    const rail = buildRunStepRail({
      templateSteps: [{ index: 1, stepNumber: 10, label: "Draft" }],
      gates: [
        {
          gateId: "g_g1",
          reviewTaskId: "g1",
          status: "resolved",
          disposition: "changes_requested",
          createdAt: "2026-07-25T10:00:00Z",
        },
      ],
      verifications: [{ gateId: "g_g1", reviewTaskId: "g1", outcome: "verified" }],
    });
    const verify = rail.entries.find((e) => e.kind === "verification");
    expect(verify).toBeTruthy();
    expect(verify!.label).toBe("Audit");
    expect(rail.entries.map((e) => e.label)).not.toContain("Core analysis");
  });
});
