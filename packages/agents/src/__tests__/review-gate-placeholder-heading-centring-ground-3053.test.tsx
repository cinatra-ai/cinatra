// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// THE PLACEHOLDER'S HEADING, ITS CENTRED ARC, AND ITS GROUND (cinatra#3044,
// the eleventh set's placeholder pair, graded 7 of 10).
// ---------------------------------------------------------------------------
// Three sentences of the ratified drawing were measured against the shipped
// placeholder and three of them did not hold. Each one is quoted here beside
// the pin that holds it.
//
// THE DRAWING'S OWN WORKED EXAMPLE is the measure. Section II carries the
// placeholder as a drawn reading, `data-conformance-id` "run-progress-
// placeholder-in-thread", and it is markup, not prose:
//
//   <div class="runcard">
//     <div style="font-family:var(--font-sans);font-weight:700;font-size:14px;
//                 color:var(--ink);">Agentic Run Progress</div>
//     <div style="display:grid;place-items:center;padding:26px 0 22px;">
//       …the spinning arc…
//     </div>
//   </div>
//
// and the frame it stands in, from the same stylesheet:
//
//   .runcard { border: 1px solid var(--line); border-radius: 12px;
//              background: var(--surface-strong); padding: 18px 20px; }
//
// PROSE AND EXAMPLE, RECONCILED. The same section's prose says the placeholder
// "names no status, reports no result and draws nothing to press", and an
// earlier set read that as "no text at all" and pinned an empty placeholder.
// The two readings are not in conflict once the subject of each clause is read:
// what the prose forbids is a STATUS word, a RESULT and a CONTROL. The heading
// the example draws is none of those three — it is the card's own name, the
// name the same section uses for it in prose ("the run progress card"), fixed
// and identical on every run. So the placeholder carries the card's name and
// still names no status, reports no result and draws nothing to press. The
// pins that read the prose as "no text" are updated alongside this file, in the
// same change, rather than left to fail: they were the earlier reading of a
// sentence the drawn example settles.
//
// Run:
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/review-gate-placeholder-heading-centring-ground-3053.test.tsx
import { readFileSync } from "node:fs";
import path from "node:path";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { ReviewGatePlaceholder } from "../review-gate-states";

const GLOBALS = readFileSync(
  path.resolve(__dirname, "../../../../src/app/globals.css"),
  "utf8",
);

const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const SLOT = "[data-run-review-slot]";

