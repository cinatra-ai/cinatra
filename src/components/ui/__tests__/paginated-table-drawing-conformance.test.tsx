// @vitest-environment jsdom
//
// PaginatedTable — the graded checklist for the clauses the components
// drawing's "Table" and "Pagination" sections state for this component
// (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/paginated-table-drawing-conformance.test.tsx
//
// The clauses this primitive is answerable for, quoted verbatim:
//
//   "PaginatedTable pages by offset only; it has no sort and no row selection;
//    Table is the dumb DOM primitive."
//   "Always pair with a 'X of N' caption in mono slate."
//   "prev/next chevrons"
//
// NO DEPARTURE FOUND. Every chrome clause of the "Table" section (header mono
// 10px 700 uppercase, the navy underline, cell padding) is carried by the
// Table primitive this component composes and is graded in
// table-drawing-conformance.test.tsx — including the cell-padding departure
// recorded there.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { PaginatedTable } from "@/components/ui/paginated-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

afterEach(cleanup);

// `pageSize={1}` against two rows is what puts the component over its own
// `rowCount > pageSize` threshold, which is the only condition under which it
// pages at all.
function renderPaginated(pageSize = 1) {
  const { container } = render(
    <PaginatedTable pageSize={pageSize}>
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Started</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Outreach #2,318</TableCell>
          <TableCell>14:21</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Enricher #2,317</TableCell>
          <TableCell>14:08</TableCell>
        </TableRow>
      </TableBody>
    </PaginatedTable>,
  );
  return {
    container,
    frame: container.querySelector('[data-slot="table-frame"]') as HTMLElement,
    footer: container.querySelector(
      '[data-slot="table-pagination"]',
    ) as HTMLElement | null,
  };
}

describe('clause: "PaginatedTable pages by offset only"', () => {
  it("renders the paging controls the plain Table does not have", () => {
    const { footer } = renderPaginated();
    expect(footer).not.toBeNull();
    expect(footer!.querySelector('[data-slot="pagination-link"]')).not.toBeNull();
  });

  it("pages only when there are more rows than fit, never on a short list", () => {
    // A pager under a two-row table is noise; the component decides this
    // itself rather than leaving it to the call site.
    const { footer } = renderPaginated(25);
    expect(footer).toBeNull();
  });

  it("shows one offset slice of the rows at a time, and the next control moves to the next slice", () => {
    const { container, footer } = renderPaginated();
    const rows = () =>
      Array.from(
        container.querySelectorAll<HTMLTableRowElement>(
          '[data-slot="table-body"] > [data-slot="table-row"]',
        ),
      );
    expect(rows()).toHaveLength(2);
    expect(rows().map((row) => row.hidden)).toEqual([false, true]);
    expect(footer!.textContent).toContain("1–1 of 2");

    fireEvent.click(footer!.querySelector('[aria-label="Go to next page"]')!);

    expect(rows().map((row) => row.hidden)).toEqual([true, false]);
    expect(
      container.querySelector('[data-slot="table-pagination"]')!.textContent,
    ).toContain("2–2 of 2");
  });
});

describe('clause: "Table is the dumb DOM primitive"', () => {
  it("composes the shared Table rather than re-implementing its markup", () => {
    // The clause splits the two components' jobs: the chrome belongs to Table.
    // If PaginatedTable emitted its own markup, every Table clause would need
    // grading twice and would drift.
    const { container } = renderPaginated();
    expect(container.querySelector('[data-slot="table"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="table-head"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="table-cell"]')).not.toBeNull();
  });

  it("keeps the header chrome the Table primitive draws, unmodified", () => {
    const { container } = renderPaginated();
    const head = container.querySelector('[data-slot="table-head"]') as HTMLElement;
    expect(head.className).toContain("font-mono");
    expect(head.className).toContain("uppercase");
  });
});

