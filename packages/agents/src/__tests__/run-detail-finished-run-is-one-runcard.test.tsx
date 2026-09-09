// @vitest-environment jsdom
/**
 * THE FINISHED RUN'S DETAIL IS ONE RUNCARD (cinatra#3149, fix leg 5).
 *
 * The third proof round graded the finished run's detail on the run page and
 * recorded three defects on the issue's own subject, two of them STRUCTURE:
 *
 *   (4) "the drawn run-progress card is gone — what renders is the drawing's
 *       INNER bordered box alone, so the plate title 'Agentic Run Progress' is
 *       absent and the state pill is hoisted outside every frame, above the
 *       card on the tab-strip line"
 *   (7) "a SECOND panel titled 'Final response' is stacked beneath the one
 *       completion card in the same detail — the drawing draws ONE card for the
 *       finished run"
 *   (8) "that second panel draws a raw machine payload as reader-facing prose"
 *
 * The ratified drawing (specs/app-artifact-review.html §I, example
 * `run-schedule-step-fired`) draws the finished run's detail as ONE `.runcard`
 * — `border: 1px solid var(--line); border-radius: 12px; background:
 * var(--surface-strong)` — whose FIRST child is a header flex row carrying the
 * plate title "Agentic Run Progress" and, beside it
 * (`justify-content:space-between`), the state pill with the drawn word
 * "completed". Inside that card the drawing puts ONE inner box: the completion
 * reading, whose sentence sends the reader to the transcript below it.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-detail-finished-run-is-one-runcard.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["AlertCircle", "ArrowRight", "CalendarClock", "Clock", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  getSkillsForAgentAction: vi.fn(async () => []),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(() => new Promise<never>(() => {})),
  sendAgentBuilderMessage: vi.fn(async () => ({})),
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: "completed",
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  }),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: true,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  })),
}));

import { SetupCompletionWatcher } from "../setup-completion-watcher";
import type { SerializedAgentRunMessage } from "../agentic-run-panel";

type WatcherProps = React.ComponentProps<typeof SetupCompletionWatcher>;

/** Prose — a run's own answer, in the reader's language. */
const PROSE_ANSWER =
  "The review found three issues in the diff and none of them block the merge.";

/**
 * THE PAYLOAD THE THIRD ROUND MEASURED. The finished run of the graded round
 * (`b0aaabbf`) left exactly one `final` transcript row, and its content is this
 * machine value — a JSON array of reviewer findings, not a sentence anybody
 * wrote to be read.
 */
const MACHINE_PAYLOAD =
  '[{"code":"unparseable_oas","severity":"suggestion","message":"oasJson was not valid JSON; cannot review code quality.","source":"agent-code-reviewer"}]';

function finalTranscriptRow(text: string): SerializedAgentRunMessage {
  return {
    id: "msg-final-1",
    runId: "run-3149",
    sequence: 1,
    role: "assistant" as const,
    messageType: "final" as const,
    toolCallId: null,
    toolName: null,
    body: { messageType: "final" as const, role: "assistant" as const, text },
    createdAt: "2026-09-09T00:01:19.375Z",
  };
}

/**
 * The run page's own mount for a finished run, on the reading the rail frames —
 * `railFramesTheRunDetail` is true for every run with a recommendation step, an
 * input step or a schedule step (instance-screens.tsx), and the graded round's
 * run is a schedule-step run, which is the drawing's own completed example.
 */
function runPageProps(overrides: Partial<WatcherProps> = {}): WatcherProps {
  return {
    runId: "run-3149",
    agentId: "cinatra-ai/code-reviewer-agent",
    instanceId: "run-3149",
    initialStatus: "completed",
    initialError: null,
    initialMessages: [finalTranscriptRow(PROSE_ANSWER)],
    requiredFields: [],
    initialInputParams: {},
    agUiEnabled: false,
    runHasExecuted: true,
    triggerConfigured: true,
    initialStreamedText: "",
    railDrawsTheFrame: true,
    ...overrides,
  };
}

