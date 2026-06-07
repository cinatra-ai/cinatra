// @vitest-environment jsdom
/**
 * Unit tests for ListPickerRenderer.
 *
 * Locks the renderer contract:
 *   - Mount renders heading-equivalent label + "Create new list" CTA + search input.
 *   - Lists from fetchAvailableLists() render as clickable cards with name +
 *     member count + memberType badge.
 *   - Search input filters by name (case-insensitive substring).
 *   - Clicking a card calls onChange with the canonical
 *     { scope: "list", listId, listName, memberCount } shape.
 *   - Empty results render the EmptyState copy.
 *   - mixed-memberType lists render with the SAME affordances as
 *     contact-typed lists and produce the same onChange payload shape
 *     so the picker accepts both `contact` and `mixed` rows.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

// Mock the actions module BEFORE importing the renderer so the mocked
// fetchAvailableLists is the one the renderer calls.
vi.mock("../list-picker-actions", () => ({
  fetchAvailableLists: vi.fn(),
}));

import { ListPickerRenderer } from "../list-picker-renderer";
import * as actions from "../list-picker-actions";
import type { FieldRendererProps } from "../field-renderer-registry";

// Minimal-required props every FieldRendererProps consumer expects. The
// picker reads `value`, `onChange`, `disabled`, `required`, `error`, `label`,
// `description`; everything else is unused but must satisfy the type.
function makeProps(
  overrides: Partial<FieldRendererProps> = {},
): FieldRendererProps {
  return {
    fieldName: "list",
    schema: { "x-renderer": "list-picker" } as Record<string, unknown>,
    value: undefined,
    onChange: () => {},
    disabled: false,
    required: true,
    error: null,
    label: "Pick a list",
    description: undefined,
    context: { connectedApps: [] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("ListPickerRenderer", () => {
  it("renders label + search input on mount (no create-new-list link; retired)", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    // The "Create new list" affordance was retired with the lists_* MCP
    // family; list creation flows through the list-curator-agent CTA below.
    expect(
      screen.queryByRole("link", { name: /create new list/i }),
    ).toBeNull();
    expect(screen.getByPlaceholderText(/search lists/i)).toBeTruthy();
  });

  it("renders 'Build a list with AI' CTA deep-linking to list-curator-agent", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    const cta = screen.getByTestId("build-list-with-ai-cta");
    expect(cta).toBeTruthy();
    expect(cta.getAttribute("href")).toBe(
      "/agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker",
    );
    expect(cta.textContent?.toLowerCase()).toContain("build a list with ai");
  });

  it("renders all returned lists with both contact and mixed member types", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([
      {
        id: "l1",
        name: "Beta Prospects",
        memberCount: 42,
        lastUpdated: null,
        memberType: "contact",
      },
      {
        id: "l2",
        name: "Q2 Targets",
        memberCount: 7,
        lastUpdated: null,
        memberType: "mixed",
      },
      {
        id: "l3",
        name: "Hot Leads",
        memberCount: 18,
        lastUpdated: null,
        memberType: "contact",
      },
    ]);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => screen.getByText("Beta Prospects"));
    expect(screen.getByText("Beta Prospects")).toBeTruthy();
    expect(screen.getByText("Q2 Targets")).toBeTruthy();
    expect(screen.getByText("Hot Leads")).toBeTruthy();
  });

  it("filters cards by search substring (case-insensitive)", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([
      {
        id: "l1",
        name: "Beta Prospects",
        memberCount: 42,
        lastUpdated: null,
        memberType: "contact",
      },
      {
        id: "l2",
        name: "Hot Leads",
        memberCount: 18,
        lastUpdated: null,
        memberType: "contact",
      },
    ]);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => screen.getByText("Beta Prospects"));
    fireEvent.change(screen.getByPlaceholderText(/search lists/i), {
      target: { value: "HOT" },
    });

    expect(screen.queryByText("Beta Prospects")).toBeNull();
    expect(screen.getByText("Hot Leads")).toBeTruthy();
  });

  it("invokes onChange with the canonical value shape when a card is clicked", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([
      {
        id: "l1",
        name: "Beta Prospects",
        memberCount: 42,
        lastUpdated: null,
        memberType: "contact",
      },
    ]);
    render(<ListPickerRenderer {...makeProps({ onChange })} />);

    await waitFor(() => screen.getByText("Beta Prospects"));
    fireEvent.click(screen.getByText("Beta Prospects"));

    expect(onChange).toHaveBeenCalledWith({
      scope: "list",
      listId: "l1",
      listName: "Beta Prospects",
      memberCount: 42,
    });
  });

  it("renders empty state when no lists exist", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() =>
      expect(screen.getByText(/no lists yet/i)).toBeTruthy(),
    );
  });

  it("renders mixed-memberType lists with the same affordances and onChange payload shape as contact-typed lists", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([
      {
        id: "lm",
        name: "Mixed Sample",
        memberCount: 5,
        lastUpdated: null,
        memberType: "mixed",
      },
    ]);
    render(<ListPickerRenderer {...makeProps({ onChange })} />);

    await waitFor(() => screen.getByText("Mixed Sample"));

    // Badge reflects memberType=mixed — match the lowercase badge text
    // exactly (the list name "Mixed Sample" also contains "mixed" so a
    // case-insensitive regex would match multiple nodes).
    expect(screen.getByText("mixed")).toBeTruthy();

    fireEvent.click(screen.getByText("Mixed Sample"));
    expect(onChange).toHaveBeenCalledWith({
      scope: "list",
      listId: "lm",
      listName: "Mixed Sample",
      memberCount: 5,
    });
  });
});
