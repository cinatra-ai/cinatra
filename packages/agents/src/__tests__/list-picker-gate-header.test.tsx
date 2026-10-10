// @vitest-environment jsdom
/**
 * cinatra#3720 — the list-picker gate header.
 *
 * The artifact review drawing gives the gate's frame a header (§III), and its
 * list step (§I.1, the `run-idea-step` example) draws that header as ONE row:
 * the question the agent declared for the step and, beside it, the waiting pill
 * "Awaiting your pick". This file pins the header through every shape in which
 * a run surface mounts the list picker:
 *
 *   - the stepper's live gate, the agentic run panel and the HITL screen card
 *     pass NO label (and no declared question unless the binding declares one),
 *   - the schema-field road passes its normalized props, which carry a label,
 *   - the stepper's read-only replay of a settled gate passes `mode="view"` and
 *     `disabled` — a settled gate never claims to wait.
 *
 * An absent or blank declared question never leaves an empty band: no element
 * of the renderer carries empty text or only the required mark. Everything
 * else of the list step (the helper sentence, the search field, the link, the
 * rows) reads as it did.
 */
import React from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

// Stub the loader BEFORE importing the renderer, as list-picker-renderer.test.tsx does.
vi.mock("../list-picker-actions", () => ({
  fetchAvailableLists: vi.fn(),
}));

import { ListPickerRenderer } from "../list-picker-renderer";
import * as actions from "../list-picker-actions";
import type { FieldRendererProps } from "../field-renderer-registry";

const WAITING = "Awaiting your pick";
const HELPER =
  "Pick a list to send this campaign to. Lists are reusable saved sets of contacts.";
const QUESTION = "Which lists should this campaign reach?";

const HEADER = '[data-testid="list-picker-gate-header"]';
const QUESTION_EL = '[data-testid="list-picker-gate-question"]';
const WAITING_EL = '[data-testid="list-picker-gate-waiting"]';

const ROWS = [
  {
    id: "l1",
    name: "Beta Prospects",
    memberCount: 42,
    lastUpdated: null,
    memberType: "contact" as const,
  },
  {
    id: "l2",
    name: "Q2 Targets",
    memberCount: 1,
    lastUpdated: null,
    memberType: "mixed" as const,
  },
];

// The props every run surface passes, whatever else it adds.
function baseProps(
  overrides: Partial<FieldRendererProps> = {},
): FieldRendererProps {
  return {
    fieldName: "hitl-field",
    schema: {} as Record<string, unknown>,
    value: undefined,
    onChange: () => {},
    context: { connectedApps: [], runId: "run-1" },
    ...overrides,
  };
}

// One shape per mount of the census (the props each mount hands the renderer).
const LIVE_NO_LABEL_SHAPES: ReadonlyArray<
  readonly [string, Partial<FieldRendererProps>]
> = [
  ["the stepper's live gate", { mode: "edit", hideSubmit: false }],
  ["the agentic run panel", { mode: "edit", hideSubmit: false }],
  ["the HITL screen card", { mode: "edit", hideSubmit: true }],
];

const SCHEMA_FIELD_ROAD: Partial<FieldRendererProps> = {
  fieldName: "list",
  disabled: false,
  required: true,
  error: null,
  label: "Pick a list",
  description: undefined,
  mode: "edit",
};

const STEPPER_REPLAY: Partial<FieldRendererProps> = {
  disabled: true,
  mode: "view",
};

function root(container: HTMLElement): HTMLElement {
  const el = container.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error("renderer drew nothing");
  return el;
}

// Every element with no element children must carry text other than the
// required mark — an input, an svg and a decorative (aria-hidden) mark aside.
function emptyElements(container: HTMLElement): string[] {
  const found: string[] = [];
  for (const el of Array.from(root(container).querySelectorAll("*"))) {
    if (el.children.length > 0) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "svg" || el.closest("svg")) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text === "" || text === "*") found.push(el.outerHTML);
  }
  return found;
}

function labelTexts(container: HTMLElement): string[] {
  return Array.from(root(container).querySelectorAll("label")).map(
    (el) => el.textContent ?? "",
  );
}

async function settled() {
  await waitFor(() =>
    expect(screen.queryByText("Loading lists…")).toBeNull(),
  );
}

beforeEach(() => {
  vi.mocked(actions.fetchAvailableLists).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../list-picker-actions");
  vi.resetModules();
});

