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
// FIXED IN LEG 2 ON THE DOM SEAM, not in this file, and the reason is a
// boundary rather than a judgement about the drawing. `table.tsx` is a VENDORED
// primitive: it sits in apollo-connector's vendored closure (pulled in
// transitively by `paginated-table`), and
// `scripts/extensions/vendor-extension-primitives.mjs --check` is a standing
// provenance gate in CI that requires every vendored copy to equal this source
// byte-for-byte modulo the import rewrite. Editing the primitive turns that
// gate red for exactly as long as a consumer is still pinned at the pre-change
// copy — a cross-repository transaction, which this leg cannot run.
//
// So the clause is stated where it reaches the host copy and every vendored
// copy alike and changes no file the gate reads: a scope on the DOM seam at the
// end of src/app/globals.css. That is the road leg 1 took for the card corner,
// in the same file, for the same reason, and it is graded here the same way —
// as a recipe read out of the CSS source — and read as a rendered value in both
// palettes on the live boot by
// tests/e2e/design/conformance/primitive-wave-leg2.spec.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// Resolved from the vitest root (the repository root), not from
// import.meta.url: the file is transformed, so its module URL is not a file
// URL and cannot be turned into a path. Same helper shape as the card
// checklist, which grades its own seam out of this file.
function globals(): string {
  return readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
}

/**
 * The brace depth a rule opens at, counted over the whole file with comments
 * stripped. Depth 0 is top level — outside every `@layer` — which is what makes
 * an unlayered rule beat Tailwind's `layer(utilities)` import without an
 * `!important`. Returns -1 when the marker appears nowhere.
 */
