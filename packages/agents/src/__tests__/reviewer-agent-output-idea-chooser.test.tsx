// @vitest-environment jsdom
/**
 * #839 coverage for the idea-selection chooser branch of
 * ReviewerAgentOutputRenderer.
 *
 * Asserts:
 *   - When schema.required=[selectedIdeaJson] (string) AND value.ideas is a
 *     non-empty array, a radio-per-idea chooser renders and commits ideas[0]
 *     on mount as {selectedIdeaJson, userResponse} = JSON.stringify(idea)
 *     — NEVER the reviewer placeholder text.
 *   - Changing the pick re-commits the newly chosen idea.
 *   - Pure-approval reviewer gates (no selectedIdeaJson schema) and the
 *     schema-only / no-ideas case do NOT render the chooser (untouched paths).
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { ReviewerAgentOutputRenderer } from "../reviewer-agent-output-renderer";
import type { FieldRendererContext } from "../field-renderer-registry";

const CTX: FieldRendererContext = { connectedApps: [] };
const IDEAS = [
  { title: "Idea Alpha", summary: "First angle" },
  { title: "Idea Beta", summary: "Second angle" },
];
const SELECT_SCHEMA = {
  type: "object",
  "x-renderer": "@cinatra-ai/reviewer-agent:output",
  properties: { selectedIdeaJson: { type: "string" } },
  required: ["selectedIdeaJson"],
};
const PLACEHOLDER = "(reviewer agent — approve to continue)";

function renderReviewer(value: unknown, schema: unknown = SELECT_SCHEMA) {
  const onChange = vi.fn();
  return {
    onChange,
    ...render(
      <ReviewerAgentOutputRenderer
        fieldName="selectedIdeaJson"
        schema={schema as Record<string, unknown>}
        value={value}
        onChange={onChange}
        context={CTX}
      />,
    ),
  };
}

afterEach(cleanup);

describe("ReviewerAgentOutputRenderer — #839 idea chooser", () => {
  it("renders a radio per idea and commits ideas[0] (not the placeholder) on mount", () => {
    const { onChange } = renderReviewer({
      ideas: IDEAS,
      contentType: "text",
      contentBundle: { text: PLACEHOLDER, url: "" },
      summary: PLACEHOLDER,
    });
    expect(screen.getByText("Idea Alpha")).toBeTruthy();
    expect(screen.getByText("Idea Beta")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(onChange).toHaveBeenCalledWith({
      selectedIdeaJson: JSON.stringify(IDEAS[0]),
      userResponse: JSON.stringify(IDEAS[0]),
    });
    // The placeholder userResponse auto-commit is SUPPRESSED on this path.
    const responses = onChange.mock.calls.map(
      (c) => (c[0] as { userResponse?: unknown }).userResponse,
    );
    expect(responses).not.toContain(PLACEHOLDER);
  });

  it("selecting the second idea commits ideas[1]", () => {
    const { onChange } = renderReviewer({ ideas: IDEAS });
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    expect(onChange).toHaveBeenLastCalledWith({
      selectedIdeaJson: JSON.stringify(IDEAS[1]),
      userResponse: JSON.stringify(IDEAS[1]),
    });
  });

  it("does NOT render the chooser for a pure-approval reviewer gate (no selectedIdeaJson schema)", () => {
    const { onChange } = renderReviewer(
      { ideas: IDEAS, contentType: "text", contentBundle: { text: "approve me" } },
      { type: "object", properties: {}, required: [] },
    );
    expect(screen.queryByText("Select one blog idea to draft.")).toBeNull();
    const committed = onChange.mock.calls.map(
      (c) => c[0] as { selectedIdeaJson?: unknown },
    );
    expect(committed.every((c) => c.selectedIdeaJson === undefined)).toBe(true);
  });

  it("does NOT render the chooser when the schema requires selectedIdeaJson but no ideas are present", () => {
    renderReviewer({ contentType: "text", contentBundle: { text: "x" } });
    expect(screen.queryByText("Select one blog idea to draft.")).toBeNull();
  });
});