describe("list-picker gate header — the census of mounts (cinatra#3720)", () => {
  for (const [name, shape] of LIVE_NO_LABEL_SHAPES) {
    it(`${name}: no label, no question — the header row carries the waiting pill alone and no empty band`, async () => {
      const { container } = render(
        <ListPickerRenderer {...baseProps(shape)} />,
      );
      await settled();

      expect(emptyElements(container)).toEqual([]);
      expect(labelTexts(container)).toEqual([]);
      const header = container.querySelector(HEADER);
      expect(header).not.toBeNull();
      // The header opens the step.
      expect(root(container).firstElementChild).toBe(header);
      expect(header!.querySelector(QUESTION_EL)).toBeNull();
      const waiting = header!.querySelector(WAITING_EL);
      expect(waiting?.textContent?.trim()).toBe(WAITING);
      expect(header!.children).toHaveLength(1);
    });
  }

  it("a live gate marked required with no label draws no lone required mark", async () => {
    const { container } = render(
      <ListPickerRenderer {...baseProps({ mode: "edit", required: true })} />,
    );
    await settled();

    expect(emptyElements(container)).toEqual([]);
    expect(container.querySelector(QUESTION_EL)).toBeNull();
    expect(container.querySelector(WAITING_EL)?.textContent?.trim()).toBe(
      WAITING,
    );
  });

  it("the schema-field road: its label is the question, in the same row as the waiting pill", async () => {
    const { container } = render(
      <ListPickerRenderer {...baseProps(SCHEMA_FIELD_ROAD)} />,
    );
    await settled();

    expect(emptyElements(container)).toEqual([]);
    const header = container.querySelector(HEADER);
    expect(header).not.toBeNull();
    expect(root(container).firstElementChild).toBe(header);
    const question = header!.querySelector(QUESTION_EL);
    expect(question?.textContent).toBe("Pick a list *");
    expect(header!.querySelector(WAITING_EL)?.textContent?.trim()).toBe(
      WAITING,
    );
  });

  it("the stepper's replay of a settled gate (mode view, disabled, no label) draws no waiting pill and no empty band", async () => {
    const { container } = render(
      <ListPickerRenderer {...baseProps(STEPPER_REPLAY)} />,
    );
    await settled();

    expect(emptyElements(container)).toEqual([]);
    expect(container.querySelector(WAITING_EL)).toBeNull();
    expect(container.querySelector(QUESTION_EL)).toBeNull();
    expect(screen.queryByText(WAITING)).toBeNull();
  });

  it("a replay whose gate declared a question draws the question alone", async () => {
    const { container } = render(
      <ListPickerRenderer
        {...baseProps({ ...STEPPER_REPLAY, bindingParams: { question: QUESTION } })}
      />,
    );
    await settled();

    const header = container.querySelector(HEADER);
    expect(header).not.toBeNull();
    expect(header!.querySelector(QUESTION_EL)?.textContent).toBe(QUESTION);
    expect(container.querySelector(WAITING_EL)).toBeNull();
    expect(screen.queryByText(WAITING)).toBeNull();
  });

  it("the waiting pill stands while the lists load and over the rows", async () => {
    let resolve: (rows: typeof ROWS) => void = () => {};
    vi.mocked(actions.fetchAvailableLists).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { container } = render(
      <ListPickerRenderer {...baseProps({ mode: "edit" })} />,
    );

    expect(screen.getByText("Loading lists…")).toBeTruthy();
    expect(container.querySelector(WAITING_EL)?.textContent?.trim()).toBe(
      WAITING,
    );

    resolve(ROWS);
    await waitFor(() => screen.getByText("Beta Prospects"));
    expect(container.querySelector(WAITING_EL)?.textContent?.trim()).toBe(
      WAITING,
    );
    expect(emptyElements(container)).toEqual([]);
  });
});

