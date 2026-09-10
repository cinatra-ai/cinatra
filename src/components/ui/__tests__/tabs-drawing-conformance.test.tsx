// @vitest-environment jsdom
//
// Tabs — the graded checklist for the components drawing's "Tabs" section
// (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/tabs-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "underline tabs"
//   "active = indigo 2px"
//   "inactive = slate"
//   "paired with section rule"
//   "Tab labels are 13px sans, slate when inactive, indigo when selected with a
//    2px indigo underline. No pill tabs; underline only. When tabs appear under
//    a section heading, the etched paired-line rule begins to the right of the
//    last tab and stretches to the page edge — the tablist takes the left
//    portion of the row, the rule the right."
//
// NO DEPARTURE FOUND.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsListRow,
  TabsTrigger,
} from "@/components/ui/tabs";

afterEach(cleanup);

function renderTabs(withRule = false) {
  const List = withRule ? TabsListRow : TabsList;
  const { container } = render(
    <Tabs defaultValue="all">
      <List {...(withRule ? { trailingRule: true } : {})}>
        <TabsTrigger value="all">All</TabsTrigger>
        <TabsTrigger value="agents">Agents</TabsTrigger>
      </List>
      <TabsContent value="all">Everything</TabsContent>
    </Tabs>,
  );
  const triggers = Array.from(
    container.querySelectorAll('[data-slot="tabs-trigger"]'),
  ) as HTMLElement[];
  return { container, triggers };
}

describe('clause: "Tab labels are 13px sans"', () => {
  it("sets the label at the stated 13px", () => {
    expect(renderTabs().triggers[0].className).toContain("text-[13px]");
  });

  it("leaves the label in the sans face rather than the display or mono one", () => {
    const cls = renderTabs().triggers[0].className;
    expect(cls).not.toContain("font-mono");
    expect(cls).not.toContain("font-display");
  });
});

describe('clause: "active = indigo 2px" / "indigo when selected with a 2px indigo underline"', () => {
  it("draws the selected tab's underline 2px thick in the indigo", () => {
    const { triggers } = renderTabs();
    expect(triggers[0].getAttribute("data-state")).toBe("active");
    expect(triggers[0].className).toContain("after:h-[2px]");
    expect(triggers[0].className).toContain("data-[state=active]:after:bg-primary");
  });

  it("turns the selected label indigo as well as its underline", () => {
    expect(renderTabs().triggers[0].className).toContain(
      "data-[state=active]:text-primary",
    );
  });

  it("leaves the underline transparent — not absent — while the tab is inactive", () => {
    // A rule that appears and disappears would shift the row by 2px on every
    // selection; the track is always drawn and only its colour changes.
    expect(renderTabs().triggers[1].className).toContain("after:bg-transparent");
  });
});

describe('clause: "inactive = slate" / "slate when inactive"', () => {
  it("draws the unselected label in the muted ink", () => {
    const { triggers } = renderTabs();
    expect(triggers[1].getAttribute("data-state")).toBe("inactive");
    expect(triggers[1].className).toContain("text-muted-foreground");
  });
});

describe('clause: "underline tabs" / "No pill tabs; underline only"', () => {
  it("underlines the tablist rather than boxing it", () => {
    const { container } = renderTabs();
    const list = container.querySelector('[data-slot="tabs-list"]') as HTMLElement;
    expect(list.className).toContain("border-b");
    expect(list.className).toContain("border-line");
  });

  it("gives the selected tab no pill — no filled ground and no rounded chip", () => {
    // This is the clause's explicit prohibition, so it is graded as a
    // prohibition: the selected trigger must not acquire a background or a
    // corner.
    const cls = renderTabs().triggers[0].className;
    expect(cls).not.toMatch(/data-\[state=active\]:bg-/);
    expect(cls).not.toMatch(/(^|\s)rounded-/);
  });
});

describe('clause: "paired with section rule" / "the rule begins to the right of the last tab"', () => {
  it("lays the row as tablist-left, rule-right when the surface asks for the pairing", () => {
    // cinatra#3216 implemented this as TabsListRow. The row is a two-column
    // grid — `auto` for the tablist, `1fr` for the rule — which is exactly
    // "the tablist takes the left portion of the row, the rule the right".
    const { container } = renderTabs(true);
    const row = container.querySelector(
      '[data-slot="tabs-list"]',
    )!.parentElement as HTMLElement;
    expect(row.className).toContain("grid-cols-[auto_1fr]");
    expect(container.querySelector('[data-slot="separator"]')).not.toBeNull();
  });

  it("drops the tablist's own bottom border when the trailing rule takes over", () => {
    // "never overlap a tablist with the rule, and never stack them" — the
    // tablist underline and the section rule would otherwise draw two lines.
    const { container } = renderTabs(true);
    const list = container.querySelector('[data-slot="tabs-list"]') as HTMLElement;
    expect(list.className).toContain("border-b-0");
  });

  it("draws the trailing rule as the ETCHED paired line, not a plain hairline", () => {
    const { container } = renderTabs(true);
    const rule = container.querySelector('[data-slot="separator"]') as HTMLElement;
    expect(rule.getAttribute("data-major")).toBe("true");
  });

  it("draws no rule at all when the surface did not ask for one", () => {
    const { container } = renderTabs(false);
    expect(container.querySelector('[data-slot="separator"]')).toBeNull();
  });
});
