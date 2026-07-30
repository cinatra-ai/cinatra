// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// AG-UI interactive layer — render tests (cinatra#1311).
// Proves the presentational layer draws every element the render-parity
// checklist names for the interactive row, driven by the reduced view model.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";
import {
  ConversationTurn,
  InteractiveParts,
  ToolCallChip,
} from "../ag-ui-interactive";
import { reduceAgUiEvents, type ConversationViewState } from "../ag-ui-reducer";
import {
  AGENT_RUN,
  ERROR_MIDSTREAM,
  HITL,
  TOOL_THEN_TEXT,
  WITH_CITATIONS,
  interrupt,
  runStarted,
  textDelta,
  textStart,
  toolStart,
} from "./ag-ui-fixtures";

const plainText = (t: string) => <span data-text>{t}</span>;

// @testing-library/react auto-cleanup is only registered under vitest globals;
// this package's config runs without globals, so unmount between tests.
afterEach(() => cleanup());

describe("ToolCallChip", () => {
  it("labels a completed chip from resultLabel", () => {
    render(
      <ToolCallChip toolCall={{ id: "t1", name: "gmail.messages.list", status: "completed", resultLabel: "Messages · List" }} />,
    );
    expect(screen.getByText("Messages · List")).toBeTruthy();
  });

  it("derives a running chip label from the tool name when no resultLabel", () => {
    render(<ToolCallChip toolCall={{ id: "t1", name: "web_search", status: "running" }} />);
    expect(screen.getByText("Web Search")).toBeTruthy();
  });
});

describe("ConversationTurn — tool round", () => {
  it("renders text + a thinking group with the tool chip", () => {
    const state = reduceAgUiEvents(TOOL_THEN_TEXT);
    render(<ConversationTurn state={state} renderers={{ renderText: plainText }} />);
    // The tool round splits the answer into two ordered text parts.
    expect(screen.getByText("Let me check.")).toBeTruthy();
    expect(screen.getByText(/You have 3 messages\./)).toBeTruthy();
    expect(screen.getByText("Messages · List")).toBeTruthy();
    expect(screen.getByText(/Used 1 tool/)).toBeTruthy();
  });
});

describe("ConversationTurn — citations", () => {
  it("renders a Sources block with each citation host", () => {
    const state = reduceAgUiEvents(WITH_CITATIONS);
    render(<ConversationTurn state={state} renderers={{ renderText: plainText }} />);
    expect(screen.getByText("Sources")).toBeTruthy();
    expect(screen.getByText(/a.example/)).toBeTruthy();
    expect(screen.getByText(/b.example/)).toBeTruthy();
  });
});

describe("ConversationTurn — inline agent-run card mount", () => {
  it("invokes the host renderRunCard with the pinned runId", () => {
    const state = reduceAgUiEvents(AGENT_RUN);
    const seen: string[] = [];
    render(
      <ConversationTurn
        state={state}
        renderers={{
          renderText: plainText,
          renderRunCard: (runId) => {
            seen.push(runId);
            return <div data-testid="run-card">{runId}</div>;
          },
        }}
      />,
    );
    expect(seen).toEqual(["agent-run-99"]);
    expect(screen.getByTestId("run-card").textContent).toBe("agent-run-99");
  });
});

