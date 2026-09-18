// @vitest-environment jsdom
/**
 * Unit tests for ListPickerRenderer.
 *
 * Locks the renderer contract:
 *   - Mount renders the step's question heading (no "Create new list" CTA, and
 *     no search field — the drawing gives the gate neither).
 *   - Lists from fetchAvailableLists() render as tickable rows with name +
 *     memberType badge, and no member count (the reader contract returns none).
 *   - A press emits the canonical
 *     { scope: "list", listIds, listNames, listId, listName } shape, and a
 *     second press ADDS rather than replaces (cinatra#3562).
 *   - The zero-content reading asks the reader to create a view or list in
 *     Twenty CRM, and offers no road out of the step.
 *   - mixed-memberType lists render with the SAME affordances as
 *     contact-typed lists and produce the same onChange payload shape
 *     so the picker accepts both `contact` and `mixed` rows.
 *   - the renderer THREADS `context.runId` into the loader (cinatra#3050) so
 *     the lists are loaded with the RUN's access instead of a
 *     platform-administrator session.
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
import * as listPickerRendererModule from "../list-picker-renderer";
import * as agentUrl from "@/lib/agent-url";
import * as actions from "../list-picker-actions";
import type { FieldRendererProps } from "../field-renderer-registry";
import {
  isRunSurfaceStepSelectable,
  type RunSurfaceRailStep,
} from "../run-surface-rail-step";

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
    context: { connectedApps: [], runId: "run-1" },
    ...overrides,
  };
}

/** Is this row among the chosen? Read off the anchor the row has always
 *  carried — `data-selected`, whose meaning is unchanged. */
function chosen(name: string): string | null {
  return (
    screen.getByText(name).closest("[data-selected]")?.getAttribute("data-selected") ??
    null
  );
}

const PARKED_AT = "/workspace/agents/cinatra-ai/outreach-agent/run-1";
let originalHref = "";

beforeEach(() => {
  vi.clearAllMocks();
  originalHref = window.location.href;
  window.history.replaceState(null, "", PARKED_AT);
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", originalHref);
});

describe("ListPickerRenderer", () => {
  it("renders the step's question on mount (no create-new-list link; retired)", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    // The "Create new list" affordance was retired with the lists_* MCP
    // family; the ruling of cinatra#3562 retires every other road out of this
    // step too, so no link at all is drawn here.
    expect(
      screen.queryByRole("link", { name: /create new list/i }),
    ).toBeNull();
    // AND THE SEARCH FIELD IS GONE (cinatra#3358). The gate that lists is drawn
    // in Agent run & review §I.1 as rows and a Continue — it is given no search
    // field, so the step no longer draws one. Pinned in
    // list-picker-gate-drawn.test.tsx.
    expect(screen.queryByPlaceholderText(/search lists/i)).toBeNull();
    expect(screen.getByTestId("list-picker-question")).toBeTruthy();
  });

  it("renders all returned lists with both contact and mixed member types", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([
      {
        id: "l1",
        name: "Beta Prospects",
        memberCount: null,
        lastUpdated: null,
        memberType: "contact",
      },
      {
        id: "l2",
        name: "Q2 Targets",
        memberCount: null,
        lastUpdated: null,
        memberType: "mixed",
      },
      {
        id: "l3",
        name: "Hot Leads",
        memberCount: null,
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

  // THE SEARCH FILTER IS RETIRED (cinatra#3358). It was a client-side filter on
  // a field the ratified drawing does not give this gate; the rows are the whole
  // page (Agent run & review §I.1). Nothing replaces it here.

  it("invokes onChange with the canonical value shape when a row is ticked", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([
      {
        id: "l1",
        name: "Beta Prospects",
        memberCount: null,
        lastUpdated: null,
        memberType: "contact",
      },
    ]);
    render(<ListPickerRenderer {...makeProps({ onChange })} />);

    await waitFor(() => screen.getByText("Beta Prospects"));
    fireEvent.click(screen.getByText("Beta Prospects"));

    expect(onChange).toHaveBeenCalledWith({
      scope: "list",
      listIds: ["l1"],
      listNames: ["Beta Prospects"],
      listId: "l1",
      listName: "Beta Prospects",
    });
  });

  it("renders the empty reading when the CRM holds no view or list", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() =>
      expect(screen.getByTestId("list-picker-empty-reading")).toBeTruthy(),
    );
  });

  it("renders mixed-memberType lists with the same affordances and onChange payload shape as contact-typed lists", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([
      {
        id: "lm",
        name: "Mixed Sample",
        memberCount: null,
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
      listIds: ["lm"],
      listNames: ["Mixed Sample"],
      listId: "lm",
      listName: "Mixed Sample",
    });
  });
});

