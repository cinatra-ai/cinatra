// @vitest-environment jsdom
//
// The tab row's trailing rule starts IMMEDIATELY to the right of the last tab
// (cinatra#3216).
//
//   pnpm exec vitest run src/components/ui/__tests__/tabs-list-row-rule-gap.test.tsx
//
// The ratified drawing (specs/app-components.html, Dividers): "If a tablist is
// present in the same row, the rule starts immediately to the right of the last
// tab and runs to the page edge — never overlap a tablist with the rule, and
// never stack them." And Tabs: "the tablist takes the left portion of the row,
// the rule the right." Neither section allows a gap.
//
// `TabsListRow` laid the row out as `grid grid-cols-[auto_1fr] items-end gap-7`
// — 1.75rem = 28 CSS px of grid gap between the tablist column and the rule
// column, which is the whole of the hole a reader sees between the last tab and
// the start of the rule.
//
// jsdom applies no stylesheet, so this asserts the CONTRACT that produces the
// geometry: the row grid declares no gap between its two columns. The rendered
// distance — zero within a pixel, in both themes — is asserted in the real DOM
// by tests/e2e/design/conformance/header-rule.spec.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  if (!rule) throw new Error("TabsListRow rendered no rule");
  return { row: rule.parentElement! };
}

// The row wrapper's class list, read out of each copy's source. The two files
// are kept in lockstep, so the same regex reads both.
const ROOT = join(__dirname, "..", "..", "..", "..");
const HOST_SRC = join(ROOT, "src", "components", "ui", "tabs.tsx");
const SDK_SRC = join(ROOT, "packages", "sdk-ui", "src", "ui", "tabs.tsx");

function rowClassNameFromSource(file: string): string {
  const src = readFileSync(file, "utf8");
  const match = src.match(/<div className=['"](grid grid-cols-\[auto_1fr\][^'"]*)['"]>/);
  if (!match) throw new Error(`no TabsListRow grid wrapper found in ${file}`);
  return match[1];
}

const GAP_UTILITY = /^(gap|gap-x|column-gap|space-x)-/;

describe("TabsListRow — the rule starts immediately right of the last tab", () => {
  it("declares no horizontal gap between the tablist column and the rule column", () => {
    const { row } = renderRow();
    const gaps = Array.from(row.classList).filter((c) => GAP_UTILITY.test(c));
    expect(
      gaps,
      `the row grid carries ${gaps.join(" ")}, which pushes the rule that far right of ` +
        "the last tab — the drawing has it start immediately beside the tab",
    ).toEqual([]);
  });

  it("still lays the row out as tabs-left / rule-right, end-aligned", () => {
    const { row } = renderRow();
    expect(row.className).toContain("grid-cols-[auto_1fr]");
    expect(row.className).toContain("items-end");
  });

  it("keeps the host row and the SDK mirror byte-identical on that class list", () => {
    expect(rowClassNameFromSource(SDK_SRC)).toBe(rowClassNameFromSource(HOST_SRC));
  });

  it("leaves no gap utility on the SDK mirror's row either", () => {
    const gaps = rowClassNameFromSource(SDK_SRC)
      .split(/\s+/)
      .filter((c) => GAP_UTILITY.test(c));
    expect(gaps).toEqual([]);
  });
});
