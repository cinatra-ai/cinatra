// @vitest-environment jsdom
/**
 * THE PLACEHOLDER STANDS INSIDE THE DRAWN CARD FRAME ON THE RUN PAGE
 * (cinatra#3007, fix leg 20).
 *
 * The drawing's sentence this file pins, specs/app-artifact-review.html §I:
 *
 *   "While the run works, the detail carries a placeholder. A run that will ask
 *    for a review carries, in the run detail, the run progress card - and while
 *    the run is working that card is a placeholder for the review screen: the
 *    card frame, and a spinning icon"
 *
 * and its drawn example puts the heading and the arc inside `.runcard`:
 * `border: 1px solid var(--line); border-radius: 12px;
 *  background: var(--surface-strong); padding: 18px 20px`.
 *
 * App262 for #3242 clarifies the frame is the SLOT'S throughout the swap.
 * The rail is a layout, and the placeholder and review draw only content in
 * the same .runcard, so neither a lost ground nor a nested frame can appear.

 * Run:
 *   cd packages/agents && pnpm exec vitest run --no-coverage \
 *     src/__tests__/review-gate-placeholder-card-frame-in-the-run-frame.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
      if (prop === "Loader2Icon" || prop === "Loader2") return actual.Loader2Icon;
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Loader2", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
  rejectReviewTask: vi.fn(async () => undefined),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3007-fx20-frame",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

const { readRunOutputEvidence, getRunRecommendationHoldStateAction } = vi.hoisted(() => ({
  readRunOutputEvidence: vi.fn(),
  getRunRecommendationHoldStateAction: vi.fn(),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence,
}));

/** THE STREAM, set per case: its last word, and no interrupt on file. */
const streamState = vi.hoisted(() => ({
  status: "pending_approval" as string | null,
  interruptContext: null as Record<string, unknown> | null,
}));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: streamState.status,
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: streamState.interruptContext,
    lifecycleInterrupt: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

const RUN_ID = "run-3007-fx20-frame";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SLOT = "[data-run-review-slot]";
const RESOLVE_PATH = "/api/lifecycle-views/resolve";
const GATE = "lcr-3007-fx20-frame-gate";

/** The drawn card frame, in the application's tokens and the drawing's numbers. */
const DRAWN_FRAME = ["border", "border-line", "rounded-[12px]", "bg-surface-strong", "px-[20px]", "py-[18px]"];
/** Any card chrome at all: a border, a radius, a card ground or a panel. */
const CARD_CHROME = /(^|\s)(border|border-line|rounded-\S+|bg-surface-strong|soft-panel)(\s|$)/;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The run's seed route answers `row`; the resolve route answers the gate pending. */
function stubTransport(row: () => Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/agents/runs/")) return json(row());
      if (url.includes(RESOLVE_PATH)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json({
          kind: "artifact_review_gate",
          state: { state: "pending", canDecide: true, canComment: true },
          body: null,
        });
      }
      return new Response("{}", { status: 404 });
    }),
  );
}

function workingRow(): Record<string, unknown> {
  return {
    status: "running",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    lifecycleMoment: null,
    reviewGate: { ref: null, awaiting: false, producedReviewPark: false },
  };
}

function parkedRow(): Record<string, unknown> {
  return {
    ...workingRow(),
    status: "pending_approval",
    lifecycleMoment: "hitl",
    reviewGate: { ref: GATE, awaiting: false, producedReviewPark: true },
  };
}

/** The panel as the run page mounts it, in or out of the rail's frame. */
async function mountPanel(railDrawsTheFrame: boolean) {
  const { ensureDefaultFieldRenderersRegistered } = await import("../register-default-renderers");
  ensureDefaultFieldRenderersRegistered();
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  return render(
    <AgenticRunPanel
      runId={RUN_ID}
      initialStatus="running"
      initialError={null}
      initialMessages={[]}
      agUiEnabled
      agentId="cinatra-ai/blog-draft-writer-agent"
      agentPackageName="@cinatra-ai/blog-draft-writer-agent"
      templateId="tmpl-3007-fx20-frame"
      initialReviewGate={{ ref: null, awaiting: false, producedReviewPark: false }}
      inputStepInRail={railDrawsTheFrame}
      railDrawsTheFrame={railDrawsTheFrame}
    />,
  );
}

async function placeholderRoot(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = document.querySelector<HTMLElement>(PLACEHOLDER);
      if (!el) throw new Error("the placeholder is not drawn");
      return el;
    },
    { timeout: 10_000 },
  );
}

function classesOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

