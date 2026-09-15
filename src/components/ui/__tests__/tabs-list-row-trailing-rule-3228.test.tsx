// @vitest-environment jsdom
//
// TabsListRow can give its trailing rule up to a toolbar drawn beneath it
// (cinatra#3228).
//
//   pnpm exec vitest run src/components/ui/__tests__/tabs-list-row-trailing-rule-3228.test.tsx
//
// The ratified drawing (specs/app-components.html, Toolbar): "The toolbar sits
// directly below the page header and replaces the section rule for that view —
// never stack a toolbar and the etched paired rule." A view that carries a tab
// strip between the header and the list draws the strip's trailing rule as its
// only rule; when a toolbar is mounted beneath the strip, the toolbar is the
// element that rule gives way to. The row keeps its tabs and its geometry
// (cinatra#3216: no column gap) either way.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Tabs, TabsListRow, TabsTrigger } from "@/components/ui/tabs";

afterEach(cleanup);

function renderRow(props: Partial<React.ComponentProps<typeof TabsListRow>> = {}) {
  const { container } = render(
    <Tabs defaultValue="all">
      <TabsListRow aria-label="Agents" {...props}>
        <TabsTrigger value="all">All Agents</TabsTrigger>
        <TabsTrigger value="executions">Executions</TabsTrigger>
      </TabsListRow>
    </Tabs>,
  );
  const list = container.querySelector('[data-slot="tabs-list"]');
  if (!list) throw new Error("TabsListRow rendered no list");
  return {
    list,
    row: list.parentElement!,
    rules: container.querySelectorAll('[data-slot="separator"][data-major]'),
  };
}

describe("TabsListRow — the trailing rule gives way to a toolbar (cinatra#3228)", () => {
  it("draws its trailing rule by default, as every view without a toolbar needs", () => {
    const { rules } = renderRow();
    expect(rules.length).toBe(1);
  });

  it("draws NO trailing rule when told a toolbar replaces it (trailingRule={false})", () => {
    const { rules, list } = renderRow({ trailingRule: false });
    expect(rules.length).toBe(0);
    // The tabs stay.
    expect(list.querySelectorAll('[data-slot="tabs-trigger"]').length).toBe(2);
  });

  it("keeps the row's grid geometry identical with or without the rule (no gap creeps back)", () => {
    const withRule = renderRow().row.className;
    cleanup();
    const without = renderRow({ trailingRule: false }).row.className;
    expect(without).toBe(withRule);
    expect(without).toContain("grid-cols-[auto_1fr]");
    expect(without.split(/\s+/).filter((c) => /^(gap|gap-x|space-x)-/.test(c))).toEqual([]);
  });

  it("keeps the SDK mirror in lockstep: packages/sdk-ui's TabsListRow carries the same trailingRule prop and default", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    const host = readFileSync(join(root, "src", "components", "ui", "tabs.tsx"), "utf8");
    const sdk = readFileSync(join(root, "packages", "sdk-ui", "src", "ui", "tabs.tsx"), "utf8");
    for (const src of [host, sdk]) {
      expect(src).toMatch(/trailingRule = true/);
      expect(src).toMatch(/trailingRule\?: boolean/);
      expect(src).toMatch(/\{trailingRule \? /);
    }
  });
});