describe('clause: "Always pair with a \'X of N\' caption in mono slate"', () => {
  it("renders the caption in mono, in the muted slate", () => {
    const { footer } = renderPaginated();
    expect(footer!.className).toContain("font-mono");
    expect(footer!.className).toContain("text-muted-foreground");
  });

  it("sets the caption at the 11px step the drawing gives mono metadata", () => {
    // The "Table" section's own clause for mono metadata is "IDs/times mono
    // 11px slate"; the caption is the same class of content.
    expect(renderPaginated().footer!.className).toContain("text-[11px]");
  });

  it("states the visible range against the total, which is what 'X of N' means", () => {
    const { footer } = renderPaginated();
    expect(footer!.textContent).toMatch(/\bof\b/);
    expect(footer!.textContent).toMatch(/2/);
  });
});

describe('clause: "prev/next chevrons"', () => {
  it("offers a step control in each direction", () => {
    const { footer } = renderPaginated();
    expect(
      footer!.querySelector('[aria-label="Go to previous page"]'),
    ).not.toBeNull();
    expect(footer!.querySelector('[aria-label="Go to next page"]')).not.toBeNull();
  });
});

describe("the composed surface reads as one panel", () => {
  it("wraps the table and its footer in a single bordered, rounded container", () => {
    const { frame } = renderPaginated();
    expect(frame.className).toContain("rounded-md");
    expect(frame.className).toContain("border");
    expect(frame.className).toContain("overflow-hidden");
  });

  it("rules the footer off from the rows with the row hairline", () => {
    const { footer } = renderPaginated();
    expect(footer!.className).toContain("border-t");
    expect(footer!.className).toContain("border-line");
  });
});

// The two clauses below deny a behaviour, so each is read in both states the
// component has: paging (more rows than fit) and not paging (a short list).
const BOTH_STATES = [
  { state: "paging", pageSize: 1 },
  { state: "not paging", pageSize: 25 },
] as const;

describe('clause: "it has no sort"', () => {
  it.each(BOTH_STATES)(
    "draws no sort state or sort control, and a header click leaves the row order as given ($state)",
    ({ pageSize }) => {
      // Sort belongs to the call site: the component owns no sort state, so it
      // marks no element with aria-sort, puts no control into a header cell and
      // does not reorder the rows the call site passes.
      const { container } = renderPaginated(pageSize);
      const bodyText = () =>
        Array.from(
          container.querySelectorAll(
            '[data-slot="table-body"] > [data-slot="table-row"]',
          ),
        ).map((row) => row.textContent);
      const given = ["Outreach #2,31814:21", "Enricher #2,31714:08"];
      expect(bodyText()).toEqual(given);

      expect(container.querySelectorAll("[aria-sort]")).toHaveLength(0);
      const heads = Array.from(
        container.querySelectorAll('[data-slot="table-head"]'),
      );
      expect(heads).toHaveLength(2);
      for (const head of heads) {
        expect(head.querySelector('button, a, [role="button"]')).toBeNull();
      }

      // The order is read after each click: a two-state sort would reorder
      // the rows on the first click and restore them on the second.
      fireEvent.click(heads[0]);
      expect(bodyText()).toEqual(given);
      expect(container.querySelectorAll("[aria-sort]")).toHaveLength(0);

      fireEvent.click(heads[0]);
      expect(bodyText()).toEqual(given);
      expect(container.querySelectorAll("[aria-sort]")).toHaveLength(0);
    },
  );
});

describe('clause: "and no row selection"', () => {
  it.each(BOTH_STATES)(
    "draws no selection column or selection state, and a row click selects nothing ($state)",
    ({ pageSize }) => {
      // Selection belongs to the call site: the component adds no selection
      // column, marks no row or table as selectable, and a click on a row
      // leaves it unselected.
      const { container } = renderPaginated(pageSize);
      const selectionMarks =
        'input[type="checkbox"], [role="checkbox"], [aria-selected], [aria-multiselectable]';

      expect(container.querySelectorAll(selectionMarks)).toHaveLength(0);
      const rows = Array.from(
        container.querySelectorAll('[data-slot="table-row"]'),
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.children).toHaveLength(2);
      }

      const firstBodyRow = container.querySelector(
        '[data-slot="table-body"] > [data-slot="table-row"]',
      ) as HTMLElement;
      fireEvent.click(firstBodyRow);

      expect(firstBodyRow.getAttribute("data-state")).toBeNull();
      expect(container.querySelectorAll(selectionMarks)).toHaveLength(0);
    },
  );
});
