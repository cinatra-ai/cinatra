// @vitest-environment jsdom
/**
 * The stream road obeys the same allowlist as the mount guard.
 *
 * A dispatched run parked twice: it reached `queued` with no trigger row and
 * the run page returned it to the /trigger setup wizard. The mount guard is one
 * of three roads that can push there; the stream road is another, and it kept a
 * NEGATIVE check (bail only on `failed`/`stopped`) after the mount guard moved
 * to the positive allowlist. So once a setup interrupt had been seen and
 * cleared, a run fetched back as `queued` or `running` was still pushed into the
 * wizard - the same park, on the road the other suite does not exercise
 * (it runs with the stream off).
 *
 * This suite drives the stream road: interrupt seen, interrupt cleared, run
 * fetched back dispatched.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/setup-completion-watcher-sse-dispatched-run-no-bounce.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { GROUPED_SETUP_FORM_RENDERER_ID } from "../agent-builder-ids";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../agentic-run-panel", () => ({
  AgenticRunPanel: () => <div data-testid="run-panel" />,
}));

// A mutable stream: the first render delivers the setup interrupt (so the
// watcher records that setup was seen), every render after it delivers a
// cleared interrupt, which is what arms the stream road's fetch.
let streamStatus = "queued";
let interruptContext: { xRenderer: string } | null = null;
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: streamStatus,
    interruptContext,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    error: null,
  }),
}));

let liveStatus = "queued";
const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({ status: liveStatus, inputParams: { idea: { title: "x" } } }),
}));

beforeEach(() => {
  streamStatus = "queued";
  liveStatus = "queued";
  interruptContext = { xRenderer: GROUPED_SETUP_FORM_RENDERER_ID };
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

type WatcherProps = React.ComponentProps<
  typeof import("../setup-completion-watcher").SetupCompletionWatcher
>;

function baseProps(overrides: Partial<WatcherProps> = {}): WatcherProps {
  return {
    runId: "run-3033",
    agentId: "cinatra-ai/blog-idea-generator-agent",
    instanceId: "run-3033",
    agUiEnabled: true as boolean | null,
    initialStatus: "queued",
    initialError: null,
    initialMessages: [],
    requiredFields: ["idea"],
    initialInputParams: { idea: { title: "Shipping agent runs" } },
    initialStreamedText: "",
    runHasExecuted: false,
    triggerConfigured: false,
    ...overrides,
  };
}

async function renderWithClearedInterrupt(props: WatcherProps) {
  const { SetupCompletionWatcher } = await import("../setup-completion-watcher");
  const view = render(<SetupCompletionWatcher {...props} />);
  // The setup interrupt has now been observed; clear it and re-render, which is
  // exactly what the stream road watches for.
  interruptContext = null;
  view.rerender(<SetupCompletionWatcher {...props} />);
  return view;
}

describe("SetupCompletionWatcher - the stream road never bounces a dispatched run", () => {
  it("does not redirect when the run is fetched back as `queued`", async () => {
    await renderWithClearedInterrupt(baseProps());
    await new Promise((r) => setTimeout(r, 1200));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("does not redirect when the run is fetched back as `running`", async () => {
    liveStatus = "running";
    await renderWithClearedInterrupt(baseProps({ initialStatus: "running" }));
    await new Promise((r) => setTimeout(r, 1200));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("still hands a genuine setup-success run over on the stream road", async () => {
    liveStatus = "pending_trigger";
    await renderWithClearedInterrupt(baseProps());
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith(
        "/agents/cinatra-ai/blog-idea-generator-agent/run-3033/trigger",
      ),
    );
  });

  it("still hands a `completed` setup-success run over on the stream road", async () => {
    liveStatus = "completed";
    await renderWithClearedInterrupt(baseProps());
    await waitFor(() => expect(routerPush).toHaveBeenCalledTimes(1));
  });
});