// ---------------------------------------------------------------------------
// THE STEP TAKES SEVERAL ENTRIES (cinatra#3562, acceptance 2).
//
// "ticking a second row ADDS it rather than replacing the first, the emitted
// value is `{scope:'list', listIds:[...], listNames:[...]}` in ticked order
// with `listId`/`listName` kept as the first entry for the pinned pack's legacy
// branch, a step re-opened on an answer it already holds shows every held entry
// ticked"
// ---------------------------------------------------------------------------

const TWO_ROWS = [
  {
    id: "l1",
    name: "Marketing directors",
    memberCount: null,
    lastUpdated: null,
    memberType: "contact" as const,
  },
  {
    id: "l2",
    name: "Q2 targets",
    memberCount: null,
    lastUpdated: null,
    memberType: "contact" as const,
  },
];

describe("the gate takes several entries (cinatra#3562)", () => {
  it("ADDS a second ticked row instead of moving the answer to it", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(TWO_ROWS);
    render(<ListPickerRenderer {...makeProps({ onChange })} />);

    await waitFor(() => screen.getByText("Marketing directors"));
    fireEvent.click(screen.getByText("Marketing directors"));
    fireEvent.click(screen.getByText("Q2 targets"));

    // In TICKED ORDER, with the first entry repeated in the one-identifier
    // fields the pinned pack's legacy branch reads.
    expect(onChange).toHaveBeenLastCalledWith({
      scope: "list",
      listIds: ["l1", "l2"],
      listNames: ["Marketing directors", "Q2 targets"],
      listId: "l1",
      listName: "Marketing directors",
    });
    expect(chosen("Marketing directors")).toBe("true");
    expect(chosen("Q2 targets")).toBe("true");
  });

  it("draws every ticked row as a checkbox that is checked, never a pressed button", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(TWO_ROWS);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => screen.getByText("Marketing directors"));
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(screen.getByText("Q2 targets"));

    expect(
      screen.getAllByRole("checkbox", { checked: true }).length,
      "a ticked row is not readable as a checked checkbox",
    ).toBe(1);
    expect(screen.getAllByRole("checkbox", { checked: false })).toHaveLength(1);
  });

  it("unticks a row that is ticked, and the emptied answer names nothing", async () => {
    const onChange = vi.fn();
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(TWO_ROWS);
    render(<ListPickerRenderer {...makeProps({ onChange })} />);

    await waitFor(() => screen.getByText("Marketing directors"));
    fireEvent.click(screen.getByText("Marketing directors"));
    fireEvent.click(screen.getByText("Marketing directors"));

    expect(onChange).toHaveBeenLastCalledWith({
      scope: "list",
      listIds: [],
      listNames: [],
      listId: "",
      listName: "",
    });
    expect(chosen("Marketing directors")).toBe("false");
  });

  it("shows EVERY entry of a held answer ticked when the step is re-opened", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(TWO_ROWS);
    render(
      <ListPickerRenderer
        {...makeProps({
          value: {
            scope: "list",
            listIds: ["l1", "l2"],
            listNames: ["Marketing directors", "Q2 targets"],
            listId: "l1",
            listName: "Marketing directors",
          },
        })}
      />,
    );

    await waitFor(() => screen.getByText("Marketing directors"));
    expect(chosen("Marketing directors")).toBe("true");
    expect(chosen("Q2 targets")).toBe("true");
  });

  it("reads a one-identifier answer back as the one-entry set it is", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(TWO_ROWS);
    const onChange = vi.fn();
    render(
      <ListPickerRenderer
        {...makeProps({
          onChange,
          value: { scope: "list", listId: "l2", listName: "Q2 targets" },
        })}
      />,
    );

    await waitFor(() => screen.getByText("Q2 targets"));
    expect(chosen("Q2 targets")).toBe("true");
    expect(chosen("Marketing directors")).toBe("false");
    // And it ADDS to that held entry rather than replacing it.
    fireEvent.click(screen.getByText("Marketing directors"));
    expect(onChange).toHaveBeenLastCalledWith({
      scope: "list",
      listIds: ["l2", "l1"],
      listNames: ["Q2 targets", "Marketing directors"],
      listId: "l2",
      listName: "Q2 targets",
    });
  });

  it("carries no entry the live read no longer returns into the answer the reader makes", async () => {
    // A view deleted where the views live, since the step was answered, comes
    // back in the HELD answer and in no row: it is drawn nowhere, so the reader
    // can neither see it ticked nor tick it off. An answer they make now must
    // not carry a scope they were never shown (convergence round, cinatra#3562).
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(TWO_ROWS);
    const onChange = vi.fn();
    render(
      <ListPickerRenderer
        {...makeProps({
          onChange,
          value: {
            scope: "list",
            listIds: ["gone", "l1"],
            listNames: ["Deleted where the views live", "Marketing directors"],
            listId: "gone",
            listName: "Deleted where the views live",
          },
        })}
      />,
    );

    await waitFor(() => screen.getByText("Marketing directors"));
    expect(screen.queryByText("Deleted where the views live")).toBeNull();
    expect(chosen("Marketing directors")).toBe("true");
    fireEvent.click(screen.getByText("Q2 targets"));
    expect(onChange).toHaveBeenLastCalledWith({
      scope: "list",
      listIds: ["l1", "l2"],
      listNames: ["Marketing directors", "Q2 targets"],
      listId: "l1",
      listName: "Marketing directors",
    });
  });

  it("reads an identifier a held answer repeats as the ONE ticked entry it is", async () => {
    // A repeated identifier is one ticked entry however the answer was authored;
    // keeping it twice would carry a phantom entry into the next answer
    // (convergence round, cinatra#3562).
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(TWO_ROWS);
    const onChange = vi.fn();
    render(
      <ListPickerRenderer
        {...makeProps({
          onChange,
          value: {
            scope: "list",
            listIds: ["l1", "l1"],
            listNames: ["Marketing directors", "Marketing directors"],
            listId: "l1",
            listName: "Marketing directors",
          },
        })}
      />,
    );

    await waitFor(() => screen.getByText("Marketing directors"));
    expect(chosen("Marketing directors")).toBe("true");
    fireEvent.click(screen.getByText("Q2 targets"));
    expect(onChange).toHaveBeenLastCalledWith({
      scope: "list",
      listIds: ["l1", "l2"],
      listNames: ["Marketing directors", "Q2 targets"],
      listId: "l1",
      listName: "Marketing directors",
    });
  });

  it("prints no member count on a row — the reader contract returns none", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([
      {
        id: "l1",
        name: "Marketing directors",
        // What the live read actually hands the renderer: a Twenty view is
        // filter-defined, not materialized, so the contract's count is null.
        memberCount: null,
        lastUpdated: null,
        memberType: "contact" as const,
      },
    ]);
    const { container } = render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() => screen.getByText("Marketing directors"));
    const row = screen.getByText("Marketing directors").closest("[data-selected]")!;
    expect(row.textContent).not.toMatch(/\d+\s*contact/i);
    expect(row.textContent).not.toMatch(/null/i);
    // AND THE COUNT'S OWN WORDING IS GONE, not merely its number (convergence
    // round, cinatra#3562). The removed markup printed the contract's `null`
    // count beside the word — React draws that as " contact(s)", which carries
    // no digit and no "null", so a row that had it back would pass the two
    // readings above. The phrase is what pins the removal.
    expect(row.textContent).not.toMatch(/contact\(s\)/i);
    expect(container.textContent).not.toMatch(/\bmembers?\b/i);
  });
});