beforeEach(() => {
  streamState.status = "running";
  streamState.interruptContext = null;
  readRunOutputEvidence.mockReset();
  readRunOutputEvidence.mockResolvedValue({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  });
  getRunRecommendationHoldStateAction.mockReset();
  getRunRecommendationHoldStateAction.mockResolvedValue({ state: "none" });
  cleanup();
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark", "cinatra");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

afterAll(() => {
  vi.doUnmock("next/navigation");
  vi.doUnmock("sonner");
  vi.doUnmock("lucide-react");
  vi.doUnmock("../hitl-actions");
  vi.doUnmock("../a2a-actions");
  vi.doUnmock("../server-actions");
  vi.doUnmock("../agent-ui-override-registry");
  vi.doUnmock("../run-recommendation-actions");
  vi.doUnmock("../run-actions");
  vi.doUnmock("../use-ag-ui-run-stream");
  vi.resetModules();
});

describe("the working placeholder inside the rail's frame is the drawn run card (cinatra#3007, fix leg 20)", () => {
  // F1 - the slot keeps the drawn frame around the placeholder on the run page.
  it.each(["light", "dark"])("F1: inside the rail the slot draws the card frame around the unframed placeholder and arc (%s)", async (palette) => {
    document.documentElement.classList.add(palette === "dark" ? "dark" : "cinatra");
    stubTransport(workingRow);
    await mountPanel(true);
    const root = await placeholderRoot();
    const box = document.querySelector<HTMLElement>(SLOT)!;
    const classes = classesOf(box);
    expect(root.getAttribute("class") ?? "").not.toMatch(CARD_CHROME);
    for (const token of DRAWN_FRAME) {
      expect(classes, `the slot is missing ${token} (it reads "${classes.join(" ")}")`).toContain(token);
    }
    // The heading and the arc stand INSIDE that root.
    expect(root.textContent).toContain("Agentic Run Progress");
    expect(root.querySelector("svg.animate-spin")).not.toBeNull();
  });

  // F1g - GUARDS, green before the change and after it.
  it("F1g: the slot owns the only frame and its placeholder adds no chrome", async () => {
    stubTransport(workingRow);
    await mountPanel(true);
    await placeholderRoot();
    const box = document.querySelector<HTMLElement>(SLOT);
    expect(box).not.toBeNull();
    for (const token of DRAWN_FRAME) expect(classesOf(box!)).toContain(token);
    const placeholder = box!.querySelector(PLACEHOLDER);
    if (placeholder) expect(placeholder.getAttribute("class") ?? "").not.toMatch(CARD_CHROME);
  });

  it("F1g: off the rail's frame the box keeps its measured card frame and the placeholder draws none of its own", async () => {
    stubTransport(workingRow);
    await mountPanel(false);
    const root = await placeholderRoot();
    const box = document.querySelector<HTMLElement>(SLOT);
    expect(box!.getAttribute("class")).toContain("rounded-card");
    expect(box!.getAttribute("class")).toContain("bg-surface-strong");
    expect(root.getAttribute("class") ?? "").not.toMatch(CARD_CHROME);
  });

  it("F1g: the placeholder mounted with no property draws no frame", async () => {
    const { ReviewGatePlaceholder } = await import("../review-gate-states");
    const { container } = render(<ReviewGatePlaceholder />);
    const root = container.querySelector<HTMLElement>(PLACEHOLDER);
    expect(root).not.toBeNull();
    expect(root!.getAttribute("class")).toBe("flex w-full flex-col gap-3");
  });

  it.each(["light", "dark"])("F1g: once the real review card has drawn, no placeholder or spinning arc remains (%s)", async (palette) => {
    document.documentElement.classList.add(palette === "dark" ? "dark" : "cinatra");
    stubTransport(parkedRow);
    streamState.status = "pending_approval";
    await mountPanel(true);
    await waitFor(
      () => {
        if (!document.querySelector(REVIEW_CARD)) throw new Error("the review card has not drawn");
        if (document.querySelector(PLACEHOLDER)) throw new Error("the placeholder still stands");
      },
      { timeout: 25_000 },
    );
    const box = document.querySelector<HTMLElement>(SLOT);
    expect(box!.getAttribute("data-run-review-slot")).toBe("review");
    for (const token of DRAWN_FRAME) expect(classesOf(box!)).toContain(token);
    const placeholder = box!.querySelector(PLACEHOLDER);
    if (placeholder) expect(placeholder.getAttribute("class") ?? "").not.toMatch(CARD_CHROME);
    expect(box!.querySelector("svg.animate-spin")).toBeNull();
    const framedChildren = Array.from(box!.children).filter((child) =>
      DRAWN_FRAME.every((token) => classesOf(child).includes(token)),
    );
    expect(framedChildren).toHaveLength(0);
  }, 60_000);
});
