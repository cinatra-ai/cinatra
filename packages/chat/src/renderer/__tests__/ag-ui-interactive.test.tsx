// @vitest-environment jsdom
// AG-UI interactive layer — render + selector tests (cinatra#1311).

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);

import { agUiReduceAll } from "../ag-ui-reducer";
import {
  AgUiMessageView,
  CitationList,
  HitlInterruptForm,
  RunErrorBanner,
  ThinkingGroup,
  ToolCallChip,
  resolveInlineRunMounts,
  schemaFields,
} from "../interactive";
import { AGENT_RUN_PIN, CITATIONS, HAPPY_PATH, HITL } from "./ag-ui-fixtures";
import type { UiToolCall } from "../../types";

describe("ToolCallChip", () => {
  it("shows a progress label while running (derived from the name)", () => {
    const tc: UiToolCall = { id: "a", name: "web_search", status: "running" };
    render(<ToolCallChip toolCall={tc} />);
    expect(screen.getByText("Searching the web")).toBeTruthy();
  });

  it("shows the result label once completed", () => {
    const tc: UiToolCall = {
      id: "a",
      name: "campaigns.list",
      status: "completed",
      resultLabel: "Campaigns · List",
    };
    render(<ToolCallChip toolCall={tc} />);
    expect(screen.getByText("Campaigns · List")).toBeTruthy();
  });
});

describe("ThinkingGroup", () => {
  it("renders nothing for an empty group", () => {
    const { container } = render(
      <ThinkingGroup group={{ id: "main", toolCalls: [] }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders thinking seconds and chips", () => {
    render(
      <ThinkingGroup
        group={{
          id: "main",
          thinkingSeconds: 4,
          toolCalls: [{ id: "t", name: "web_search", status: "completed" }],
        }}
      />,
    );
    expect(screen.getByText("Thought for 4s")).toBeTruthy();
  });
});

describe("CitationList", () => {
  it("renders nothing when empty", () => {
    const { container } = render(<CitationList citations={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders merged citations from the reducer", () => {
    const s = agUiReduceAll(CITATIONS);
    render(<CitationList citations={s.message.citations ?? []} />);
    expect(screen.getByText("Sources")).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });
});

describe("RunErrorBanner", () => {
  it("renders nothing without an error", () => {
    const { container } = render(<RunErrorBanner error={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the error as an alert", () => {
    render(<RunErrorBanner error="upstream exploded" />);
    expect(screen.getByRole("alert").textContent).toBe("upstream exploded");
  });
});

describe("HITL — schemaFields + form", () => {
  it("extracts primitive fields with required flags", () => {
    const s = agUiReduceAll(HITL);
    const fields = schemaFields(s.interrupt!.schema);
    expect(fields).toEqual([
      { name: "recipient", type: "string", title: "Recipient", required: true },
      { name: "cc", type: "string", title: "CC", required: false },
    ]);
  });

  it("renders inputs pre-populated from interrupt values", () => {
    const s = agUiReduceAll(HITL);
    render(<HitlInterruptForm interrupt={s.interrupt!} onSubmit={() => {}} />);
    expect((screen.getByDisplayValue("a@example.com") as HTMLInputElement).name).toBe(
      "recipient",
    );
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
  });

  it("shows a bare Approve button for a zero-field interrupt", () => {
    render(
      <HitlInterruptForm
        interrupt={{
          runId: "r",
          threadId: "t",
          xRenderer: "x",
          reviewTaskId: "rt",
          schema: { type: "object", properties: {} },
          values: {},
        }}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });
});

describe("resolveInlineRunMounts", () => {
  it("returns the pinned agent-run mount", () => {
    const s = agUiReduceAll(AGENT_RUN_PIN);
    expect(resolveInlineRunMounts(s.message)).toEqual([
      { toolCallId: "tc-run", runId: "child-run-9" },
    ]);
  });

  it("returns nothing when no run is pinned", () => {
    const s = agUiReduceAll(HAPPY_PATH);
    expect(resolveInlineRunMounts(s.message)).toEqual([]);
  });
});

describe("AgUiMessageView", () => {
  it("renders parts in order, delegating text and run cards", () => {
    const s = agUiReduceAll(AGENT_RUN_PIN);
    render(
      <AgUiMessageView
        message={s.message}
        interrupt={s.interrupt}
        renderText={(t) => <span data-text>{t}</span>}
        renderRunCard={(m) => <span data-card>{m.runId}</span>}
      />,
    );
    // The pinned run card mounts.
    expect(screen.getByText("child-run-9")).toBeTruthy();
  });

  it("renders the HITL form when an interrupt is open", () => {
    const s = agUiReduceAll(HITL);
    render(
      <AgUiMessageView
        message={s.message}
        interrupt={s.interrupt}
        renderText={(t) => <span>{t}</span>}
      />,
    );
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
  });
});