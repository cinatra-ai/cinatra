// @vitest-environment jsdom
/**
 * ONE CARD PER STEP — the boxes inside the box (cinatra#3188 item 4).
 *
 * The run-surface drawing, §I, in its own words:
 *
 *   "One page per gate — the step's own card, and nothing else. Selecting a step
 *    opens that step's page in the run detail, and the page carries the one card
 *    of the step it belongs to."
 *
 * The run panel draws that card — its own section — and then drew a SECOND
 * bordered box inside it around the step's own content: the paused-gate content
 * and the failed run's error were each given a border, a ground and an inset of
 * their own, so a reader saw a box inside a box where the drawing gives one
 * card.
 *
 * WHAT IS PINNED. The step's content, read from inside the panel's own card: no
 * descendant of that card carries a card's treatment of its own. The card keeps
 * everything it had — this is the box coming off the content inside it, not the
 * card losing its shape, and the first case below pins the card itself.
 *
 * The harness is the sibling bare-gate suite's, so the reading mounted here is
 * the real panel on a real paused gate.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel.one-card-per-step.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="field-assist-prompt-stub">{placeholder}</div>
  ),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy(
    {} as Record<string, () => null>,
    {
      get: (_t, prop) => {
        if (prop === "__esModule") return true;
        if (prop === "then") return undefined;
        if (typeof prop === "symbol") return undefined;
        return StubIcon;
      },
      has: () => true,
      ownKeys: () => ["ArrowRight", "Check", "CheckCircle2", "ChevronDown", "Circle", "CircleDot", "ClipboardList", "ExternalLink", "Loader2", "XCircle", "default"],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
    },
  );
});

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-2444",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

// Bare tool-call gate: xRenderer "" (no renderer registered / no x-renderer on
// the gate) but a real reviewTaskId — the shape deriveRunHitlContext emits for
// a WayFlow gate with no readable interrupt. mapInterruptToHitlContext passes
// the empty xRenderer through verbatim, so the panel's fallback branch renders
// with a POPULATED effectiveHitlContext.
const BARE_GATE_REVIEW_TASK_ID = "wayflow-task-2444";
const hookResultBareGate = {
  status: "pending_approval",
  error: null,
  presentationHint: null,
  isLive: true,
  interruptContext: {
    schema: {},
    xRenderer: "",
    values: {},
    reviewTaskId: BARE_GATE_REVIEW_TASK_ID,
  },
  streamedText: "",
};

// Degraded shape: pending_approval with NO gate context at all — nothing to
// submit against, so only the /notifications deep-link can be offered.
const hookResultNoContext = {
  status: "pending_approval",
  error: null,
  presentationHint: null,
  isLive: true,
  interruptContext: null,
  streamedText: "",
};

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => hookResultBareGate),
}));

async function renderBareGatePanel(hookResult: unknown = hookResultBareGate) {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
  (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(hookResult);
  return render(
    <AgenticRunPanel
      runId="run-2444"
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={true}
    />,
  );
}

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});


/** A run that failed, so the panel draws its error under the same card. */
const hookResultFailed = {
  status: "failed",
  error: "The provider refused the call.",
  presentationHint: null,
  isLive: false,
  interruptContext: null,
  streamedText: "",
};

/**
 * A CARD'S TREATMENT, as this product spells it: the shared panel plate, or a
 * border on the line token. Read off the class list because that is what the
 * treatment is — jsdom resolves no stylesheet, and a picture is graded on the
 * same box either way.
 */
function boxedDescendants(root: HTMLElement): HTMLElement[] {
  // CONTAINERS ONLY. A button and a link carry a border because a control is
  // drawn with one; the drawing's sentence is about the CARD a step's content
  // is put inside, so the reading is over the containers.
  return Array.from(
    root.querySelectorAll<HTMLElement>("div, section, aside, article"),
  ).filter((el) => {
    const cls = el.className;
    if (typeof cls !== "string") return false;
    const tokens = new Set(cls.split(/\s+/));
    return (
      tokens.has("soft-panel") || (tokens.has("border") && tokens.has("border-line"))
    );
  });
}

function stepCard(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("section")!;
}

describe("the step's page carries one card, and nothing boxed inside it", () => {
  it("draws the panel's own card — the one card of the step", async () => {
    const { container } = await renderBareGatePanel();
    await screen.findByRole("button", { name: "Approve" });

    const card = stepCard(container);
    expect(card).not.toBeNull();
    expect(card.className).toContain("soft-panel");
    expect(card.className).toContain("rounded-card");
  });

  it("gives the paused gate's content no box of its own inside that card", async () => {
    const { container } = await renderBareGatePanel();
    // The content is there — this is the box coming off it, not the content
    // going away.
    expect(await screen.findByRole("button", { name: "Approve" })).not.toBeNull();
    expect(screen.queryByText(/Run paused — awaiting human approval/)).not.toBeNull();

    expect(boxedDescendants(stepCard(container))).toEqual([]);
  });

  it("gives a failed run's error no box of its own inside that card", async () => {
    const { container } = await renderBareGatePanel(hookResultFailed);

    expect(await screen.findByText("Error")).not.toBeNull();
    expect(screen.queryByText(/The provider refused the call\./)).not.toBeNull();

    expect(boxedDescendants(stepCard(container))).toEqual([]);
  });
});

/**
 * THE ONE BOX THIS ISSUE DOES NOT TAKE OFF — recorded, not assumed.
 *
 * An independent review of this change read the xRenderer reading of the same
 * card and asked why the fields region still carries a plate of its own inside
 * the step's card, when item 4's acceptance sentence says "at most one
 * bordered/panel container wraps the step's rendered form".
 *
 * The answer is that the plate is GIVEN, by a different ratified sentence, and
 * this issue does not carry the standing to take it away. The input-hierarchy
 * ruling the card's own map cites decides the treatment per host, and for this
 * host it decides in favour of the box, in its own words: the run page and the
 * review page "already carry it, so nothing moves: the region keeps its own
 * box, its ground and its inset". The map is shared with the review page, so
 * unboxing it here would redraw a second surface that this issue never read.
 *
 * The two boxes this issue DOES name are the ones its grounded context names by
 * their class and their lines — the `rounded-control border border-line`
 * wrappers around the paused gate's content and the failed run's error — and
 * the tests above pin both of them off.
 *
 * So this test pins the boundary rather than a preference: the region's
 * treatment is exactly what the shared map hands out for this host, unchanged
 * by this issue. A later reader who wants the plate gone changes the map, for
 * both surfaces, under the ruling that put it there — and this pin is what
 * tells them so.
 */
describe("the fields region's own plate is the shared map's answer, untouched here", () => {
  it("hands the run card the primary treatment, plate and all", async () => {
    const { HITL_FIELDS_REGION_CLASS, hitlFieldPresentationFor } = await import(
      "../agent-hitl-screen-card"
    );

    expect(hitlFieldPresentationFor("run_card")).toBe("primary");
    expect(HITL_FIELDS_REGION_CLASS.primary).toBe(
      "soft-panel rounded-panel p-4 bg-surface-muted flex flex-col gap-4",
    );
  });

  it("gives the same answer to the review page, which is why this issue cannot move it", async () => {
    const { hitlFieldPresentationFor } = await import("../agent-hitl-screen-card");

    expect(hitlFieldPresentationFor("page_gate_region")).toBe(
      hitlFieldPresentationFor("run_card"),
    );
  });
});
