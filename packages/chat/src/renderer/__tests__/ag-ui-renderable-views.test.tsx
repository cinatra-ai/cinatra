// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// Renderable-view dispatch through the AG-UI interactive layer (cinatra#1220,
// S4 — the inventory-registration wiring).
//
// The reducer carries every structured `DATA_PART` it does not consume itself
// through `state.dataParts` FOR the interactive layer's renderable-view
// dispatch. These tests prove that dispatch end-to-end: every REGISTERED view
// in the S1/S4 schema registry, folded off the wire, renders its registered
// card inside `ConversationTurn`; an unknown/invalid view renders the safe
// fallback; a plain data part (no `viewType`) renders nothing.
//
// NOTE deliberately payload-minimal and attribute-driven (`data-view-type`),
// NOT card-internals-driven — the cards' innards evolve separately (e.g. the
// #1328 applied/refresh affordance) without touching this dispatch contract.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";
import {
  KNOWN_RENDERABLE_VIEW_TYPES,
  ARTIFACT_PREVIEW_SCHEMA_VERSION,
  CHANGE_HISTORY_SCHEMA_VERSION,
  CITATION_GROUP_SCHEMA_VERSION,
  CONTENT_CHANGE_PROPOSAL_SCHEMA_VERSION,
  type KnownRenderableViewType,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { ConversationTurn, RenderableViewParts } from "../ag-ui-interactive";
import { reduceAgUiEvents } from "../ag-ui-reducer";
import {
  dataPart,
  runFinished,
  runStarted,
  textDelta,
  textEnd,
  textStart,
  toolStart,
} from "./ag-ui-fixtures";

afterEach(() => cleanup());

// Minimal VALID payload per registered viewType. Keyed exhaustively: the
// `satisfies` clause breaks the build when a new view is registered without
// extending this dispatch matrix.
const MINIMAL_VALID_VIEWS = {
  content_change_proposal: {
    viewType: "content_change_proposal",
    schemaVersion: CONTENT_CHANGE_PROPOSAL_SCHEMA_VERSION,
    rich: false,
    fields: [{ field: "title", before: "Old", after: "New" }],
  },
  artifact_preview: {
    viewType: "artifact_preview",
    schemaVersion: ARTIFACT_PREVIEW_SCHEMA_VERSION,
    name: "report.pdf",
  },
  citation_group: {
    viewType: "citation_group",
    schemaVersion: CITATION_GROUP_SCHEMA_VERSION,
    sources: [{ title: "Quarterly results" }],
  },
  change_history: {
    viewType: "change_history",
    schemaVersion: CHANGE_HISTORY_SCHEMA_VERSION,
    entries: [{ runId: "run-1", label: "Edited the intro", undoable: true }],
  },
} satisfies Record<KnownRenderableViewType, Record<string, unknown>>;

/** Fold a full turn whose only payload of interest is the given DATA_PARTs. */
function turnWith(...parts: AgUiEvent[]) {
  return reduceAgUiEvents([
    runStarted(),
    textStart("m1"),
    textDelta("m1", "Here you go."),
    textEnd("m1"),
    ...parts,
    runFinished(),
  ]);
}

describe("ConversationTurn — registered-inventory dispatch (S4 #1220)", () => {
  it("renders the registered card for EVERY registered viewType folded off the wire", () => {
    for (const viewType of KNOWN_RENDERABLE_VIEW_TYPES) {
      const state = turnWith(dataPart(MINIMAL_VALID_VIEWS[viewType]));
      const { container, unmount } = render(<ConversationTurn state={state} />);
      expect(
        container.querySelector(`[data-view-type="${viewType}"]`),
        `registered view "${viewType}" must dispatch to its card`,
      ).toBeTruthy();
      expect(container.querySelector('[data-view-type="__fallback__"]')).toBeNull();
      unmount();
    }
  });

  it("renders the safe fallback for an unknown (newer-producer) viewType", () => {
    const state = turnWith(dataPart({ viewType: "from_the_future", payload: "?" }));
    const { container } = render(<ConversationTurn state={state} />);
    expect(container.querySelector('[data-view-type="__fallback__"]')).toBeTruthy();
  });

  it("renders the safe fallback for a KNOWN viewType with an invalid payload", () => {
    // content_change_proposal missing its required `rich` + `fields`.
    const state = turnWith(
      dataPart({
        viewType: "content_change_proposal",
        schemaVersion: CONTENT_CHANGE_PROPOSAL_SCHEMA_VERSION,
      }),
    );
    const { container } = render(<ConversationTurn state={state} />);
    expect(container.querySelector('[data-view-type="__fallback__"]')).toBeTruthy();
    expect(
      container.querySelector('[data-view-type="content_change_proposal"]'),
    ).toBeNull();
  });

  it("renders NOTHING for a plain structured data part (no viewType)", () => {
    const state = turnWith(dataPart({ kind: "telemetry", tokens: 12 }));
    const { container } = render(<ConversationTurn state={state} />);
    expect(container.querySelector("[data-renderable-views]")).toBeNull();
    expect(container.querySelector('[data-view-type="__fallback__"]')).toBeNull();
  });

  it("does NOT render reducer-consumed DATA_PARTs (agent_run pin, citations) as view cards", () => {
    const state = reduceAgUiEvents([
      runStarted(),
      toolStart("t1", "agent_run"),
      dataPart({ kind: "agent_run", toolCallId: "t1", runId: "run-9" }),
      dataPart({ kind: "citations", citations: [{ title: "Doc", url: "https://example.com/a" }] }),
      runFinished(),
    ]);
    const { container } = render(<ConversationTurn state={state} />);
    expect(container.querySelector("[data-renderable-views]")).toBeNull();
  });

  it("a replayed identical view DATA_PART renders exactly one card (reducer dedupe)", () => {
    const view = MINIMAL_VALID_VIEWS.artifact_preview;
    const state = turnWith(dataPart(view, 0), dataPart(view, 3));
    const { container } = render(<ConversationTurn state={state} />);
    expect(container.querySelectorAll('[data-view-type="artifact_preview"]')).toHaveLength(1);
  });

  it("multiple distinct views render in arrival order", () => {
    const state = turnWith(
      dataPart(MINIMAL_VALID_VIEWS.artifact_preview),
      dataPart(MINIMAL_VALID_VIEWS.citation_group),
    );
    const { container } = render(<ConversationTurn state={state} />);
    const cards = Array.from(
      container.querySelectorAll("[data-renderable-views] [data-view-type]"),
    ).map((el) => el.getAttribute("data-view-type"));
    expect(cards).toEqual(["artifact_preview", "citation_group"]);
  });
});

describe("viewType precedence over legacy structural kinds (codex round-1 finding)", () => {
  it("a payload with BOTH viewType and kind:'citations' is dispatched as a view, not merged as citations", () => {
    const collision = {
      ...MINIMAL_VALID_VIEWS.citation_group,
      kind: "citations",
      citations: [{ title: "Doc", url: "https://example.com/a" }],
    };
    const state = turnWith(dataPart(collision));
    // NOT consumed structurally: no merged message citations…
    expect(state.message.citations).toHaveLength(0);
    // …and the view reaches the registered dispatch.
    const { container } = render(<ConversationTurn state={state} />);
    expect(container.querySelector('[data-view-type="citation_group"]')).toBeTruthy();
  });

  it("a future view carrying kind:'agent_run' fields is NOT consumed as a run-card pin", () => {
    const state = reduceAgUiEvents([
      runStarted(),
      toolStart("t1", "agent_run"),
      dataPart({ viewType: "future_view", kind: "agent_run", toolCallId: "t1", runId: "r1" }),
      runFinished(),
    ]);
    const pinned = state.message.parts.find((p) => p.kind === "tool_call" && p.runId === "r1");
    expect(pinned).toBeUndefined();
    const { container } = render(<ConversationTurn state={state} />);
    expect(container.querySelector('[data-view-type="__fallback__"]')).toBeTruthy();
  });
});

describe("never-throw boundary (codex round-1 finding)", () => {
  const hostile = () => {
    const d = {} as Record<string, unknown>;
    Object.defineProperty(d, "viewType", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    return d;
  };

  it("a throwing viewType getter folded through the reducer renders the safe fallback, not a crash", () => {
    const state = reduceAgUiEvents([
      runStarted(),
      { type: "DATA_PART", data: hostile() } as AgUiEvent,
      runFinished(),
    ]);
    expect(state.dataParts).toHaveLength(1);
    const { container } = render(<ConversationTurn state={state} />);
    expect(container.querySelector('[data-view-type="__fallback__"]')).toBeTruthy();
  });

  it("RenderableViewParts routes a hostile payload to the guarded fallback directly", () => {
    const { container } = render(<RenderableViewParts dataParts={[hostile()]} />);
    expect(container.querySelector('[data-view-type="__fallback__"]')).toBeTruthy();
  });
});

describe("RenderableViewParts — direct", () => {
  it("renders nothing for an empty dataParts list", () => {
    const { container } = render(<RenderableViewParts dataParts={[]} />);
    expect(container.querySelector("[data-renderable-views]")).toBeNull();
  });

  it("filters plain data parts and dispatches only renderable views", () => {
    const { container } = render(
      <RenderableViewParts
        dataParts={[
          { kind: "telemetry" },
          MINIMAL_VALID_VIEWS.change_history,
        ]}
      />,
    );
    const cards = container.querySelectorAll("[data-renderable-views] [data-view-type]");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.getAttribute("data-view-type")).toBe("change_history");
  });
});
