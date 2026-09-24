// @vitest-environment jsdom
/**
 * THE GATE THAT LISTS, DRAWN (cinatra#3358 — the second fix leg; cinatra#3562 —
 * the account scope's own ruling).
 *
 * The account-scope step is the ratified "gate that lists" (Agent run & review
 * §I.1) and it was graded against that drawing on a real run. This suite pins
 * the readings the grade found missing, each one a sentence of the checklist the
 * grade was written from:
 *
 *   "the account-scope gate opens on its question heading over its state line;
 *    the Continue control is disabled while nothing is picked and nothing
 *    pickable; the zero-content reading is the state line and the sentence —
 *    never just empty text — with no dashed rectangle and no dashed circle icon"
 *
 *   "no search field on the gate-that-lists unless the drawing gives one; no
 *    info icon on rail entries; the refusal toast sits on the drawn opaque
 *    popover ground"
 *
 * AND THE ACCOUNT SCOPE'S OWN RULING (cinatra#3562), which this leg builds:
 *
 *   "The account scope lists all respective views/lists available inside a
 *    connected Twenty CRM. The user must select at least one view/list and can
 *    select multiple ones. If no views/lists are available in Twenty CRM, a
 *    message asks the user to create one in Twenty CRM."
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
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("../list-picker-actions", () => ({
  fetchAvailableLists: vi.fn(),
}));

import { ListPickerRenderer } from "../list-picker-renderer";
import * as actions from "../list-picker-actions";
import type { FieldRendererProps } from "../field-renderer-registry";

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
    ...overrides,
  };
}

/** The question the heading ASKS, with the required marker the h3 appends after
 *  it removed: the asterisk belongs to the field, not to the question, so a
 *  required step must not change what the question reads. */
function questionAsked(): string {
  return (screen.getByTestId("list-picker-question").textContent ?? "")
    .replace(/\s*\*\s*$/, "")
    .trim();
}

/** Is this row among the chosen? Read off `data-selected`, the anchor the row
 *  has always carried and whose meaning is unchanged — this row is among the
 *  chosen. The row's ARIA moved with the ruling (a row that can be ticked
 *  beside others is `role="checkbox"` with `aria-checked`, not a pressed
 *  toggle button), and the reading below is the same written intent read off
 *  the anchor that did not move. */
function chosen(name: string): string | null {
  return (
    screen.getByText(name).closest("[data-selected]")?.getAttribute("data-selected") ??
    null
  );
}

const ROWS = [
  {
    id: "lst_1",
    name: "Marketing directors",
    memberCount: null,
    lastUpdated: null,
    memberType: "contact" as const,
  },
  {
    id: "lst_2",
    name: "Q2 targets",
    memberCount: null,
    lastUpdated: null,
    memberType: "contact" as const,
  },
];

/** Put the parked run's own address on the page. */
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

  // THE STEP THAT NAMES NO QUESTION (the second proof round). The account-scope
  // step reaches this renderer with NO resolved label — its schema titles the
  // FIELD, not the reader's question, and the surface that mounts the gate
  // passes no label at all — so a heading rendered from that label alone opened
  // the gate on an EMPTY h3 over its state line. §I.1 draws the gate opening on
  // its question in every reading, the zero-content one included.
  it("opens on the drawn question when the step names none", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const { container } = render(
      <ListPickerRenderer {...makeProps({ label: undefined })} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("list-picker-state-line").textContent).toBe(
        "Nothing to pick",
      ),
    );

    // Never an EMPTY heading (cinatra#3358): a step that declares no question
    // and carries no label draws no heading at all, and no words of the host's
    // own — the state line stands.
    expect(screen.queryByTestId("list-picker-question")).toBeNull();
    expect(container.querySelector("h3")).toBeNull();
    expect(screen.getByTestId("list-picker-state-line")).toBeTruthy();
  });

  // A REQUIRED step reads the same way: the h3 appends the field's asterisk
  // after the question, and the question itself still has to ask something.
  it("reads a blank label as no question at all", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(ROWS);
    const first = render(
      <ListPickerRenderer {...makeProps({ label: "   ", required: true })} />,
    );

    await waitFor(() => screen.getByText("Marketing directors"));

    // A blank label with no declared question draws no heading at all.
    expect(screen.queryByTestId("list-picker-question")).toBeNull();
    expect(first.container.querySelector("h3")).toBeNull();
    first.unmount();

    // A blank label beside a declared question draws that question.
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(ROWS);
    render(
      <ListPickerRenderer
        {...makeProps({
          label: "   ",
          required: true,
          bindingParams: { question: "Which entries should this run draw from?" },
        })}
      />,
    );

    await waitFor(() => screen.getByText("Marketing directors"));
    expect(questionAsked()).toBe("Which entries should this run draw from?");
  });

  // THE QUESTION IS THE AGENT'S DECLARATION (cinatra#3358, Agent run & review
  // §I.1: "What the list holds, what each row is titled by and what the step
  // asks are the agent's declaration too"). The binding's `params.question`
  // reaches the renderer as `bindingParams` and is drawn as written.
  it("asks the question the agent declared in its binding (Q1)", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const { container } = render(
      <ListPickerRenderer
        {...makeProps({
          label: undefined,
          bindingParams: { question: "Which entries should this run draw from?" },
        })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("list-picker-state-line").textContent).toBe(
        "Nothing to pick",
      ),
    );
    expect(container.querySelectorAll("h3")).toHaveLength(1);
    expect(screen.getByTestId("list-picker-question").tagName.toLowerCase()).toBe("h3");
    expect(questionAsked()).toBe("Which entries should this run draw from?");
  });

  // A STEP THAT DECLARES NO QUESTION draws none of the host's own: no heading
  // at all, never an empty one — the state line stands, so the page is not blank.
  it("draws no question heading when the step declares none and carries no label (Q2)", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const { container } = render(
      <ListPickerRenderer {...makeProps({ label: undefined })} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("list-picker-state-line").textContent).toBe(
        "Nothing to pick",
      ),
    );
    expect(screen.queryByTestId("list-picker-question")).toBeNull();
    expect(container.querySelectorAll("h3")).toHaveLength(0);
  });
});

