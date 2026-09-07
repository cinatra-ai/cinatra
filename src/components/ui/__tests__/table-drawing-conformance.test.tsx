// @vitest-environment jsdom
//
// Table — the graded checklist for the components drawing's "Table" section
// (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/table-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "header mono 10px 700 uppercase"
//   "body 13-14px ink"
//   "IDs/times mono 11px slate"
//   "cell padding 10-14px"
//   "PaginatedTable handles offset, sort, and selection; Table is the dumb DOM
//    primitive. Headers always uppercase mono with the navy underline; never
//    centre body cells; right-align numerics and timestamps."
//
// ONE DEPARTURE RECORDED, NOT FIXED — table is beyond the first ten rows of
// the issue's table, so this leg records it with a visibly failing assertion
// and names the follow-up. See the `RECORDED DEPARTURE` block.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

afterEach(cleanup);

function renderTable() {
  const { container } = render(
    <Table>
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
      </TableBody>
    </Table>,
  );
  return {
    header: container.querySelector('[data-slot="table-header"]') as HTMLElement,
    head: container.querySelector('[data-slot="table-head"]') as HTMLElement,
    cell: container.querySelector('[data-slot="table-cell"]') as HTMLElement,
    row: container.querySelector(
      '[data-slot="table-body"] [data-slot="table-row"]',
    ) as HTMLElement,
  };
}

describe('clause: "header mono 10px 700 uppercase" / "Headers always uppercase mono"', () => {
  it("sets the header cell in mono at 10px, weight 700, uppercased", () => {
    const { head } = renderTable();
    expect(head.className).toContain("font-mono");
    expect(head.className).toContain("text-[10px]");
    expect(head.className).toContain("font-bold");
    expect(head.className).toContain("uppercase");
  });

  it("tracks the header out, which is what makes 10px uppercase mono legible", () => {
    expect(renderTable().head.className).toContain("tracking-[0.18em]");
  });
});

describe('clause: "with the navy underline"', () => {
  it("rules the header off with the SOLID navy hairline, not the low-alpha row line", () => {
    // --line-strong is the solid navy; --line (via `border-border`) is the
    // 14%-alpha row hairline used between body rows. The clause names navy.
    const { header } = renderTable();
    expect(header.className).toContain("border-line-strong");
  });
});

describe('clause: "never centre body cells"', () => {
  it("leaves body cells at the default start alignment", () => {
    const { cell } = renderTable();
    expect(cell.className).not.toContain("text-center");
  });

  it("keeps the header left-aligned too, so the column reads as one edge", () => {
    expect(renderTable().head.className).toContain("text-left");
  });
});

describe('clause: "Table is the dumb DOM primitive"', () => {
  it("renders real table semantics rather than a grid of divs", () => {
    const { cell, row } = renderTable();
    expect(row.tagName.toLowerCase()).toBe("tr");
    expect(cell.tagName.toLowerCase()).toBe("td");
    expect(renderTable().head.tagName.toLowerCase()).toBe("th");
  });

  // NOT APPLICABLE at this primitive, with the reason: "PaginatedTable handles
  // offset, sort, and selection" assigns that behaviour to the SIBLING
  // component. It is graded in paginated-table-drawing-conformance.test.tsx.
  it.skip(
    "not applicable at this primitive: offset, sort and selection belong to PaginatedTable, graded in its own file",
    () => {},
  );
});

describe('clause: "right-align numerics and timestamps" / "IDs/times mono 11px slate"', () => {
  // NOT APPLICABLE at this primitive, with the reason: which columns hold
  // numerics or timestamps is known only to the CALL SITE, which passes the
  // alignment and the mono treatment through `className`. The dumb primitive
  // cannot infer a column's type from its content without guessing.
  it.skip(
    "not applicable at this primitive: the numeric/timestamp column treatment is supplied by the call site, which alone knows the column type",
    () => {},
  );

  it("accepts the call site's alignment without fighting it", () => {
    // What IS graded here: the primitive sets no alignment of its own that a
    // caller's `text-right` would have to override with `!important`.
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell className="text-right font-mono">14:21</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const cell = container.querySelector('[data-slot="table-cell"]') as HTMLElement;
    expect(cell.className).toContain("text-right");
    expect(cell.className).not.toContain("text-left");
  });
});

describe('RECORDED DEPARTURE (leg 2 follow-up): clause "cell padding 10-14px"', () => {
  it("pads the body cell inside the stated 10-14px band", () => {
    // RECORDED DEPARTURE — beyond the first ten rows of issue #3189's table,
    // so it is recorded here rather than fixed.
    //
    // MEASURED: the body cell is `p-2` = 8px on all four sides, 2px below the
    // band's 10px floor. The header cell is `px-2` with `h-10`, so the header
    // and body columns are also padded inconsistently with each other.
    //
    // FOLLOW-UP: leg 2 takes the body cell to `p-2.5` (10px, the band's floor)
    // and the header cell's horizontal padding with it, so the two stay on one
    // column edge. The change reflows every table in the product by 2px per
    // side, so it wants its own proof round against the run and desk surfaces
    // rather than riding along inside a checklist commit.
    const { cell } = renderTable();
    expect(cell.className).toMatch(/(^|\s)p-(2\.5|3)(\s|$)/);
  });

  it("pads the header cell horizontally, so the follow-up is a value change and not a new rule", () => {
    // Passes today; recorded alongside the failure as the shape the fix takes.
    expect(renderTable().head.className).toContain("px-2");
  });
});
