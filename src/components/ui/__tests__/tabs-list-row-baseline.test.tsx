// @vitest-environment jsdom
//
// The tab row's trailing rule closes the row ON its baseline (cinatra#3106).
//
//   pnpm exec vitest run src/components/ui/__tests__/tabs-list-row-baseline.test.tsx
//
// `TabsListRow` drops the plain list's own `border-b` — which paints on the
// list's bottom edge — and replaces it with a sibling `<Separator major>` in an
// end-aligned grid. The replacement carried `mb-[11px]`, so it painted eleven
// pixels ABOVE the edge the border it replaced occupied, and read as a second
// horizontal mark floating over the active tab's underline instead of
// continuing it.
//
// jsdom applies no stylesheet, so this asserts the CONTRACT that produces the
// geometry: the row is end-aligned, and the rule carries no vertical offset off
// that baseline. The rendered geometry — the rule's bottom edge level with the
// tab row's bottom edge, in both themes — is asserted in the real DOM by
// tests/e2e/design/conformance/header-rule.spec.ts.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Tabs, TabsContent, TabsListRow, TabsTrigger } from "@/components/ui/tabs";

afterEach(cleanup);

function renderRow() {
  const { container } = render(
    <Tabs defaultValue="credentials">
      <TabsListRow aria-label="Connector setup">
        <TabsTrigger value="credentials">Credentials</TabsTrigger>
        <TabsTrigger value="help">Help</TabsTrigger>
      </TabsListRow>
      <TabsContent value="credentials">Credentials form</TabsContent>
    </Tabs>,
  );
  const rule = container.querySelector('[data-slot="separator"][data-major]');
  const list = container.querySelector('[data-slot="tabs-list"]');
  if (!rule || !list) throw new Error("TabsListRow rendered no rule or no list");
  return { container, rule, list, row: rule.parentElement! };
}

describe("TabsListRow", () => {
  it("carries no vertical offset that lifts the rule off the row baseline", () => {
    const { rule } = renderRow();
    const offsets = Array.from(rule.classList).filter((c) =>
      /^-?(mb|my|mt)-/.test(c),
    );
    expect(
      offsets,
      `the trailing rule must sit ON the row baseline; found offset class(es): ${offsets.join(", ")}`,
    ).toEqual([]);
  });

  it("end-aligns the rule with the tab row so both share one bottom edge", () => {
    const { rule, row } = renderRow();
    expect(row.className).toContain("items-end");
    expect(rule.classList.contains("self-end")).toBe(true);
  });

  it("still renders exactly one etched paired-line rule, and the list still drops its own border", () => {
    const { container, list } = renderRow();
    expect(
      container.querySelectorAll('[data-slot="separator"][data-major]'),
    ).toHaveLength(1);
    expect(list.className).toContain("border-b-0");
  });
});
