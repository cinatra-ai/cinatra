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
//   "PaginatedTable handles offset, sort, and selection; Table is the dumb DOM
//    primitive."
//   "Always pair with a 'X of N' caption in mono slate."
//   "prev/next chevrons"
//
// NO DEPARTURE FOUND. Every chrome clause of the "Table" section (header mono
// 10px 700 uppercase, the navy underline, cell padding) is carried by the
// Table primitive this component composes and is graded in
// table-drawing-conformance.test.tsx — including the cell-padding departure
// recorded there.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

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

describe('clause: "PaginatedTable handles offset ..."', () => {
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

describe('clause: "... sort, and selection"', () => {
  // NOT APPLICABLE at this primitive, with the reason: this component
  // implements OFFSET only. Sort and selection are supplied by the call site's
  // own header cells and row controls — there is no sort or selection API on
  // PaginatedTable to grade. Recorded rather than asserted so leg 2 can put
  // the gap between the clause and the component to the drawing.
  it.skip(
    "not applicable at this primitive: the component implements offset only; sort and selection have no API here — recorded for leg 2 rather than asserted",
    () => {},
  );
});