describe('"no search field on the gate-that-lists unless the drawing gives one"', () => {
  it("draws no search field — §I.1 gives the gate rows and a Continue, and nothing else", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(ROWS);
    const { container } = render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => screen.getByText("Marketing directors"));

    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ITEM 1 — "the step lists, by name, every entry `fetchAvailableLists` returns
// for the run ... with no client-side search filter narrowing the set and no
// row printing a member count the contract returns as null".
// ---------------------------------------------------------------------------
describe('"the step lists, by name, every entry the read returns for the run"', () => {
  const FIVE = [
    "All contacts",
    "Marketing directors",
    "Q2 targets",
    "Newsletter opt-ins",
    "Lapsed customers",
  ].map((name, i) => ({
    id: `view_${i}`,
    name,
    memberCount: null,
    lastUpdated: null,
    memberType: "contact" as const,
  }));

  it("draws one row per returned entry, each named, and narrows the set by nothing", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(FIVE);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => screen.getByText("All contacts"));
    for (const row of FIVE) expect(screen.getByText(row.name)).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(FIVE.length);
    // The read is the whole set: the renderer is handed the run's identity and
    // asks for it once, unfiltered.
    expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1);
    expect(actions.fetchAvailableLists).toHaveBeenCalledWith("run-parked");
  });

  it("prints no member count beside a name — the contract returns none", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(FIVE);
    const { container } = render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => screen.getByText("All contacts"));
    expect(container.textContent).not.toMatch(/\d+\s*contact/i);
    expect(container.textContent).not.toMatch(/null/i);
    // The count's WORDING, not only its number: the contract returns null and
    // the removed markup drew that as " contact(s)" — no digit, no "null" — so
    // the phrase is what pins the removal (convergence round, cinatra#3562).
    expect(container.textContent).not.toMatch(/contact\(s\)/i);
  });
});

// ---------------------------------------------------------------------------
// ITEM 2 — "the choice is a multi-select: one or several entries ticked, and
// the run receives every ticked entry"; and the step opens with NOTHING chosen
// for the reader (§I.1: "Nothing is selected for them").
// ---------------------------------------------------------------------------
describe('"one or several entries ticked, and the run receives every ticked entry"', () => {
  it("opens with no row chosen", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(ROWS);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => screen.getByText("Marketing directors"));
    expect(chosen("Marketing directors")).toBe("false");
    expect(chosen("Q2 targets")).toBe("false");
    expect(screen.queryAllByRole("checkbox", { checked: true })).toHaveLength(0);
  });

  it("draws a held answer of several entries with each of them ticked", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(ROWS);
    const onChange = vi.fn();
    render(
      <ListPickerRenderer
        {...makeProps({
          onChange,
          value: {
            scope: "list",
            listIds: ["lst_1", "lst_2"],
            listNames: ["Marketing directors", "Q2 targets"],
            listId: "lst_1",
            listName: "Marketing directors",
          },
        })}
      />,
    );

    await waitFor(() => screen.getByText("Marketing directors"));
    // A step re-opened on an answer it already holds shows it, and emits
    // nothing of its own: the answer is the reader's, not this render's.
    expect(onChange).not.toHaveBeenCalled();
    expect(chosen("Marketing directors")).toBe("true");
    expect(chosen("Q2 targets")).toBe("true");
  });
});

