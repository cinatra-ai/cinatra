// @vitest-environment jsdom
//
// Behavioural jsdom tests for EntitySearchCombobox (cinatra#1509 §4.0-b),
// locking the three codex merge-review findings on the shared typeahead:
//
//  1. KEYBOARD/A11Y (§3.4): focus lives in the anchoring Input, so the Input is
//     the combobox — ArrowDown moves cmdk's active row (forwarded key events),
//     Enter selects it (onPick fires), aria-expanded / aria-controls /
//     aria-activedescendant track the popup, and Escape closes while focus
//     stays in the Input.
//  2. STALE PAGINATION: a second-page response that resolves AFTER the query
//     changed is dropped (epoch guard) — it must never merge into the new
//     query's results.
//  3. OPEN-ONLY CLICK: clicking back into an OPEN input (placing the caret)
//     keeps the list open; close is Escape / outside click / selection.
//
// Renders the REAL component (real cmdk + Radix under the shims), mirroring
// access-combobox-hierarchical-multi-open.test.tsx.
//
//   pnpm exec vitest run \
//     src/components/__tests__/entity-search-combobox-interaction.test.tsx

import "./access-picker-jsdom-shims";
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  EntitySearchCombobox,
  type EntitySearchResult,
  type EntitySearchItem,
} from "@/components/entity-search-combobox";

const USERS: EntitySearchItem[] = [
  { id: "u-ada", name: "Ada Lovelace", secondary: "ada@example.com" },
  { id: "u-ben", name: "Ben Cortado", secondary: "ben@example.com" },
];

afterEach(() => cleanup());

describe("EntitySearchCombobox keyboard + a11y (§3.4)", () => {
  it("ArrowDown moves the active row, Enter picks it, a11y attributes track", async () => {
    const onSearch = vi.fn(async () => ({ results: USERS }));
    const onPick = vi.fn();
    render(<EntitySearchCombobox onSearch={onSearch} onPick={onPick} />);

    const input = screen.getByRole("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");

    // Open via click; the 0 ms on-open search resolves the first page.
    fireEvent.click(input);
    await screen.findByText("Ada Lovelace");
    expect(input.getAttribute("aria-expanded")).toBe("true");

    // aria-controls names cmdk's listbox.
    const listbox = screen.getByRole("listbox");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);

    // cmdk auto-selects the first row on open; the bridge mirrors its DOM id
    // onto the input (selected-row visibility on open).
    await act(async () => {}); // flush the bridge's attribute-sync effect
    const firstActive = input.getAttribute("aria-activedescendant");
    expect(firstActive).toBeTruthy();
    expect(document.getElementById(firstActive!)?.textContent).toContain("Ada Lovelace");

    // ArrowDown on the INPUT moves cmdk's active row to the second option.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await act(async () => {});
    const secondActive = input.getAttribute("aria-activedescendant");
    expect(secondActive).toBeTruthy();
    expect(secondActive).not.toBe(firstActive);
    expect(document.getElementById(secondActive!)?.textContent).toContain("Ben Cortado");

    // Enter selects the ACTIVE row.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(USERS[1]);
  });

  it("ArrowDown on a CLOSED input opens the list; Escape closes and focus stays in the input", async () => {
    const onSearch = vi.fn(async () => ({ results: USERS }));
    render(<EntitySearchCombobox onSearch={onSearch} onPick={() => {}} />);

    const input = screen.getByRole("combobox");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await screen.findByText("Ada Lovelace");
    expect(input.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    // Focus never left the anchoring input (§3.4 focus return).
    expect(document.activeElement).toBe(input);
  });
});

describe("EntitySearchCombobox open-only click (finding 3)", () => {
  it("clicking back into the OPEN input (caret placement) keeps the list open", async () => {
    const onSearch = vi.fn(async () => ({ results: USERS }));
    render(<EntitySearchCombobox onSearch={onSearch} onPick={() => {}} />);

    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    await screen.findByText("Ada Lovelace");
    expect(input.getAttribute("aria-expanded")).toBe("true");

    // The regression: this second click used to TOGGLE the popover closed.
    fireEvent.click(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });
});

describe("EntitySearchCombobox stale pagination guard (finding 2)", () => {
  it("drops a second-page response that resolves after the query changed", async () => {
    let resolvePage2: ((r: EntitySearchResult<EntitySearchItem>) => void) | null = null;
    const onSearch = vi.fn(
      (query: string, page: { offset: number; limit: number }) => {
        if (page.offset > 0) {
          // The lazy second page: deferred so the test controls when it lands.
          return new Promise<EntitySearchResult<EntitySearchItem>>((resolve) => {
            resolvePage2 = resolve;
          });
        }
        return Promise.resolve<EntitySearchResult<EntitySearchItem>>({
          results: [USERS[0]],
          hasMore: true,
        });
      },
    );
    render(<EntitySearchCombobox onSearch={onSearch} onPick={() => {}} />);

    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    await screen.findByText("Ada Lovelace");

    // Scroll the listbox to the bottom → the page-2 request starts (jsdom has
    // no layout, so scrollHeight/scrollTop/clientHeight are all 0 and the
    // 64px-from-bottom trigger fires).
    fireEvent.scroll(screen.getByRole("listbox"));
    expect(onSearch).toHaveBeenCalledWith("", { offset: 1, limit: 20 });
    expect(resolvePage2).not.toBeNull();

    // The query changes BEFORE page 2 lands → new results generation.
    fireEvent.change(input, { target: { value: "ben" } });

    // The stale page resolves now — it must be DROPPED, not merged.
    await act(async () => {
      resolvePage2!({ results: [{ id: "u-stale", name: "Stale Straggler" }], hasMore: false });
    });
    expect(screen.queryByText("Stale Straggler")).toBeNull();
    // The pre-change first page is still what's shown (the new query's search
    // is still inside its 300 ms debounce).
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });

  it("drops a second-page response that resolves after the popover closed", async () => {
    let resolvePage2: ((r: EntitySearchResult<EntitySearchItem>) => void) | null = null;
    const onSearch = vi.fn(
      (_query: string, page: { offset: number; limit: number }) => {
        if (page.offset > 0) {
          return new Promise<EntitySearchResult<EntitySearchItem>>((resolve) => {
            resolvePage2 = resolve;
          });
        }
        return Promise.resolve<EntitySearchResult<EntitySearchItem>>({
          results: [USERS[0]],
          hasMore: true,
        });
      },
    );
    render(<EntitySearchCombobox onSearch={onSearch} onPick={() => {}} />);

    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    await screen.findByText("Ada Lovelace");
    fireEvent.scroll(screen.getByRole("listbox"));
    expect(resolvePage2).not.toBeNull();

    // Close while page 2 is in flight, then let it land.
    fireEvent.keyDown(input, { key: "Escape" });
    await act(async () => {
      resolvePage2!({ results: [{ id: "u-stale", name: "Stale Straggler" }], hasMore: false });
    });
    expect(screen.queryByText("Stale Straggler")).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });
});
