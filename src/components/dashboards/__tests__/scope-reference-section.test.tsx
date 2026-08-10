// @vitest-environment jsdom
//
// What renders BELOW the search field in "Reference an existing dashboard"
// (owner review on cinatra#2474 PR5, PR #2638).
//
// The owner saw grey placeholder blocks under the field and asked for them to
// go: "only show actually selected dashboards". This file is the render proof of
// exactly that rule, in the three cases that used to paint something:
//
//   - while the candidate pool loads      → ZERO cards
//   - when the pool comes back empty      → ZERO cards
//   - when the search matches nothing     → ZERO cards
//   - N listable dashboards               → exactly N rows, and nothing else
//
// It also pins the two things the removal must NOT cost: §IX.1's closed
// data-state set (empty · error · loading) is still readable off the section
// root, and a load FAILURE still says so in words instead of silently reading as
// "you have none".
//
//   pnpm exec vitest run src/components/dashboards/__tests__/scope-reference-section.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { ScopeReferenceSection } from "@/components/dashboards/scope-reference-section";
import type {
  AddPickerCandidateView,
  ScopeReferenceSource,
} from "@/components/dashboards/scope-dashboards-contract";

const candidate = (
  id: string,
  name: string,
  over: Partial<AddPickerCandidateView> = {},
): AddPickerCandidateView => ({
  dashboardId: id,
  name,
  homeNote: "the team can already see this",
  disposition: "addable",
  ...over,
});

function source(
  listCandidates: ScopeReferenceSource["listCandidates"],
): ScopeReferenceSource {
  return {
    listCandidates,
    addListing: vi.fn(async () => ({ ok: true as const })),
    requestPromotion: vi.fn(async () => ({ ok: true as const })),
  };
}

function mount(src: ScopeReferenceSource) {
  return render(<ScopeReferenceSection source={src} onAdded={vi.fn()} />);
}

/** The section root — the one element §IX.1's data-state now rides. */
const root = (container: HTMLElement) =>
  container.querySelector(
    '[data-conformance-id="scope-dashboards-add-picker"]',
  ) as HTMLElement;

/**
 * Everything the section paints below the search field. A "card" here is any
 * element the section draws in the column under the input — a list, a panel, a
 * skeleton block — so the count is honest about ANY placeholder coming back,
 * not just the two shapes that were removed.
 */
const cardsBelowField = (container: HTMLElement) => {
  const children = [...root(container).children];
  // children[0] is the search field wrapper; anything after it is content.
  return children.slice(1);
};

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll("li")] as HTMLElement[];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("only actually-listable dashboards render below the field (PR #2638)", () => {
  it("renders ZERO cards while the candidate pool is still loading", () => {
    // A promise that never settles — the exact state the owner's screenshot
    // caught, where two grey skeleton blocks used to sit.
    const pending: ScopeReferenceSource["listCandidates"] = vi.fn(
      () => new Promise<readonly AddPickerCandidateView[] | null>(() => {}),
    );
    const { container } = mount(source(pending));

    expect(screen.getByLabelText("Search your dashboards")).toBeTruthy();
    expect(cardsBelowField(container)).toHaveLength(0);
    expect(rows(container)).toHaveLength(0);
    expect(container.querySelectorAll("ul")).toHaveLength(0);
    // …and the state is still readable, just not painted.
    expect(root(container).getAttribute("data-state")).toBe("loading");
  });

  it("renders ZERO cards when the actor has no listable dashboards", async () => {
    const { container } = mount(source(vi.fn(async () => [])));

    await waitFor(() =>
      expect(root(container).getAttribute("data-state")).toBe("empty"),
    );
    expect(cardsBelowField(container)).toHaveLength(0);
    expect(rows(container)).toHaveLength(0);
    // No dashed "nothing here" panel came back in another shape.
    expect(container.querySelector(".border-dashed")).toBeNull();
  });

  it("renders exactly N rows for N listable dashboards, and nothing besides", async () => {
    const { container } = mount(
      source(
        vi.fn(async () => [
          candidate("d-1", "Pipeline health"),
          candidate("d-2", "Revenue"),
          candidate("d-3", "Personal experiments", {
            disposition: "promotion",
            promotionLabel: "Request team visibility…",
          }),
        ]),
      ),
    );

    expect(await screen.findByText("Pipeline health")).toBeTruthy();
    await waitFor(() => expect(rows(container)).toHaveLength(3));
    expect(screen.getByText("Revenue")).toBeTruthy();
    expect(screen.getByText("Personal experiments")).toBeTruthy();
    // Exactly one thing below the field: the list. No placeholder alongside it.
    expect(cardsBelowField(container)).toHaveLength(1);
    expect(cardsBelowField(container)[0].tagName).toBe("UL");
    // Populated ⇒ no state attribute (the spec names none for this case).
    expect(root(container).getAttribute("data-state")).toBeNull();
  });

  it("narrowing the search to nothing empties the column instead of showing a card", async () => {
    const { container } = mount(
      source(vi.fn(async () => [candidate("d-1", "Pipeline health")])),
    );
    await waitFor(() => expect(rows(container)).toHaveLength(1));

    fireEvent.change(screen.getByLabelText("Search your dashboards"), {
      target: { value: "zzzz" },
    });

    await waitFor(() => expect(rows(container)).toHaveLength(0));
    expect(cardsBelowField(container)).toHaveLength(0);
    expect(root(container).getAttribute("data-state")).toBe("empty");

    // …and narrowing back brings the real row back, so this is a filter, not a
    // one-way collapse.
    fireEvent.change(screen.getByLabelText("Search your dashboards"), {
      target: { value: "pipe" },
    });
    await waitFor(() => expect(rows(container)).toHaveLength(1));
  });

  it("a FAILED load still says so — in words, not as a card", async () => {
    const { container } = mount(source(vi.fn(async () => null)));

    expect(await screen.findByText("Couldn’t load your dashboards")).toBeTruthy();
    expect(root(container).getAttribute("data-state")).toBe("error");
    // One line of text, and no list of dashboards implying an answer we do not
    // have.
    expect(rows(container)).toHaveLength(0);
    expect(cardsBelowField(container)).toHaveLength(1);
    expect(cardsBelowField(container)[0].tagName).toBe("P");
  });
});
