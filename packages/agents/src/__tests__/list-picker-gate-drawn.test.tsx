// @vitest-environment jsdom
/**
 * THE GATE THAT LISTS, DRAWN (cinatra#3358 — the second fix leg).
 *
 * The account-scope step is the ratified "gate that lists" (Agent run & review
 * §I.1) and it was graded against that drawing on a real run. This suite pins
 * the readings the grade found missing, each one a sentence of the checklist the
 * grade was written from:
 *
 *   "the account-scope gate opens on its question heading over its state line;
 *    the Continue control is disabled while nothing is picked and nothing
 *    pickable; the make-one road sits under the rows with the primary Continue
 *    right-aligned over the hairline control floor; the zero-content reading is
 *    the drawn empty state (dashed circle icon, 14px headline over a 12px
 *    helper, the primary action outside the panel)"
 *
 *   "no undrawn full-width cross-run banner — the return to the waiting run is
 *    placed where section I places the run's actions; no search field on the
 *    gate-that-lists unless the drawing gives one; no info icon on rail entries;
 *    the refusal toast sits on the drawn opaque popover ground"
 *
 *   "when a child run completes with a listId, the parked run's account-scope
 *    step offers that list"
 *
 * The Continue control and the rail live one level up, on the run's stepper
 * panel; they are pinned in
 * `orchestrator-stepper-list-picker-gate.test.tsx`. What is pinned HERE is the
 * step's own page.
 *
 *   pnpm vitest run packages/agents/src/__tests__/list-picker-gate-drawn.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("../list-picker-actions", () => ({
  fetchAvailableLists: vi.fn(),
}));

import { ListPickerRenderer } from "../list-picker-renderer";
import * as actions from "../list-picker-actions";
import type { FieldRendererProps } from "../field-renderer-registry";
import { COMPLETION_PRODUCED_PARAM } from "@/lib/agent-url";

function makeProps(
  overrides: Partial<FieldRendererProps> = {},
): FieldRendererProps {
  return {
    fieldName: "list",
    schema: { "x-renderer": "list-picker" } as Record<string, unknown>,
    value: undefined,
    onChange: () => {},
    disabled: false,
    required: false,
    error: null,
    label: "Which list should this run send to?",
    description: undefined,
    context: { connectedApps: [], runId: "run-parked" },
    // THE MAKE-ONE ROAD'S DESTINATION IS DECLARED BY THE BINDING, never named
    // by the host tree (the core/extension border). The binding that raises
    // this gate on the boot these rows were measured on declares the list
    // builder below, so the drawing tests below see the road the reader sees.
    bindingParams: { listBuilderPackage: "@cinatra-ai/list-curator-agent" },
    ...overrides,
  };
}

const ROWS = [
  {
    id: "lst_1",
    name: "Marketing directors",
    memberCount: 5,
    lastUpdated: null,
    memberType: "contact" as const,
  },
  {
    id: "lst_2",
    name: "Q2 targets",
    memberCount: 11,
    lastUpdated: null,
    memberType: "contact" as const,
  },
];

/** Put the parked run's own address on the page, the way the return lands it. */
function addressCarrying(search: string) {
  window.history.replaceState({}, "", `/agents/v/p/run-parked${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  addressCarrying("");
});

afterEach(() => {
  cleanup();
});

describe('"the account-scope gate opens on its question heading over its state line"', () => {
  it("draws the step's question as a heading, with the state line beneath it", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(ROWS);
    const { container } = render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => screen.getByText("Marketing directors"));

    const question = screen.getByTestId("list-picker-question");
    const stateLine = screen.getByTestId("list-picker-state-line");
    expect(question.tagName.toLowerCase()).toBe("h3");
    expect(question.textContent).toContain("Which list should this run send to?");
    // "Awaiting your pick" is the drawing's own state line for a gate that has
    // rows and no pick yet.
    expect(stateLine.textContent).toBe("Awaiting your pick");
    // OVER it, not beside it: the heading precedes the line in document order.
    expect(
      question.compareDocumentPosition(stateLine) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector("h3")).toBe(question);
  });

  it("says what the step's state is when there is nothing to pick", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() =>
      expect(screen.getByTestId("list-picker-state-line").textContent).toBe(
        "Nothing to pick",
      ),
    );
  });
});

describe('"no search field on the gate-that-lists unless the drawing gives one"', () => {
  it("draws no search field — §I.1 gives the gate rows, a make-one road and a Continue, and nothing else", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(ROWS);
    const { container } = render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => screen.getByText("Marketing directors"));

    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
  });
});

describe('"the make-one road sits under the rows"', () => {
  it("places the make-one road after the last row, not above the list", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(ROWS);
    render(<ListPickerRenderer {...makeProps()} />);

    const lastRow = await screen.findByText("Q2 targets");
    const road = screen.getByTestId("build-list-with-ai-cta");
    expect(
      lastRow.compareDocumentPosition(road) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('"the zero-content reading is the drawn empty state"', () => {
  it("draws the Empty pattern — dashed circle icon, 14px headline over a 12px helper", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const { container } = render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => expect(screen.getByText(/no lists yet/i)).toBeTruthy());

    const empty = container.querySelector('[data-slot="empty"]');
    expect(empty, "the zero-content reading is not the drawn Empty pattern").not.toBeNull();

    // The dashed circle the section draws.
    const media = container.querySelector('[data-slot="empty-icon"]');
    expect(media).not.toBeNull();
    expect(media!.getAttribute("data-variant")).toBe("icon");
    expect(media!.className).toContain("border-dashed");
    expect(media!.className).toContain("rounded-full");

    // The two-step scale: a 14px headline (`text-sm`) over a 12px helper
    // (`text-xs`). A plain card carrying one grey sentence is the "just empty
    // text" the section forbids.
    const title = container.querySelector('[data-slot="empty-title"]');
    const helper = container.querySelector('[data-slot="empty-description"]');
    expect(title).not.toBeNull();
    expect(helper).not.toBeNull();
    expect(title!.className).toContain("text-sm");
    expect(helper!.className).toContain("text-xs");
  });

  it("keeps the primary action OUTSIDE the panel", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const { container } = render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => expect(screen.getByText(/no lists yet/i)).toBeTruthy());

    const empty = container.querySelector('[data-slot="empty"]')!;
    const road = screen.getByTestId("build-list-with-ai-cta");
    expect(empty.contains(road)).toBe(false);
    // And it is still offered: an empty reading with no road would leave the
    // reader nowhere to go.
    expect(road.getAttribute("href")).toContain("onCompleteRunId=run-parked");
  });
});

describe('"when a child run completes with a listId, the parked run\'s account-scope step offers that list"', () => {
  it("offers the produced list when the return lands it on the parked run's address", async () => {
    addressCarrying(`?onComplete=list-picker&${COMPLETION_PRODUCED_PARAM}=lst_2`);
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(ROWS);
    const onChange = vi.fn();
    render(<ListPickerRenderer {...makeProps({ onChange })} />);

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        scope: "list",
        listId: "lst_2",
        listName: "Q2 targets",
        memberCount: 11,
      }),
    );
    const offeredRow = screen.getByText("Q2 targets").closest("[aria-pressed]");
    expect(offeredRow!.getAttribute("aria-pressed")).toBe("true");
  });

  it("offers nothing when the completion named no list — the step opens on its honest empty reading", async () => {
    addressCarrying("?onComplete=list-picker");
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const onChange = vi.fn();
    render(<ListPickerRenderer {...makeProps({ onChange })} />);

    await waitFor(() => expect(screen.getByText(/no lists yet/i)).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never overrides an answer the step already holds", async () => {
    addressCarrying(`?onComplete=list-picker&${COMPLETION_PRODUCED_PARAM}=lst_2`);
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(ROWS);
    const onChange = vi.fn();
    render(
      <ListPickerRenderer
        {...makeProps({
          onChange,
          value: {
            scope: "list",
            listId: "lst_1",
            listName: "Marketing directors",
            memberCount: 5,
          },
        })}
      />,
    );

    await waitFor(() => screen.getByText("Marketing directors"));
    expect(onChange).not.toHaveBeenCalled();
    const held = screen.getByText("Marketing directors").closest("[aria-pressed]");
    expect(held!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the offer defers to an answer that arrives AFTER mount (convergence round, cinatra#3448)", () => {
  it("never overwrites an answer handed down while the rows were still loading", async () => {
    // THE HOLE THE ROUND FOUND. The guard read the answer as it stood AT MOUNT
    // and, after that, only what this reader had pressed. A step re-hydrated
    // with its stored answer while the rows were still in flight was therefore
    // invisible to the offer, and the offer overwrote it the moment the rows
    // landed — the one case where an offer can destroy a reader's own work.
    addressCarrying(`?onComplete=list-picker&${COMPLETION_PRODUCED_PARAM}=lst_2`);
    let releaseRows: (rows: typeof ROWS) => void = () => {};
    vi.mocked(actions.fetchAvailableLists).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseRows = resolve;
      }) as ReturnType<typeof actions.fetchAvailableLists>,
    );
    const onChange = vi.fn();
    const { rerender } = render(
      <ListPickerRenderer {...makeProps({ onChange })} />,
    );

    // The answer arrives through a render, with the rows still in flight.
    rerender(
      <ListPickerRenderer
        {...makeProps({
          onChange,
          value: {
            scope: "list",
            listId: "lst_1",
            listName: "Marketing directors",
            memberCount: 5,
          },
        })}
      />,
    );

    await act(async () => {
      releaseRows(ROWS);
    });
    await waitFor(() => screen.getByText("Marketing directors"));

    expect(
      onChange,
      "the offer overwrote an answer the step already held",
    ).not.toHaveBeenCalled();
    const held = screen.getByText("Marketing directors").closest("[aria-pressed]");
    expect(held!.getAttribute("aria-pressed")).toBe("true");
    const offered = screen.getByText("Q2 targets").closest("[aria-pressed]");
    expect(offered!.getAttribute("aria-pressed")).toBe("false");
  });
});