function depthOfRule(marker: string): number {
  const source = globals().replace(/\/\*[\s\S]*?\*\//g, "");
  const index = source.indexOf(marker);
  if (index === -1) return -1;
  let depth = 0;
  for (const character of source.slice(0, index)) {
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
  }
  return depth;
}

const BODY_SEAM = '[data-slot="table-cell"][class~="p-2"]:not(';
const HEAD_SEAM = '[data-slot="table-head"][class~="px-2"]:not(';
const BAND = { min: 10, max: 14 };

describe('clause: "cell padding 10-14px"', () => {
  it("pads the body cell from a value inside the stated band", () => {
    // THE VALUE IS READ OUT OF THE RECIPE, not restated here, so a later edit
    // that walks the padding back out of the band fails this case rather than
    // passing it on a literal that agrees with itself.
    const match =
      /\[data-slot="table-cell"\]\[class~="p-2"\]:not\([\s\S]*?\)\s*\{\s*padding:\s*(\d+)px;/.exec(
        globals(),
      );
    expect(match, "the body-cell seam declares no padding in globals.css").not.toBeNull();
    const padding = Number((match as RegExpExecArray)[1]);
    expect(padding, `body cell pads ${padding}px`).toBeGreaterThanOrEqual(BAND.min);
    expect(padding, `body cell pads ${padding}px`).toBeLessThanOrEqual(BAND.max);
  });

  it("pads the header cell from that same value, so the two columns keep one edge", () => {
    // The header's horizontal padding has to move WITH the body cell or the
    // header text sits inboard of its own column for every table in the
    // product. Leg 1 pinned that pairing; this is the pairing, landed.
    const body =
      /\[data-slot="table-cell"\]\[class~="p-2"\]:not\([\s\S]*?\)\s*\{\s*padding:\s*(\d+)px;/.exec(
        globals(),
      );
    const head =
      /\[data-slot="table-head"\]\[class~="px-2"\]:not\([\s\S]*?\)\s*\{\s*padding-left:\s*(\d+)px;\s*padding-right:\s*(\d+)px;/.exec(
        globals(),
      );
    expect(head, "the header-cell seam declares no padding in globals.css").not.toBeNull();
    const [, left, right] = head as RegExpExecArray;
    expect(left).toBe((body as RegExpExecArray)[1]);
    expect(right).toBe((body as RegExpExecArray)[1]);
  });

  it("states the padding where the cascade lets it win, with no !important", () => {
    // Tailwind's utilities arrive in `layer(utilities)`; an unlayered rule beats
    // a layered one whatever the specificity. Both seams are therefore at top
    // level, and neither reaches for `!important`, which would take the padding
    // away from a consumer for good rather than merely stating the default.
    expect(depthOfRule(BODY_SEAM)).toBe(0);
    expect(depthOfRule(HEAD_SEAM)).toBe(0);
    const source = globals();
    for (const marker of [BODY_SEAM, HEAD_SEAM]) {
      const rule = source.slice(source.indexOf(marker));
      expect(rule.slice(0, rule.indexOf("}"))).not.toContain("!important");
    }
  });

  it("supplies the primitive's default and nothing else", () => {
    // The seam matches only a cell that still carries the primitive's OWN
    // padding token and no directional padding of its own. `cn()` is
    // tailwind-merge: a call site that states a full `p-*` replaces `p-2`, so
    // the `[class~="p-2"]` arm already excludes it; a directional utility
    // leaves `p-2` in place, so every one of them is excluded by name, matched
    // at a token boundary. That is what keeps the 62 call sites in this product
    // that pad their own cells — the permissions matrix, the metric-cost
    // tables, the `py-8` empty-state row — rendering exactly what their class
    // says.
    const { cell, head } = renderTable();
    expect(cell.className.split(/\s+/)).toContain("p-2");
    expect(head.className.split(/\s+/)).toContain("px-2");
    const source = globals();
    for (const token of [
      "px-",
      "py-",
      "pt-",
      "pr-",
      "pb-",
      "pl-",
      "ps-",
      "pe-",
    ]) {
      expect(
        source,
        `the body-cell seam does not exclude a call site's ${token}* utility`,
      ).toContain(`[class^="${token}"], [class*=" ${token}"]`);
    }
  });

  it("excludes the SAME utilities at the head as at the body cell, arm for arm", () => {
    // THE PAIRING IS THE CLAUSE. A head and the body under it share one column
    // edge, so the two seams have to hand the column back to the call site on
    // the same terms. An arm the head omitted put the two out of step by 2px at
    // a real call site on this head:
    // packages/metric-usage-api/src/components/token-by-provider-table.tsx
    // draws heads `pb-2` over cells `py-2` — the cell's `py-` arm handed the
    // column back and left it at the primitive's 8px, while the head, with no
    // `pb-` arm, took the seam's 10px. Every arm is on both sides now.
    const source = globals();
    const head = source.slice(source.indexOf(HEAD_SEAM));
    const armList = head.slice(0, head.indexOf(")"));
    // `px-` is the one arm that is deliberately absent, and its absence is
    // asserted below rather than left unsaid: the head's OWN token is `px-2`,
    // so an arm matching it would switch the seam off for every head cell. A
    // caller's `px-*` is already declined by the `[class~="px-2"]` arm at the
    // head of the selector, because tailwind-merge removes the primitive's
    // token when a call site states one of its own.
    for (const token of [
      "p-",
      "py-",
      "pt-",
      "pr-",
      "pb-",
      "pl-",
      "ps-",
      "pe-",
    ]) {
      expect(
        armList,
        `the header seam does not exclude a call site's ${token}* utility`,
      ).toContain(`[class^="${token}"], [class*=" ${token}"]`);
    }
    expect(
      armList,
      "a px- arm would match the head's own px-2 and disable the seam entirely",
    ).not.toContain('[class*=" px-"]');
    expect(head).toContain('[class~="px-2"]');
  });

  it("keeps the checkbox exception at the HEAD too, not only at the body cell", () => {
    // table.tsx spells `[&:has([role=checkbox])]:pr-0` on the head as well as
    // on the cell. The head seam is unlayered and outranks that utility, so
    // without this restatement the header's checkbox column pads 10px on the
    // right while the body cell beneath it pads 0 — the one thing the pairing
    // above exists to prevent.
    const head = readFileSync(
      join(process.cwd(), "src/components/ui/table.tsx"),
      "utf8",
    );
    expect(head).toContain("[&:has([role=checkbox])]:pr-0");
    expect(globals()).toMatch(
      /\[data-slot="table-head"\]\[class~="px-2"\]:has\(\[role="checkbox"\]\)\s*\{\s*padding-right:\s*0;/,
    );
  });

  it("keeps the primitive's checkbox exception, which the seam would otherwise outrank", () => {
    // `[&:has([role=checkbox])]:pr-0` is a layered utility at the same
    // specificity the seam carries, so the seam has to restate it or a checkbox
    // column silently grows a trailing pad.
    expect(globals()).toMatch(
      /\[data-slot="table-cell"\]\[class~="p-2"\]:has\(\[role="checkbox"\]\)\s*\{\s*padding-right:\s*0;/,
    );
  });

  it("leaves the vendored primitive byte-identical to its registry source", () => {
    // The reason the recipe is a scope and not a class, held as a test: the
    // moment the padding is spelled in table.tsx, apollo-connector's vendored
    // copy drifts from it and the provenance gate
    // (scripts/extensions/vendor-extension-primitives.mjs --check) fails until
    // that repository has re-vendored and its pin has been raised.
    const source = readFileSync(
      join(process.cwd(), "src/components/ui/table.tsx"),
      "utf8",
    );
    expect(source).toContain('"p-2 align-middle');
    expect(source).toContain("h-10 px-2 text-left");
  });
});