function placeholderRoot(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(PLACEHOLDER);
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

// ---------------------------------------------------------------------------
// 1. THE HEADING THE DRAWING PUTS AT THE CARD'S HEAD
// ---------------------------------------------------------------------------
//
//   "<div style="font-family:var(--font-sans);font-weight:700;font-size:14px;
//     color:var(--ink);">Agentic Run Progress</div>"
//
// — the drawn placeholder's first child, above the spinner band.
//
// WHAT WAS MEASURED: the placeholder drew no text at all, so the card in the
// turn stood nameless while the drawn one names itself.

describe("the placeholder draws the drawing's heading at its head", () => {
  afterEach(cleanup);

  it("carries the heading text the drawn example gives, exactly", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const root = placeholderRoot(container);
    expect(root.textContent?.trim()).toBe("Agentic Run Progress");
  });

  it("draws it as the card's FIRST child, above the spinner band", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const root = placeholderRoot(container);
    const head = root.firstElementChild as HTMLElement | null;
    expect(head).not.toBeNull();
    expect(head!.textContent?.trim()).toBe("Agentic Run Progress");
    // The arc is NOT in the heading — it is the band beneath it.
    expect(head!.querySelector("svg")).toBeNull();
    expect(root.querySelector("svg")).not.toBeNull();
  });

  it("takes the drawn weight, size and colour token", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const head = placeholderRoot(container).firstElementChild as HTMLElement;
    const classes = head.className;
    // font-weight:700
    expect(classes).toMatch(/\bfont-bold\b/);
    // font-size:14px
    expect(classes).toMatch(/\btext-sm\b/);
    // color: var(--ink) — the drawing's `--ink` is #15213a, and the token this
    // application registers at that value is `--foreground`. Same colour, this
    // codebase's name for it.
    expect(classes).toMatch(/\btext-foreground\b/);
    expect(GLOBALS).toMatch(/--foreground:\s*#15213a/i);
    expect(GLOBALS).toMatch(/--color-foreground:\s*var\(--foreground\)/);
  });

  it("still names no status, reports no result and draws nothing to press", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const root = placeholderRoot(container);
    // The name is FIXED — it never carries a run's state word.
    expect(root.textContent).not.toMatch(
      /queued|running|working|waiting|pending|complete|failed|done/i,
    );
    expect(root.querySelectorAll("button").length).toBe(0);
    expect(root.querySelectorAll("a").length).toBe(0);
    // And exactly one graphic, still.
    expect(root.querySelectorAll("svg").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. THE ARC SITS ON THE CARD'S CENTRE
// ---------------------------------------------------------------------------
//
//   "<div style="display:grid;place-items:center;padding:26px 0 22px;">"
//
// — a full-width centred band, the whole width of the card, with the arc placed
// in the middle of it.
//
// WHAT WAS MEASURED: the arc was drawn in a left-aligned
// `flex flex-wrap items-center` row, so it sat hard against the card's leading
// edge instead of on its centre.
//
// The BOX measurement — the arc's bounding-box centre against the card's own —
// is taken on a live boot, where a real layout engine resolves these utilities;
// jsdom lays nothing out and every rectangle it reports is zero. What is pinned
// here is the thing the live measurement depends on: the band is a full-width
// centring band and the left-aligned row is gone.

describe("the arc is drawn on the card's horizontal centre", () => {
  afterEach(cleanup);

  /** The band the drawn example wraps the spinner in. */
  function arcBand(container: HTMLElement): HTMLElement {
    const root = placeholderRoot(container);
    const svg = root.querySelector("svg");
    expect(svg).not.toBeNull();
    // THE BAND IS THE ARC'S OWN PARENT (cinatra#3046, fix leg 12). It used to be
    // the parent of a coloured TILE the arc was wrapped in; the drawing's band
    // holds the arc directly, and the tenth graded reading measured that tile as
    // chrome the drawing does not give.
    const band = svg!.parentElement as HTMLElement;
    expect(band).not.toBeNull();
    expect(band.contains(svg as Node)).toBe(true);
    return band;
  }

  it("wraps the arc in a full-width centring band, not a left-aligned row", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const band = arcBand(container).className;
    // display:grid; place-items:center
    expect(band).toMatch(/\bgrid\b/);
    expect(band).toMatch(/\bplace-items-center\b/);
    // …spanning the card, so "centre" is the CARD's centre.
    expect(band).toMatch(/\bw-full\b/);
    // The measured left-aligned row is gone: no flex row wrapping the arc.
    expect(band).not.toMatch(/\bflex\b/);
    expect(band).not.toMatch(/\bflex-wrap\b/);
  });

  it("gives the band the drawn vertical padding", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const band = arcBand(container).className;
    // padding: 26px 0 22px
    expect(band).toMatch(/(?:^|\s)pt-\[26px\](?:\s|$)/);
    expect(band).toMatch(/(?:^|\s)pb-\[22px\](?:\s|$)/);
  });

  it("puts nothing beside the arc in the band that could pull it off centre", () => {
    const { container } = render(<ReviewGatePlaceholder />);
    const band = arcBand(container);
    // One child only: the arc itself. A sibling in a centring band shifts the
    // arc off the centre just as surely as a left-aligned row does.
    expect(band.children.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. THE CARD'S GROUND IS THE DRAWN TOKEN
// ---------------------------------------------------------------------------
//
//   ".runcard { border: 1px solid var(--line); border-radius: 12px;
//               background: var(--surface-strong); padding: 18px 20px; }"
//
// WHAT WAS MEASURED: the box the placeholder stands in took `.soft-panel`,
// whose ground is `var(--surface)` — one token light of the drawn
// `var(--surface-strong)`.
//
// THE SEAM. `ReviewGateCard`'s `run_card` frame draws no background of its own
// (`HOST_FRAME.run_card` is layout only), so the ground a reader sees for this
// card is the run panel's own slot section. That section is where the token is
// read, and this pin reads it on the real component in its real working state.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
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
    runId: "run-3044",
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

const {
  readRunOutputEvidence,
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
} = vi.hoisted(() => ({
  readRunOutputEvidence: vi.fn(),
  getRunRecommendationHoldStateAction: vi.fn(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence,
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: null,
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

function stubWorkingRun() {
  const body = {
    status: "running",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: null, awaiting: false },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
}

describe("the box the placeholder stands in takes the drawn ground", () => {
  beforeEach(() => {
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
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("draws the working slot on surface-strong, not the lighter surface", async () => {
    stubWorkingRun();
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        runId="run-3044"
        initialStatus="running"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={false}
        templateId="tmpl-3044"
        surface="chat"
        initialReviewGate={{ ref: null, awaiting: false }}
      />,
    );

    await waitFor(() => expect(document.querySelector(PLACEHOLDER)).not.toBeNull());
    const slot = document.querySelector<HTMLElement>(SLOT);
    expect(slot).not.toBeNull();
    expect(slot!.getAttribute("data-run-review-slot")).toBe("working");
    const classes = slot!.className;
    // background: var(--surface-strong)
    expect(classes).toMatch(/\bbg-surface-strong\b/);
    // …and the measured one-token-light ground is gone.
    expect(classes).not.toMatch(/\bsoft-panel\b/);
    expect(classes).not.toMatch(/\bbg-surface\b(?!-)/);
    // border: 1px solid var(--line); border-radius (the card radius).
    expect(classes).toMatch(/\bborder\b/);
    expect(classes).toMatch(/\bborder-line\b/);
    expect(classes).toMatch(/\brounded-card\b/);
  });

  it("the heading arrives with the card, on the live panel", async () => {
    stubWorkingRun();
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        runId="run-3044"
        initialStatus="running"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={false}
        templateId="tmpl-3044"
        surface="chat"
        initialReviewGate={{ ref: null, awaiting: false }}
      />,
    );

    await waitFor(() => expect(document.querySelector(PLACEHOLDER)).not.toBeNull());
    expect(screen.queryByText("Agentic Run Progress")).not.toBeNull();
  });
});

describe("the two grounds are actually different tokens", () => {
  it("surface-strong is registered and is not the same value as surface", () => {
    expect(GLOBALS).toMatch(/--color-surface-strong:\s*var\(--surface-strong\)/);
    expect(GLOBALS).toMatch(/--surface:\s*#f7f7f3/i);
    expect(GLOBALS).toMatch(/--surface-strong:\s*#ffffff/i);
  });
});