describe("ConversationTurn — HITL interrupt", () => {
  it("renders the default read-only fallback when no host form is injected", () => {
    let state = reduceAgUiEvents([runStarted()]);
    state = { ...state, interrupt: reduceAgUiEvents([runStarted(), interrupt({ fieldName: "confirm" })]).interrupt } as ConversationViewState;
    render(<ConversationTurn state={state} renderers={{ renderText: plainText }} />);
    expect(screen.getByText("Approval needed")).toBeTruthy();
    expect(screen.getByText("@cinatra-ai/email-agent:send-confirmation")).toBeTruthy();
  });

  it("mounts the host-injected interrupt form when provided", () => {
    const state = reduceAgUiEvents([runStarted(), interrupt()]);
    render(
      <ConversationTurn
        state={state}
        renderers={{
          renderText: plainText,
          renderInterrupt: (i) => <div data-testid="hitl-form">{i.reviewTaskId}</div>,
        }}
      />,
    );
    expect(screen.getByTestId("hitl-form").textContent).toBe("rt-1");
  });

  it("full HITL stream leaves no interrupt UI once resumed+finished", () => {
    const state = reduceAgUiEvents(HITL);
    render(<ConversationTurn state={state} renderers={{ renderText: plainText }} />);
    expect(screen.queryByText("Approval needed")).toBeNull();
    expect(screen.getByText("Done.")).toBeTruthy();
  });
});

describe("ConversationTurn — RUN_ERROR banner", () => {
  it("renders the error banner and suppresses the live status", () => {
    const state = reduceAgUiEvents(ERROR_MIDSTREAM);
    render(<ConversationTurn state={state} renderers={{ renderText: plainText }} />);
    expect(screen.getByRole("alert").textContent).toContain("The model call failed.");
    expect(screen.queryByRole("status")).toBeNull();
  });

  // cinatra#2094 F10 — the RENDERED banner must carry the provider name.
  // The exact-binding message is long-ish (264 chars); the normalizer's
  // raw-HTTP-body simplification kicks in above 300, so this also pins that the
  // real message is NOT swallowed by that guard. If the wording ever grows past
  // the cap, this test fails instead of the operator silently losing the name.
  it("F10: renders the provider-NAMING exact-binding failure verbatim", () => {
    const reason =
      'The configured default LLM provider "anthropic" is not available (its connector is not ' +
      "installed/active, or its credentials are missing or invalid). Fix that provider's " +
      "configuration, choose a different default provider, or enable ordered failover in LLM settings.";
    const state = reduceAgUiEvents([
      runStarted(),
      { type: "RUN_ERROR", threadId: "th1", runId: "r1", message: reason, timestamp: 1 },
    ]);
    render(<ConversationTurn state={state} renderers={{ renderText: plainText }} />);
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toContain("anthropic");
    expect(text).toBe(reason);
    expect(text).not.toContain("The request failed");
    expect(text).not.toContain("Something went wrong");
  });
});

describe("ConversationTurn — live status", () => {
  it("shows the live status line while running", () => {
    const state = reduceAgUiEvents([runStarted(), toolStart("t1", "web_search")]);
    render(<ConversationTurn state={state} renderers={{ renderText: plainText }} />);
    expect(screen.getByRole("status").textContent).toContain("Searching the web");
  });
});

describe("InteractiveParts — streaming/partial trimming", () => {
  it("trims an incomplete trailing embed off the last text part while streaming", () => {
    const state = reduceAgUiEvents([
      runStarted(),
      textStart("m1"),
      textDelta("m1", "Chart: "),
      textDelta("m1", '[chart:{"type":"bar"'),
    ]);
    render(<InteractiveParts parts={state.message.parts} streaming renderers={{ renderText: plainText }} />);
    // The incomplete "[chart:{...}" tail is trimmed; only "Chart:" remains.
    expect(screen.getByText("Chart:")).toBeTruthy();
    expect(screen.queryByText(/\[chart:/)).toBeNull();
  });

  it("does not trim when not streaming", () => {
    const parts: AgUiEvent[] = []; // unused — direct parts below
    void parts;
    const state = reduceAgUiEvents([
      runStarted(),
      textStart("m1"),
      textDelta("m1", "Chart: "),
      textDelta("m1", '[chart:{"type":"bar"'),
    ]);
    render(<InteractiveParts parts={state.message.parts} renderers={{ renderText: plainText }} />);
    expect(screen.getByText(/\[chart:\{"type":"bar"/)).toBeTruthy();
  });
});
