// @vitest-environment jsdom
/**
 * The failed run-progress card draws the drawn floor, not the producer's error.
 *
 * The idea step's card in the conversation read "Agentic Run Progress / failed / Error / artifact
 * materialization failed - ..." with the materializer's own sentence in a
 * <pre>, plus a Retry control. No section of either governing drawing gives
 * that reading. The run-surface drawing fixes the floor for a target that did
 * not resolve as "a sanitized, telemetry-safe one-line diagnostic (package -
 * slot - reason, never a raw error or manifest value)", drawn as ONE muted mono
 * line and, where there is nothing left to show, "the diagnostic alone".
 *
 * This suite pins that reading at the real seam: the shared AgenticRunPanel
 * that both the conversation card and the run page mount.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel.materialization-floor.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  const named = new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["AlertCircle", "Loader2", "CheckCircle2", "XCircle", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
  return named;
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

vi.mock("../run-completion-affordances", () => ({
  StartNewRunButton: ({ agentId }: { agentId: string }) => (
    <Button type="button" data-testid="start-new-run-stub">
      start new run for {agentId}
    </Button>
  ),
  RunCompletionCard: ({ runId }: { runId: string }) => (
    <div data-testid="run-completion-card-stub">completion card for {runId}</div>
  ),
}));

vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// The exact sentence a failed idea run persisted onto the card.
const RAW_MATERIALIZATION_ERROR =
  "artifact materialization failed — the run declared artifact output(s) it did not produce " +
  "(1 of 1 failed): ideaBatch [@cinatra-ai/blog-idea-generator-agent]: " +
  'contentFrom output "ideaBatchDocument" did not resolve to a string';

function failedProps(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-3033",
    initialStatus: "failed",
    initialError: RAW_MATERIALIZATION_ERROR,
    initialMessages: [],
    agUiEnabled: false as boolean | null,
    inputParams: {},
    initialStreamedText: "",
    ...overrides,
  };
}

describe("AgenticRunPanel - the failed card's floor (issue 3033)", () => {
  it("draws the sanitized package / slot / reason line", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...failedProps()} />);

    const floor = screen.getByTestId("run-failure-floor");
    expect(floor.textContent).toBe(
      "review target unavailable — package “@cinatra-ai/blog-idea-generator-agent”, " +
        "slot “ideaBatch”, reason “output-not-produced”",
    );
  });

  it("keeps the producer's own sentence off the card entirely", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { container } = render(<AgenticRunPanel {...failedProps()} />);

    const text = container.textContent ?? "";
    expect(text).not.toContain("did not resolve to a string");
    expect(text).not.toContain("artifact materialization failed");
    expect(text).not.toContain("did not produce");
  });

  it("draws the diagnostic alone - no Retry and no Start new run beside it", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...failedProps({ agentId: "cinatra-ai/blog-idea-generator-agent" })}
      />,
    );

    expect(screen.queryByTestId("run-failure-floor")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
    expect(screen.queryByTestId("start-new-run-stub")).toBeNull();
  });

  it("announces the floor as a status line, the way the drawing draws it", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...failedProps()} />);

    expect(screen.getByTestId("run-failure-floor").getAttribute("role")).toBe("status");
  });

  // The drawing draws a ONE-LINE diagnostic per target. Two failed outputs are
  // two diagnostics, so they must read as two lines: a newline inside one text
  // node collapses to a space in HTML and runs them together into a single
  // paragraph, which is a reading the drawing does not give.
  it("draws one line per failed target when more than one output failed", async () => {
    const twoTargets =
      "review target unavailable — package “@acme/writer”, slot “draft”, " +
      "reason “output-not-produced”\n" +
      "review target unavailable — package “@acme/writer”, slot “summary”, " +
      "reason “binding-invalid”";

    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...failedProps({ initialError: twoTargets })} />);

    const floor = screen.getByTestId("run-failure-floor");
    const lines = Array.from(floor.children).map((el) => el.textContent);
    expect(lines).toEqual([
      "review target unavailable — package “@acme/writer”, slot “draft”, reason “output-not-produced”",
      "review target unavailable — package “@acme/writer”, slot “summary”, reason “binding-invalid”",
    ]);
    // and never the two run together as one paragraph
    expect(floor.textContent).not.toContain("”review target unavailable");
    expect(floor.textContent).not.toContain("” review target unavailable");
  });

  it("leaves every other failure class reading exactly as it did", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...failedProps({
          agentId: "cinatra-ai/blog-idea-generator-agent",
          initialError: "WayFlow task failed",
        })}
      />,
    );

    expect(screen.queryByTestId("run-failure-floor")).toBeNull();
    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeNull();
  });
});