beforeEach(() => {
  routerPush.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ reviewGate: { ref: null, awaiting: false } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderRunPage(overrides: Partial<WatcherProps> = {}) {
  render(<SetupCompletionWatcher {...runPageProps(overrides)} />);
  await waitFor(() =>
    expect(document.querySelector("[data-run-completion]")).not.toBeNull(),
  );
  await waitFor(() =>
    expect(screen.queryByText(/could not be loaded here/i)).toBeNull(),
  );
}

/** A reading that is NOT the finished run, so it draws no completion card. */
async function renderUnfinishedRunPage(overrides: Partial<WatcherProps> = {}) {
  render(<SetupCompletionWatcher {...runPageProps(overrides)} />);
  await waitFor(() =>
    expect(document.querySelector("[data-run-progress-panel]")).not.toBeNull(),
  );
}

function plate(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-run-progress-panel]");
  if (el === null) throw new Error("no run-progress plate in the run detail");
  return el;
}

function classTokens(el: HTMLElement): Set<string> {
  return new Set((el.className ?? "").split(/\s+/).filter(Boolean));
}

describe("defect 4 — the finished run's detail is drawn as the ratified runcard", () => {
  it("draws the runcard frame the drawing gives it — 1px line border, 12px radius, surface-strong ground", async () => {
    await renderRunPage();

    const tokens = classTokens(plate());
    // `.runcard { border: 1px solid var(--line); border-radius: 12px;
    //   background: var(--surface-strong); }`
    expect(tokens.has("border")).toBe(true);
    expect(tokens.has("border-line")).toBe(true);
    expect(tokens.has("rounded-card")).toBe(true);
    expect(tokens.has("bg-surface-strong")).toBe(true);
  });

  it("carries the plate title 'Agentic Run Progress' as the card's first child", async () => {
    await renderRunPage();

    const heading = screen.queryByText(/Agentic Run Progress/i);
    expect(heading).not.toBeNull();
    expect(plate().contains(heading as Node)).toBe(true);
  });

  it("keeps the state pill inside that header row, never hoisted above the card", async () => {
    await renderRunPage();

    const pill = document.querySelector<HTMLElement>('[data-slot="status-pill"]');
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain("completed");
    // THE ANCESTOR CHAIN THE ROUND MEASURED: the pill sat outside every frame,
    // above the card. It belongs inside the runcard, in the header row beside
    // the plate title, at `justify-content:space-between`.
    expect(plate().contains(pill as Node)).toBe(true);
    const headerRow = pill!.parentElement as HTMLElement;
    const headerTokens = classTokens(headerRow);
    expect(headerTokens.has("flex")).toBe(true);
    expect(headerTokens.has("items-center")).toBe(true);
    expect(headerTokens.has("justify-between")).toBe(true);
    // The header row is the card's FIRST child, and BOTH the title and the pill
    // are its own children — `contains` alone would still pass if the header
    // sank below the completion box or the two drifted into separate rows.
    expect(plate().firstElementChild).toBe(headerRow);
    const heading = screen.queryByText(/Agentic Run Progress/i);
    expect(heading!.parentElement).toBe(headerRow);
    expect(pill!.parentElement).toBe(headerRow);
  });

  it("leaves every rail-framed moment that is NOT the finished run exactly as it was", async () => {
    // THE CONVERGENCE ROUND'S FIRST FINDING. The frame and the title come back
    // for the reading the round graded and for no other: cinatra#3047 retired
    // this plate's chrome around a gate's own card ("two cards are never
    // stacked in one detail") and cinatra#3068 retired the header with it. A
    // run that has not finished keeps that reading, byte for byte.
    // A run still in flight draws the watcher's own waiting screen rather than
    // this plate, so the reading that stands next to the finished one is the
    // run that ENDED without completing.
    await renderUnfinishedRunPage({ initialStatus: "failed" });

    const tokens = classTokens(plate());
    expect(tokens.has("border")).toBe(false);
    expect(tokens.has("rounded-card")).toBe(false);
    expect(tokens.has("bg-surface-strong")).toBe(false);
    expect(screen.queryByText(/Agentic Run Progress/i)).toBeNull();
  });

  it("leaves the run's first step unframed, as cinatra#3113 drew it", async () => {
    await renderUnfinishedRunPage({ inputStepInRail: true });

    const tokens = classTokens(plate());
    expect(tokens.has("border")).toBe(false);
    expect(tokens.has("rounded-card")).toBe(false);
    expect(screen.queryByText(/Agentic Run Progress/i)).toBeNull();
  });
});

describe("defect 7 — ONE card for the finished run, no second stacked panel", () => {
  it("draws the run's produced output with no panel and no title of its own", async () => {
    await renderRunPage();

    const row = document.querySelector<HTMLElement>('[data-run-transcript-row="final"]');
    expect(row).not.toBeNull();
    // Still inside the ONE runcard, below the inner box the drawing draws.
    expect(plate().contains(row as Node)).toBe(true);
    // ...but not a SECOND panel: no card chrome of its own.
    const tokens = classTokens(row!);
    expect(tokens.has("rounded-card")).toBe(false);
    expect(tokens.has("border")).toBe(false);
    expect(tokens.has("border-line")).toBe(false);
    expect(tokens.has("bg-surface-strong")).toBe(false);
    // ...and no panel title. "Final response" was the second panel's own name.
    expect(row!.querySelector('[data-run-transcript-label=""]')).toBeNull();
    expect(screen.queryByText("Final response")).toBeNull();
    // ...and nothing between the row and the card draws a panel around it
    // either — a bordered WRAPPER would read as the same second card.
    for (
      let node = row!.parentElement;
      node !== null && node !== plate();
      node = node.parentElement
    ) {
      const wrapperTokens = classTokens(node);
      expect(wrapperTokens.has("border")).toBe(false);
      expect(wrapperTokens.has("rounded-card")).toBe(false);
      expect(wrapperTokens.has("bg-surface-strong")).toBe(false);
    }
    // The card's own sentence sends the reader BELOW it, so the transcript
    // follows the inner box rather than standing over it.
    const inner = plate().querySelector("[data-run-completion]") as HTMLElement;
    expect(
      inner.compareDocumentPosition(row as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the transcript row's own panel and title where no completion card introduces it", async () => {
    // THE CONVERGENCE ROUND'S SECOND FINDING. The graded defect is a second
    // panel "stacked beneath the one completion card". A run that has not
    // finished draws no completion card, so its `final` row is introduced by
    // nothing and keeps the box and the label it has always had.
    await renderUnfinishedRunPage({ initialStatus: "failed" });

    const row = document.querySelector<HTMLElement>('[data-run-transcript-row="final"]');
    expect(row).not.toBeNull();
    expect(classTokens(row!).has("rounded-card")).toBe(true);
    expect(
      row!.querySelector('[data-run-transcript-label=""]')?.textContent,
    ).toBe("Final response");
  });

  it("leaves the completion reading as the card's one inner box", async () => {
    await renderRunPage();

    const inner = plate().querySelectorAll("[data-run-completion]");
    expect(inner.length).toBe(1);
    expect(screen.queryByText("Run complete")).not.toBeNull();
  });
});

describe("defect 8 — a machine payload is never drawn as reader-facing prose", () => {
  it("sets the run's machine payload in the design system's own type for code", async () => {
    await renderRunPage({ initialMessages: [finalTranscriptRow(MACHINE_PAYLOAD)] });

    const body = document
      .querySelector<HTMLElement>('[data-run-transcript-row="final"]')
      ?.querySelector<HTMLElement>('[data-run-transcript-body=""]');
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain("unparseable_oas");
    // The design system reserves mono for metadata, tokens, labels and code
    // (app-components.html). A JSON payload is code; it is never an answer set
    // in body type.
    expect(body!.tagName).toBe("PRE");
    expect(classTokens(body!).has("font-mono")).toBe(true);
  });

  it("leaves a JSON SCALAR and a malformed value in prose — the test is form, not intent", async () => {
    // The convergence round asked for the narrow reading to be pinned: only a
    // JSON object or array is set as code.
    await renderRunPage({ initialMessages: [finalTranscriptRow("42")] });
    let body = document
      .querySelector<HTMLElement>('[data-run-transcript-row="final"]')
      ?.querySelector<HTMLElement>('[data-run-transcript-body=""]');
    expect(body!.tagName).toBe("P");

    cleanup();
    await renderRunPage({
      initialMessages: [finalTranscriptRow("{ this is not JSON at all")],
    });
    body = document
      .querySelector<HTMLElement>('[data-run-transcript-row="final"]')
      ?.querySelector<HTMLElement>('[data-run-transcript-body=""]');
    expect(body!.tagName).toBe("P");
  });

  it("still draws a real answer as prose", async () => {
    await renderRunPage();

    const body = document
      .querySelector<HTMLElement>('[data-run-transcript-row="final"]')
      ?.querySelector<HTMLElement>('[data-run-transcript-body=""]');
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe(PROSE_ANSWER);
    expect(body!.tagName).toBe("P");
    expect(classTokens(body!).has("font-mono")).toBe(false);
    expect(classTokens(body!).has("break-all")).toBe(false);
  });
});
