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
 *    the state line, the sentence and the primary action — never just empty
 *    text — with no dashed rectangle and no dashed circle icon"
 *
 *   "no undrawn full-width cross-run banner — the return to the waiting run is
 *    placed where section I places the run's actions; no search field on the
 *    gate-that-lists unless the drawing gives one; no info icon on rail entries;
 *    the refusal toast sits on the drawn opaque popover ground"
 *
 *   "when a child run completes with a listId, the parked run's account-scope
 *    step offers that list"
 *
 * THE SECOND PROOF ROUND (2026-09-15) graded this page on a REAL parked run and
 * found two readings that §I.1 does not draw. The section's zero-content
 * reading ("The same step with nothing left to pick") is drawn as the question
 * over the "Nothing to pick" pill, then a `role="status"` sentence, then the
 * make-one road — words on the page itself, with NO panel around them: no
 * dashed rectangle and no dashed circle icon. And the question is drawn in
 * EVERY reading, the zero-content one included, so a heading rendered from a
 * label the step does not carry — the account-scope step carries none — left
 * the gate opening on an empty h3. The generic Empty pattern (Components §
 * Empty state, "a single primary action button — never just empty text") keeps
 * its own dashed circle where it is drawn; what it never does is displace the
 * page a section draws itself.
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
import { GENERATED_FIELD_RENDERER_BINDINGS } from "@/lib/generated/agent-bindings";

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

/** The question the heading ASKS, with the required marker the h3 appends after
 *  it removed: the asterisk belongs to the field, not to the question, so a
 *  required step must not change what the question reads. */
function questionAsked(): string {
  return (screen.getByTestId("list-picker-question").textContent ?? "")
    .replace(/\s*\*\s*$/, "")
    .trim();
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

  // THE STEP THAT NAMES NO QUESTION (the second proof round). The account-scope
  // step reaches this renderer with NO resolved label — its schema titles the
  // FIELD, not the reader's question, and the surface that mounts the gate
  // passes no label at all — so a heading rendered from that label alone opened
  // the gate on an EMPTY h3 over its state line. §I.1 draws the gate opening on
  // its question in every reading, the zero-content one included.
  it("opens on the drawn question when the step names none", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps({ label: undefined })} />);

    await waitFor(() =>
      expect(screen.getByTestId("list-picker-state-line").textContent).toBe(
        "Nothing to pick",
      ),
    );

    const question = screen.getByTestId("list-picker-question");
    const asked = questionAsked();
    expect(asked, "the gate opened on an empty question heading").not.toBe("");
    // It ASKS, and it asks about the thing this gate lists.
    expect(asked.endsWith("?"), `not a question: ${asked}`).toBe(true);
    expect(asked).toMatch(/list/i);
    // Over the state line, as the section draws it.
    const stateLine = screen.getByTestId("list-picker-state-line");
    expect(
      question.compareDocumentPosition(stateLine) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // A REQUIRED step reads the same way: the h3 appends the field's asterisk
  // after the question, and the question itself still has to ask something.
  it("reads a blank label as no question at all", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(ROWS);
    render(
      <ListPickerRenderer {...makeProps({ label: "   ", required: true })} />,
    );

    await waitFor(() => screen.getByText("Marketing directors"));

    const asked = questionAsked();
    expect(asked, "the gate opened on a blank question heading").not.toBe("");
    expect(asked.endsWith("?"), `not a question: ${asked}`).toBe(true);
    expect(asked).toMatch(/list/i);
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

describe('"the zero-content reading is the state line, the sentence and the primary action — and no frame"', () => {
  it("draws no dashed rectangle and no dashed circle icon", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const { container } = render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => expect(screen.getByText(/no lists yet/i)).toBeTruthy());

    // The panel §I.1 never draws. The generic Empty pattern is a component of
    // its own with its own drawing; this gate's zero-content reading is drawn
    // by the section itself, on the page, with nothing framing it.
    expect(
      container.querySelector('[data-slot="empty"]'),
      "the zero-content reading sits in an undrawn panel",
    ).toBeNull();
    // THE READING ITSELF and every box between it and the gate's root: none of
    // them may draw a dashed border. Scoped to the reading, because that is
    // what the grade found framed — a dashed rule drawn somewhere else on the
    // gate would be another reading's defect, and the make-one road stays free
    // to carry its own glyph.
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

  it("states the fact in a sentence under the state line, with the road after it", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps()} />);

    // The section's own zero-content sentence, announced the way it is drawn.
    const sentence = await screen.findByRole("status");
    expect(sentence.textContent).toMatch(/no lists yet/i);

    const stateLine = screen.getByTestId("list-picker-state-line");
    expect(stateLine.textContent).toBe("Nothing to pick");
    expect(
      stateLine.compareDocumentPosition(sentence) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // "never just empty text": the make-one road is the reading's action, and
    // it sits AFTER the sentence, not inside it.
    const road = screen.getByTestId("build-list-with-ai-cta");
    expect(sentence.contains(road)).toBe(false);
    expect(
      sentence.compareDocumentPosition(road) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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


// ---------------------------------------------------------------------------
// THE ROAD THE PINNED TREE ACTUALLY RAISES. Every test above hands the gate a
// hand-written `bindingParams` fixture, so they prove the RENDERER and say
// nothing about what the host's pinned extension universe declares. The road
// a reader reaches is minted from the binding the generated table carries, so
// the gate is rendered here from THAT declaration — the one the pinned
// packages produce — and not from a fixture.
// ---------------------------------------------------------------------------
describe('"the make-one road\'s destination is declared by the binding" — on the PINNED bindings', () => {
  const listPickerBindings = GENERATED_FIELD_RENDERER_BINDINGS.filter(
    (b) => b.kind === "list-picker",
  );

  it("carries the list builder on the one generated list-picker binding, once", () => {
    // The two packages that raise this gate CO-DECLARE the same binding id;
    // the manifest generator records it once and refuses a disagreement, so a
    // single row is the whole reading.
    expect(listPickerBindings.map((b) => b.id)).toEqual([
      "@cinatra-ai/email-outreach-agent:list-picker",
    ]);
    const declared = listPickerBindings[0]?.params?.listBuilderPackage;
    expect(
      declared,
      "the pinned list-picker binding declares no list builder",
    ).toBe("@cinatra-ai/list-curator-agent");
  });

  it("reaches the declared builder from the gate's zero-content reading", async () => {
    const params = listPickerBindings[0]?.params;
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps({ bindingParams: params })} />);

    await waitFor(() => expect(screen.getByText(/no lists yet/i)).toBeTruthy());

    const road = screen.getByTestId("build-list-with-ai-cta");
    expect(road.getAttribute("href")).toContain(
      "cinatra-ai/list-curator-agent/new",
    );
    expect(road.getAttribute("href")).toContain("onCompleteRunId=run-parked");
  });
});
