// @vitest-environment jsdom
/**
 * AgenticRunPanel renders accumulated streamed text from
 * `useAgUiRunStream().streamedText` in a conditional "Agent output" section.
 *
 *    cd packages/agent-builder && pnpm vitest run src/__tests__/agentic-run-panel.streamed-text.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Hoisted hook-mock state — mutated per-test before render.
// ---------------------------------------------------------------------------

const hookState = vi.hoisted(() => ({
  streamedText: "" as string | undefined,
  status: "completed" as string,
  dataPartFrames: [] as unknown[],
}));

// ---------------------------------------------------------------------------
// Dependency mocks — copied verbatim from agentic-run-panel.hitl.test.tsx so
// AgenticRunPanel can import in jsdom (sdk-ui, sonner, lucide-react, hitl
// actions, a2a actions, server actions, override registry). Extra mocks are
// harmless.
// ---------------------------------------------------------------------------

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return {
    ExternalLink: StubIcon,
    default: StubIcon,
  };
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
    runId: "run-1",
  })),
}));
vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

// ---------------------------------------------------------------------------
// Streaming hook mock — panel sees `streamedText` directly.
// ---------------------------------------------------------------------------

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: hookState.status,
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: hookState.streamedText,
    dataPartFrames: hookState.dataPartFrames,
  }),
}));

import { AgenticRunPanel } from "../agentic-run-panel";

beforeEach(() => {
  hookState.streamedText = "";
  hookState.status = "completed";
  hookState.dataPartFrames = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgenticRunPanel — streamedText render block", () => {
  it("renders 'Agent output' section with streamed text when non-empty", async () => {
    hookState.streamedText = "Hello from helloworld peer";

    render(
      <AgenticRunPanel
        runId="run-ext-render"
        initialStatus="completed"
        initialError={null}
        initialMessages={[]}
        agentPackageName="@a2a-dev-localhost-10001/hello-world"
        agUiEnabled={true}
      />,
    );

    expect(await screen.findByText("Agent output")).toBeTruthy();
    expect(await screen.findByText("Hello from helloworld peer")).toBeTruthy();
  });

  it("does NOT render 'Agent output' section when streamedText is empty", () => {
    hookState.streamedText = "";

    render(
      <AgenticRunPanel
        runId="run-ext-render-empty"
        initialStatus="completed"
        initialError={null}
        initialMessages={[]}
        agentPackageName="@a2a-dev-localhost-10001/hello-world"
        agUiEnabled={true}
      />,
    );

    expect(screen.queryByText("Agent output")).toBeNull();
  });

  // Internal agents never emit TEXT_MESSAGE_* events, so they must not see an
  // "Agent output" section even if streamedText is absent from the hook result.
  it("does NOT render 'Agent output' section when hook returns no streamedText field (internal-agent non-regression)", () => {
    // Simulate an internal-run hook return: no streamedText key at all.
    hookState.streamedText = undefined;

    render(
      <AgenticRunPanel
        runId="run-internal-regression"
        initialStatus="completed"
        initialError={null}
        initialMessages={[]}
        agentPackageName="@cinatra/agent-scrape"
        agUiEnabled={true}
      />,
    );

    expect(screen.queryByText("Agent output")).toBeNull();
  });

  // Panel renders Agent output from initialStreamedText on first paint when no
  // live SSE streamedText has arrived yet.
  it("renders 'Agent output' from initialStreamedText prop when hook streamedText is empty", async () => {
    // Hook mock returns empty streamedText — simulates a post-completion page load
    // where SSE is closed but the DB has the persisted text.
    hookState.streamedText = "persisted from DB via initial prop";

    render(
      <AgenticRunPanel
        runId="run-ext-hydrate"
        initialStatus="completed"
        initialError={null}
        initialMessages={[]}
        agentPackageName="@a2a-dev-localhost-10001/hello-world"
        agUiEnabled={true}
        initialStreamedText="persisted from DB via initial prop"
      />,
    );

    expect(await screen.findByText("Agent output")).toBeTruthy();
    expect(await screen.findByText("persisted from DB via initial prop")).toBeTruthy();
  });

  // Structured output block renders when hook returns non-empty dataPartFrames.
  // Uses React's default JSX escaping for JSON.stringify output.
  it("renders 'Structured output' block when dataPartFrames is non-empty", async () => {
    hookState.streamedText = "";
    hookState.dataPartFrames = [{ foo: 1 }, { bar: 2 }];

    render(
      <AgenticRunPanel
        runId="run-ext-data-part-render"
        initialStatus="completed"
        initialError={null}
        initialMessages={[]}
        agentPackageName="@a2a-dev-localhost-10001/hello-world"
        agUiEnabled={true}
      />,
    );

    expect(await screen.findByText("Structured output")).toBeTruthy();
    // JSON serialised payload must be reachable via text content (React-escaped).
    // Use a function matcher targeted at <pre> because testing-library's default
    // string matcher normalises both haystack and needle but still requires the
    // candidate element's textContent to equal the (normalised) needle — which
    // it does for multi-line JSON inside <pre>, but only when matched per-element.
    const pretty = JSON.stringify([{ foo: 1 }, { bar: 2 }], null, 2);
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "PRE" && (element.textContent ?? "") === pretty,
      ),
    ).toBeTruthy();
  });

  it("does NOT render 'Structured output' block when dataPartFrames is empty", () => {
    hookState.streamedText = "";
    hookState.dataPartFrames = [];

    render(
      <AgenticRunPanel
        runId="run-ext-data-part-empty"
        initialStatus="completed"
        initialError={null}
        initialMessages={[]}
        agentPackageName="@a2a-dev-localhost-10001/hello-world"
        agUiEnabled={true}
      />,
    );

    expect(screen.queryByText("Structured output")).toBeNull();
  });
});