describe('"the zero-content reading is the state line and the sentence — and no frame"', () => {
  /** The empty-state message a step declares in its list-picker binding
   *  (`params.emptyState`) — the drawing's own example sentence. */
  const DECLARED_EMPTY_STATE =
    "There is nothing to pick from yet. Add an entry where this run reads from, then open this step again.";

  it("draws no dashed rectangle and no dashed circle icon", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const { container } = render(
      <ListPickerRenderer
        {...makeProps({ bindingParams: { emptyState: DECLARED_EMPTY_STATE } })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("list-picker-empty-reading")).toBeTruthy(),
    );

    // The panel §I.1 never draws. The generic Empty pattern is a component of
    // its own with its own drawing; this gate's zero-content reading is drawn
    // by the section itself, on the page, with nothing framing it.
    expect(
      container.querySelector('[data-slot="empty"]'),
      "the zero-content reading sits in an undrawn panel",
    ).toBeNull();
    // THE READING ITSELF and every box between it and the gate's root: none of
    // them may draw a dashed border.
    const sentence = screen.getByTestId("list-picker-empty-reading");
    const framing: Element[] = [];
    for (
      let el: Element | null = sentence;
      el !== null && el !== container.parentElement;
      el = el.parentElement
    ) {
      framing.push(el);
    }
    expect(
      framing
        .map((el) => el.getAttribute("class") ?? "")
        .filter((cls) => /(?:^|\s)[a-z-]*border-dashed(?:\s|$)/.test(cls)),
    ).toEqual([]);
    // And no glyph in a dashed circle: the reading is words.
    expect(container.querySelector('[data-slot="empty-icon"]')).toBeNull();
    expect(sentence.querySelectorAll("svg").length).toBe(0);
  });

  // ITEM 4 — "with a connected Twenty CRM holding no view or list, the step
  // shows a message asking the person to create one in Twenty CRM, offers no
  // road to another agent and does not let the run continue, and lists the new
  // one when the person returns".
  it("asks the reader to create one where the views and lists live, and says the step will list it", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(
      <ListPickerRenderer
        {...makeProps({ bindingParams: { emptyState: DECLARED_EMPTY_STATE } })}
      />,
    );

    const sentence = await screen.findByRole("status");
    expect(sentence).toBe(screen.getByTestId("list-picker-empty-reading"));
    // The message is the one the agent declared, drawn as written (cinatra#3358).
    expect(sentence.textContent).toBe(DECLARED_EMPTY_STATE);
    // It never says the run ends here — the reader is expected back.
    expect(sentence.textContent).not.toMatch(/ends here/i);

    const stateLine = screen.getByTestId("list-picker-state-line");
    expect(stateLine.textContent).toBe("Nothing to pick");
    expect(
      stateLine.compareDocumentPosition(sentence) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("offers no road beneath it — no link, no button and no other agent", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const { container } = render(
      <ListPickerRenderer
        {...makeProps({ bindingParams: { emptyState: DECLARED_EMPTY_STATE } })}
      />,
    );

    const sentence = await screen.findByRole("status");
    // Nothing to press and nowhere to go: the step no longer sends the reader
    // to another agent to make a list, which is what the ruling retires.
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(sentence.textContent).not.toMatch(/\bagent\b/i);
    expect(container.textContent).not.toMatch(/\/agents\//);
  });

  it("lists the new entry when the reader comes back having made one", async () => {
    // The same step, re-opened after the reader made a view in the CRM: the
    // read is the live one, so the entry is simply there to tick.
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const first = render(
      <ListPickerRenderer
        {...makeProps({ bindingParams: { emptyState: DECLARED_EMPTY_STATE } })}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("list-picker-empty-reading")).toBeTruthy(),
    );
    first.unmount();

    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([ROWS[0]]);
    render(
      <ListPickerRenderer
        {...makeProps({ bindingParams: { emptyState: DECLARED_EMPTY_STATE } })}
      />,
    );
    await waitFor(() => screen.getByText("Marketing directors"));
    expect(screen.queryByTestId("list-picker-empty-reading")).toBeNull();
    expect(chosen("Marketing directors")).toBe("false");
  });

  // THE EMPTY-STATE MESSAGE IS THE AGENT'S (cinatra#3358, §I.1: "the host draws
  // the empty-state message the agent declared, as the agent wrote it — the host
  // names no system and writes no message of its own").
  it("draws the empty-state message the agent declared, as written, after the state line (E1)", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(
      <ListPickerRenderer
        {...makeProps({ bindingParams: { emptyState: DECLARED_EMPTY_STATE } })}
      />,
    );

    const sentence = await screen.findByRole("status");
    expect(sentence).toBe(screen.getByTestId("list-picker-empty-reading"));
    expect(sentence.textContent).toBe(DECLARED_EMPTY_STATE);
    const stateLine = screen.getByTestId("list-picker-state-line");
    expect(stateLine.textContent).toBe("Nothing to pick");
    expect(
      stateLine.compareDocumentPosition(sentence) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws no message of the host's own when the step declares none (E2)", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const { container } = render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() =>
      expect(screen.getByTestId("list-picker-state-line").textContent).toBe(
        "Nothing to pick",
      ),
    );
    expect(screen.queryByTestId("list-picker-empty-reading")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.textContent).not.toMatch(/Twenty/);
    expect(container.textContent).not.toMatch(/CRM/);
  });
});