// ---------------------------------------------------------------------------
// cinatra#3050 — the renderer is the source of the run identity the loader
// authorizes against. Without it the loader has nothing to authorize and the
// old admin gate is the only thing left, which is what redirected a run's
// non-administrator owner to `/not-authorized` at this step.
// ---------------------------------------------------------------------------

describe("ListPickerRenderer — run identity (cinatra#3050)", () => {
  it("passes context.runId to fetchAvailableLists", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(
      <ListPickerRenderer
        {...makeProps({ context: { connectedApps: [], runId: "run-abc" } })}
      />,
    );

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );
    expect(actions.fetchAvailableLists).toHaveBeenCalledWith("run-abc");
  });

  it("re-loads when the run identity arrives after mount", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValue([]);
    const { rerender } = render(
      <ListPickerRenderer {...makeProps({ context: { connectedApps: [] } })} />,
    );

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );
    // No run identity yet: the loader is still called, and refuses server-side
    // with the hidden-run absence rather than being gated on a platform role.
    expect(actions.fetchAvailableLists).toHaveBeenNthCalledWith(1, "");

    rerender(
      <ListPickerRenderer
        {...makeProps({ context: { connectedApps: [], runId: "run-late" } })}
      />,
    );

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(2),
    );
    expect(actions.fetchAvailableLists).toHaveBeenNthCalledWith(2, "run-late");
  });
});


