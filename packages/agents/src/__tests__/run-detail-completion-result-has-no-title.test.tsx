// @vitest-environment jsdom
/**
 * THE COMPLETED RUN'S RESULT CARRIES NO TITLE THE DRAWING NEVER DRAWS
 * (cinatra#3149, the re-cut of the seventh round, finding 1).
 *
 * The seventh proof round of this branch was graded on its own pictures and
 * found "a title `Findings` drawn over the structured result inside the
 * completion card on a completed run".
 *
 * The ratified drawing draws the completed run as the header pill, the card,
 * and the result — and it draws no heading over that result. Its section I
 * sentence for the finished run's own page is a list of what the run made:
 *
 *   "A finished run says what it made. The rail's last entry is the run's own
 *    record, and its page lists the run's work: one row per artifact the run
 *    wrote ..."
 *
 * — rows, and no title over them. Fix leg 6 (defect B) stopped this row drawing
 * the raw machine payload and read the findings out as their own sentences,
 * which stands; the leg wrote a literal "Findings" heading over them, which no
 * sentence of the drawing gives. This pin removes the heading and keeps
 * everything leg 6 earned: the sentences themselves, in order, inside the ONE
 * card, with none of the machine's syntax.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-detail-completion-result-has-no-title.test.tsx
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

function plate(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-run-progress-panel]");
  if (el === null) throw new Error("no run-progress plate in the run detail");
  return el;
}

function classTokens(el: HTMLElement): Set<string> {
  return new Set((el.className ?? "").split(/\s+/).filter(Boolean));
}
describe("the result inside the completion card is drawn with no title over it (cinatra#3149, finding 1)", () => {
  it("draws NO 'Findings' heading anywhere in the completed run's card", async () => {
    await renderRunPage({ initialMessages: [finalTranscriptRow(MACHINE_PAYLOAD)] });

    const row = document.querySelector<HTMLElement>('[data-run-transcript-row="final"]')!;
    const list = row.querySelector<HTMLElement>('[data-run-transcript-findings=""]');
    expect(list, "the findings are still read out as a list").not.toBeNull();
    // The word the round photographed, in the card and in the row alike.
    expect(plate().textContent!.includes("Findings")).toBe(false);
    expect(row.textContent!.includes("Findings")).toBe(false);
  });

  it("opens the result with the run's own first sentence, not with a heading", async () => {
    // FORM, NOT THE ONE WORD. A title merely renamed — "Result", "Summary" —
    // is the same departure, so the pin is on where the result begins: its own
    // first sentence, and the list as the block's first element.
    await renderRunPage({ initialMessages: [finalTranscriptRow(MACHINE_PAYLOAD)] });

    const list = document
      .querySelector<HTMLElement>('[data-run-transcript-row="final"]')!
      .querySelector<HTMLElement>('[data-run-transcript-findings=""]')!;
    expect(list.textContent!.startsWith("oasJson was not valid JSON")).toBe(true);
    expect(list.firstElementChild!.tagName).toBe("UL");
    expect(list.children.length).toBe(1);
  });

  it("keeps every finding leg 6 reads out — the sentences, in order, and no machine syntax", async () => {
    await renderRunPage({
      initialMessages: [
        finalTranscriptRow(
          JSON.stringify([
            { code: "a", severity: "suggestion", message: "The intro repeats the subject line." },
            { code: "b", severity: "warning", message: "The second CTA has no link." },
          ]),
        ),
      ],
    });

    const row = document.querySelector<HTMLElement>('[data-run-transcript-row="final"]')!;
    const items = row.querySelectorAll('[data-run-transcript-finding=""]');
    expect([...items].map((node) => node.textContent)).toEqual([
      "The intro repeats the subject line.",
      "The second CTA has no link.",
    ]);
    // Inside the ONE runcard the drawing gives the finished run (fix leg 5),
    // and still with no chrome of its own.
    const list = row.querySelector<HTMLElement>('[data-run-transcript-findings=""]')!;
    expect(plate().contains(list)).toBe(true);
    const tokens = classTokens(list);
    expect(tokens.has("rounded-card")).toBe(false);
    expect(tokens.has("border")).toBe(false);
    for (const token of ["{", "}", "[", "]", '"', "severity", "warning"]) {
      expect(row.textContent!.includes(token), `the row still carries ${token}`).toBe(false);
    }
  });
});