describe("list-picker gate header — the declared question (cinatra#3720)", () => {
  it("draws the binding's declared question in the same row as the waiting pill", async () => {
    const { container } = render(
      <ListPickerRenderer
        {...baseProps({ mode: "edit", bindingParams: { question: QUESTION } })}
      />,
    );
    await settled();

    const header = container.querySelector(HEADER);
    expect(header).not.toBeNull();
    const question = header!.querySelector(QUESTION_EL);
    const waiting = header!.querySelector(WAITING_EL);
    expect(question?.textContent).toBe(QUESTION);
    expect(question?.parentElement).toBe(header);
    expect(waiting?.parentElement).toBe(header);
    expect(waiting?.textContent?.trim()).toBe(WAITING);
    // The question comes first, as the drawing orders the row.
    expect(header!.firstElementChild).toBe(question);
    expect(emptyElements(container)).toEqual([]);
  });

  it("draws a label as the question when the binding declares none", async () => {
    const { container } = render(
      <ListPickerRenderer {...baseProps({ mode: "edit", label: "Pick a list" })} />,
    );
    await settled();

    const header = container.querySelector(HEADER);
    expect(header!.querySelector(QUESTION_EL)?.textContent).toBe("Pick a list");
    expect(header!.querySelector(WAITING_EL)?.textContent?.trim()).toBe(WAITING);
  });

  it("the binding's declared question wins over the label", async () => {
    const { container } = render(
      <ListPickerRenderer
        {...baseProps({
          mode: "edit",
          label: "Pick a list",
          bindingParams: { question: QUESTION },
        })}
      />,
    );
    await settled();

    expect(container.querySelectorAll(QUESTION_EL)).toHaveLength(1);
    expect(container.querySelector(QUESTION_EL)?.textContent).toBe(QUESTION);
  });

  it("draws the question in the review gate header's treatment and the pill in its hold treatment", async () => {
    const { container } = render(
      <ListPickerRenderer
        {...baseProps({ mode: "edit", bindingParams: { question: QUESTION } })}
      />,
    );
    await settled();

    const header = container.querySelector(HEADER)!;
    expect(header.className).toContain("flex-wrap");
    const question = header.querySelector(QUESTION_EL)!;
    for (const token of ["font-sans", "text-sm", "font-bold", "text-foreground"]) {
      expect(question.className.split(" ")).toContain(token);
    }
    const waiting = header.querySelector(WAITING_EL)!;
    for (const token of ["rounded-full", "bg-brand-mustard/15", "text-mustard-ink"]) {
      expect(waiting.className.split(" ")).toContain(token);
    }
    const dot = waiting.querySelector('[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot!.className.split(" ")).toContain("bg-brand-mustard");
  });

  it.each([
    ["a blank declared question and a blank label", { bindingParams: { question: "   " }, label: "  " }],
    ["an empty declared question and no label", { bindingParams: { question: "" } }],
    ["a declared question that is not text", { bindingParams: { question: 42 } }],
  ] as const)(
    "%s draw no question element — the pill stands alone",
    async (_name, extra) => {
      const { container } = render(
        <ListPickerRenderer
          {...baseProps({ mode: "edit", required: true, ...(extra as Partial<FieldRendererProps>) })}
        />,
      );
      await settled();

      expect(container.querySelector(QUESTION_EL)).toBeNull();
      const header = container.querySelector(HEADER);
      expect(header).not.toBeNull();
      expect(header!.children).toHaveLength(1);
      expect(header!.querySelector(WAITING_EL)?.textContent?.trim()).toBe(WAITING);
      expect(emptyElements(container)).toEqual([]);
    },
  );

  it("a blank declared question falls back to the label", async () => {
    const { container } = render(
      <ListPickerRenderer
        {...baseProps({
          mode: "edit",
          label: "Pick a list",
          bindingParams: { question: "  " },
        })}
      />,
    );
    await settled();

    expect(container.querySelector(QUESTION_EL)?.textContent).toBe("Pick a list");
  });
});

describe("list-picker gate header — nothing else of the list step changes (cinatra#3720)", () => {
  it("keeps the helper sentence and search field, with no road to a list-building agent", async () => {
    const { container } = render(
      <ListPickerRenderer {...baseProps({ mode: "edit" })} />,
    );
    await settled();

    expect(screen.getByText(HELPER)).toBeTruthy();
    const search = screen.getByPlaceholderText("Search lists by name");
    expect(search.getAttribute("aria-label")).toBe("Search lists by name");
    expect(search.getAttribute("type")).toBe("search");
    expect(screen.queryByTestId("build-list-with-ai-cta")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("[data-conformance-id]")).toBeNull();
  });

  it("keeps a declared description in place of the helper sentence", async () => {
    render(
      <ListPickerRenderer
        {...baseProps({ mode: "edit", description: "Choose the audience." })}
      />,
    );
    await settled();

    expect(screen.getByText("Choose the audience.")).toBeTruthy();
    expect(screen.queryByText(HELPER)).toBeNull();
  });

  it("keeps the loading line, the empty card and the rows", async () => {
    let resolve: (rows: typeof ROWS) => void = () => {};
    vi.mocked(actions.fetchAvailableLists).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<ListPickerRenderer {...baseProps({ mode: "edit" })} />);
    expect(screen.getByText("Loading lists…")).toBeTruthy();
    resolve(ROWS);
    await waitFor(() => screen.getByText("Beta Prospects"));
    expect(screen.getByText("Q2 Targets")).toBeTruthy();
    expect(screen.getByText("42 contacts")).toBeTruthy();
    expect(screen.getByText("1 contact")).toBeTruthy();
    const rows = screen.getAllByRole("button", { pressed: false });
    expect(rows).toHaveLength(2);

    cleanup();
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...baseProps({ mode: "edit" })} />);
    await waitFor(() =>
      expect(
        screen.getByText("No lists yet. Create one to get started."),
      ).toBeTruthy(),
    );
  });

  it("keeps the single pick and its value shape", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(ROWS);
    render(<ListPickerRenderer {...baseProps({ mode: "edit", onChange })} />);
    await waitFor(() => screen.getByText("Beta Prospects"));

    screen.getByText("Beta Prospects").click();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      scope: "list",
      listId: "l1",
      listName: "Beta Prospects",
      memberCount: 42,
    });
  });
});