// ---------------------------------------------------------------------------
// THE RUN PARKS AT THIS STEP UNTIL A LIST EXISTS (cinatra#3358, acceptance 2).
//
// "A run started with no list does not walk past its review steps: it parks at
// the account-scope step until a list exists."
//
// THE MECHANISM, pinned rather than described. The answer this gate wants is a
// LIST, and the only thing in this renderer that emits one is a list's own row:
// `handleToggle` is reachable from nowhere else. So on a CRM with no contact
// view there is no row to tick, the step emits NO value, and the question the
// run is parked on stays unanswered — which is what keeps the run standing
// here. The step becomes answerable the moment an entry exists, and not before.
//
// AND NO LATER STEP IS STARTED while it stands there: a step the run has not
// reached is closed even when the page has a run detail to fall back on, read
// through the rail's own predicate rather than asserted about the DOM.
// ---------------------------------------------------------------------------
describe("the run parks at the account-scope step until a list exists (cinatra#3358)", () => {
  it("emits no answer while the CRM holds no view or list, so the gate stays unanswered", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const onChange = vi.fn();
    render(<ListPickerRenderer {...makeProps({ onChange })} />);

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    // The step says so in its own words, and offers nothing to answer with.
    await waitFor(() =>
      expect(screen.getByTestId("list-picker-empty-reading")).toBeTruthy(),
    );
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    // Nothing was emitted: the run has no value to walk past this step with.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("becomes answerable only once a list exists", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([
      {
        id: "list-9",
        name: "Marketing directors",
        memberCount: null,
        memberType: "contact",
        lastUpdated: null,
      },
    ]);
    const onChange = vi.fn();
    render(<ListPickerRenderer {...makeProps({ onChange })} />);

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    expect(screen.queryByTestId("list-picker-empty-reading")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Marketing directors"));
    expect(onChange).toHaveBeenCalledWith({
      scope: "list",
      listIds: ["list-9"],
      listNames: ["Marketing directors"],
      listId: "list-9",
      listName: "Marketing directors",
    });
  });

  it("leaves every later step closed while the run stands at this one", () => {
    const parked: RunSurfaceRailStep = {
      key: "gate",
      row: null,
      surface: "the account-scope step",
      reached: true,
    };
    const later: RunSurfaceRailStep = {
      key: "review",
      row: null,
      surface: "the review step",
      reached: false,
    };
    const detail = "the run detail";

    expect(isRunSurfaceStepSelectable(parked, detail)).toBe(true);
    expect(isRunSurfaceStepSelectable(later, detail)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE ROAD OUT OF THE STEP IS GONE, AND SO IS EVERYTHING THAT SERVED ONLY IT
// (cinatra#3562, acceptance 5).
//
// The criterion: the road's own test id, its binding param and its two return
// query keys are named nowhere under this tree's product code after this leg,
// while `agentPathScopeBase`, `buildAgentWorkspacePath`, `newRunLaunchOutcome`
// and `NEW_RUN_REFUSAL_FALLBACK` all remain — they serve other pages.
//
// Read off the two modules' OWN export surfaces, and off the gate's drawing,
// so the removal is pinned by what the tree offers rather than by a grep this
// suite would have to spell the removed names into.
// ---------------------------------------------------------------------------
describe("the road out of the step is removed (cinatra#3562)", () => {
  it("leaves the renderer module offering only the gate's own two exports", () => {
    expect(Object.keys(listPickerRendererModule).sort()).toEqual([
      "LIST_PICKER_QUESTION",
      "ListPickerRenderer",
    ]);
  });

  it("leaves the agent-path grammar with the scope-reading rules and nothing of the road", () => {
    expect(Object.keys(agentUrl).sort()).toEqual(
      [
        "AGENT_LAUNCH_SEGMENT",
        "AGENT_SETTINGS_SEGMENT",
        "RESERVED_AGENT_INSTANCE_SEGMENTS",
        "WORKSPACE_SCOPE_BASE",
        "agentPathScopeBase",
        "buildAgentInstancePath",
        "buildAgentPackageBasePath",
        "buildAgentSettingsPath",
        "buildAgentWorkspacePath",
        "isReservedAgentInstanceSegment",
      ].sort(),
    );
  });

  it("draws no link and no button anywhere on the gate, in either reading", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const { container, unmount } = render(<ListPickerRenderer {...makeProps()} />);
    await waitFor(() =>
      expect(screen.getByTestId("list-picker-empty-reading")).toBeTruthy(),
    );
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    unmount();

    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce(TWO_ROWS);
    const withRows = render(<ListPickerRenderer {...makeProps()} />);
    await waitFor(() => screen.getByText("Marketing directors"));
    expect(withRows.container.querySelectorAll("a")).toHaveLength(0);
  });
});
