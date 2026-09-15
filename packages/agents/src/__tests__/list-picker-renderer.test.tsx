// @vitest-environment jsdom
/**
 * Unit tests for ListPickerRenderer.
 *
 * Locks the renderer contract:
 *   - Mount renders the step's question heading (no "Create new list" CTA, and
 *     no search field — the drawing gives the gate neither).
 *   - Lists from fetchAvailableLists() render as clickable cards with name +
 *     member count + memberType badge.
 *   - Clicking a card calls onChange with the canonical
 *     { scope: "list", listId, listName, memberCount } shape.
 *   - The zero-content reading is the drawn Empty pattern.
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

// THE ROUTE'S OWN PATHNAME, which the renderer reads instead of the window so
// the server's first paint and the client's hydration mint the SAME href. It
// answers null by default here — no route context, exactly as a bare render has
// none — which is when the renderer falls back to the window reading every test
// below sets through `history.replaceState`.
const routeHarness = vi.hoisted(() => ({ pathname: null as string | null }));
vi.mock("next/navigation", () => ({
  usePathname: () => routeHarness.pathname,
}));

import {
  ListPickerRenderer,
  declaredListBuilderPackage,
  LIST_BUILDER_PACKAGE_PARAM,
} from "../list-picker-renderer";
import * as actions from "../list-picker-actions";
import type { FieldRendererProps } from "../field-renderer-registry";
import {
  isRunSurfaceStepSelectable,
  type RunSurfaceRailStep,
} from "../run-surface-rail-step";
import { GENERATED_FIELD_RENDERER_BINDINGS } from "@/lib/generated/agent-bindings";

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
    // WHAT THE BINDING DECLARES ITS MAKE-ONE ROAD LEADS TO. The host tree
    // names no pack (the core/extension border); the binding that raised this
    // gate declares the agent that builds a list, and these tests declare the
    // one measured on the development boot.
    bindingParams: { listBuilderPackage: "@cinatra-ai/list-curator-agent" },
    ...overrides,
  };
}

// WHERE THE STEP IS PARKED, which is what the offered road is addressed from
// (cinatra#2809). Every test that does not say otherwise runs from a run parked
// under the workspace scope, and the address is put back after each test so no
// file downstream inherits this one's location.
const PARKED_AT = "/workspace/agents/cinatra-ai/outreach-agent/run-1";
let originalHref = "";

beforeEach(() => {
  vi.clearAllMocks();
  routeHarness.pathname = null;
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
    // family; list creation flows through the list-curator-agent CTA below.
    expect(
      screen.queryByRole("link", { name: /create new list/i }),
    ).toBeNull();
    // AND THE SEARCH FIELD IS GONE (cinatra#3358). The gate that lists is drawn
    // in Agent run & review §I.1 as rows, a make-one road and a Continue — it is
    // given no search field, so the step no longer draws one. Pinned in
    // list-picker-gate-drawn.test.tsx.
    expect(screen.queryByPlaceholderText(/search lists/i)).toBeNull();
    expect(screen.getByTestId("list-picker-question")).toBeTruthy();
  });

  // cinatra#3358 — THE OFFERED ROAD CARRIES ITS RETURN. The CTA used to name
  // the offering step (`onComplete=list-picker`) and nothing else, so the run
  // it starts had no way to know which run was parked at this step. It now
  // carries THIS run's identity beside the name, which is what the generic
  // new-run launcher forwards onto the run it creates.
  it("renders 'Build a list with AI' CTA deep-linking to list-curator-agent with this run as the return", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    const cta = screen.getByTestId("build-list-with-ai-cta");
    expect(cta).toBeTruthy();
    expect(cta.getAttribute("href")).toBe(
      "/workspace/agents/cinatra-ai/list-curator-agent/new" +
        "?onComplete=list-picker&onCompleteRunId=run-1",
    );
    expect(cta.textContent?.toLowerCase()).toContain("build a list with ai");
  });

  it("offers the bare road when the step has no run identity in hand", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(
      <ListPickerRenderer {...makeProps({ context: { connectedApps: [] } })} />,
    );

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    const cta = screen.getByTestId("build-list-with-ai-cta");
    expect(cta.getAttribute("href")).toBe(
      "/workspace/agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker",
    );
  });

  // cinatra#2809 + cinatra#3358 — THE ROAD IS ADDRESSED AT THE SCOPE THE PARKED
  // RUN BELONGS TO. Measured on a development boot with both packages
  // installed: the bare `/agents/{vendor}/{package}/new` answered 200 with the
  // crumb "Agents / New" and created no run, while the same address under a
  // scope base answered 307 to a fresh run carrying the completion contract
  // through. So the offered road is built from the parked run's OWN address,
  // and a run parked in an organization offers that organization's launcher —
  // never another scope's, and never the bare road that answers nothing.
  it("addresses the road at the scope the parked run belongs to", async () => {
    window.history.replaceState(
      null,
      "",
      "/organizations/org-7/agents/cinatra-ai/outreach-agent/run-1",
    );
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    expect(
      screen.getByTestId("build-list-with-ai-cta").getAttribute("href"),
    ).toBe(
      "/organizations/org-7/agents/cinatra-ai/list-curator-agent/new" +
        "?onComplete=list-picker&onCompleteRunId=run-1",
    );
  });

  it("offers the workspace launcher for a run parked on the scopeless tree", async () => {
    window.history.replaceState(
      null,
      "",
      "/agents/cinatra-ai/outreach-agent/run-1",
    );
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    expect(
      screen.getByTestId("build-list-with-ai-cta").getAttribute("href"),
    ).toBe(
      "/workspace/agents/cinatra-ai/list-curator-agent/new" +
        "?onComplete=list-picker&onCompleteRunId=run-1",
    );
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

  // THE SEARCH FILTER IS RETIRED (cinatra#3358). It was a client-side filter on
  // a field the ratified drawing does not give this gate; the rows are the whole
  // page (Agent run & review §I.1). Nothing replaces it here.

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
// `handleSelect` is reachable from nowhere else. So on an account with no lists
// there is no row to press, the step emits NO value, and the question the run is
// parked on stays unanswered — which is what keeps the run standing here. The
// step becomes answerable the moment a list exists, and not before.
//
// AND NO LATER STEP IS STARTED while it stands there: a step the run has not
// reached is closed even when the page has a run detail to fall back on, read
// through the rail's own predicate rather than asserted about the DOM.
// ---------------------------------------------------------------------------
describe("the run parks at the account-scope step until a list exists (cinatra#3358)", () => {
  it("emits no answer while the account has no list, so the gate stays unanswered", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    const onChange = vi.fn();
    render(<ListPickerRenderer {...makeProps({ onChange })} />);

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    // The step says so in its own words, and offers nothing to answer with.
    await waitFor(() =>
      expect(screen.getByText(/no lists yet/i)).toBeTruthy(),
    );
    expect(screen.queryAllByRole("button", { pressed: false })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
    // Nothing was emitted: the run has no value to walk past this step with.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("becomes answerable only once a list exists", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([
      {
        id: "list-9",
        name: "Marketing directors",
        memberCount: 5,
        memberType: "contact",
        lastUpdated: null,
      },
    ]);
    const onChange = vi.fn();
    render(<ListPickerRenderer {...makeProps({ onChange })} />);

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    expect(screen.queryByText(/no lists yet/i)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Marketing directors"));
    expect(onChange).toHaveBeenCalledWith({
      scope: "list",
      listId: "list-9",
      listName: "Marketing directors",
      memberCount: 5,
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
// THE ROAD FOLLOWS A DECLARATION, NEVER AN IDENTITY (the core/extension
// border). Host/core product code may carry the road's grammar — the scope,
// the launch segment, the completion contract — but never the identity of a
// pack. The binding that raised this gate declares which agent builds a list,
// through the pinned per-binding params contract, and the step mints the road
// from that declaration.
// ---------------------------------------------------------------------------
describe("the make-one road's destination is declared by the binding", () => {
  it("mints the road for whatever package the binding declares", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(
      <ListPickerRenderer
        {...makeProps({
          bindingParams: { listBuilderPackage: "@another-vendor/list-builder" },
        })}
      />,
    );

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    expect(
      screen.getByTestId("build-list-with-ai-cta").getAttribute("href"),
    ).toBe(
      "/workspace/agents/another-vendor/list-builder/new" +
        "?onComplete=list-picker&onCompleteRunId=run-1",
    );
  });

  it("takes the scope off the ROUTE, which is the same string on both sides", async () => {
    // A client component is rendered on the server for the first paint, where no
    // window exists: a window reading minted the workspace base there and the
    // run's real base on hydration — two hrefs for one link. The route's own
    // pathname is what both sides hold, so it is what the road is cut from, and
    // it WINS over whatever the window happens to say.
    routeHarness.pathname = "/organizations/org-7/agents/cinatra-ai/outreach-agent/run-1";
    window.history.replaceState(null, "", "/workspace/agents/cinatra-ai/outreach-agent/run-1");
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps()} />);

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    expect(
      screen.getByTestId("build-list-with-ai-cta").getAttribute("href"),
    ).toBe(
      "/organizations/org-7/agents/cinatra-ai/list-curator-agent/new" +
        "?onComplete=list-picker&onCompleteRunId=run-1",
    );
  });

  it("offers NO road when the binding declares no list builder", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(<ListPickerRenderer {...makeProps({ bindingParams: undefined })} />);

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    // An absent road is the honest reading: a road the host addressed at a
    // package it guessed is exactly the dead end this step used to offer.
    expect(screen.queryByTestId("build-list-with-ai-cta")).toBeNull();
  });

  it("offers no road for a declaration that is not a scoped package name", async () => {
    vi.mocked(actions.fetchAvailableLists).mockResolvedValueOnce([]);
    render(
      <ListPickerRenderer
        {...makeProps({ bindingParams: { listBuilderPackage: "   " } })}
      />,
    );

    await waitFor(() =>
      expect(actions.fetchAvailableLists).toHaveBeenCalledTimes(1),
    );

    expect(screen.queryByTestId("build-list-with-ai-cta")).toBeNull();
  });
});

describe("declaredListBuilderPackage — runtime data never breaks the host", () => {
  it("reads a scoped package name out of the binding's params", () => {
    expect(
      declaredListBuilderPackage({
        [LIST_BUILDER_PACKAGE_PARAM]: "@cinatra-ai/list-curator-agent",
      }),
    ).toBe("@cinatra-ai/list-curator-agent");
  });

  it("degrades to no road on an absent or malformed declaration", () => {
    expect(declaredListBuilderPackage(undefined)).toBeNull();
    expect(declaredListBuilderPackage({})).toBeNull();
    expect(declaredListBuilderPackage({ [LIST_BUILDER_PACKAGE_PARAM]: 7 })).toBeNull();
    expect(
      declaredListBuilderPackage({ [LIST_BUILDER_PACKAGE_PARAM]: "not-a-package" }),
    ).toBeNull();
    expect(
      declaredListBuilderPackage({ [LIST_BUILDER_PACKAGE_PARAM]: "@vendor/pkg/extra" }),
    ).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// WHAT THE PINNED TREE DECLARES. `declaredListBuilderPackage` is proved above
// against fixtures; this block reads the generated binding table the host
// actually ships and pins that the declaration is THERE — the pin advance is
// what puts it there, and without it the road above never reaches a reader.
// ---------------------------------------------------------------------------
describe("the pinned list-picker binding declares the list builder", () => {
  it("reads the list builder out of the generated binding's own params", () => {
    const binding = GENERATED_FIELD_RENDERER_BINDINGS.find(
      (b) => b.id === "@cinatra-ai/email-outreach-agent:list-picker",
    );
    expect(binding, "the host declares no list-picker binding").toBeTruthy();
    expect(
      declaredListBuilderPackage(binding!.params),
      "the pinned binding declares no list builder",
    ).toBe("@cinatra-ai/list-curator-agent");
    expect(binding!.params?.[LIST_BUILDER_PACKAGE_PARAM]).toBe(
      "@cinatra-ai/list-curator-agent",
    );
  });

  // The filter is deliberately KIND-AGNOSTIC: the reading this pins is "the
  // param appears once in the whole generated table", so the sweep is the
  // whole table and the kind of the one row that carries it is asserted here
  // rather than assumed by a narrower filter.
  it("declares it on exactly one generated binding, anywhere in the table", () => {
    const declaring = GENERATED_FIELD_RENDERER_BINDINGS.filter(
      (b) => b.params?.[LIST_BUILDER_PACKAGE_PARAM] !== undefined,
    );
    expect(declaring.map((b) => b.id)).toEqual([
      "@cinatra-ai/email-outreach-agent:list-picker",
    ]);
    expect(declaring[0]?.kind).toBe("list-picker");
  });
});
