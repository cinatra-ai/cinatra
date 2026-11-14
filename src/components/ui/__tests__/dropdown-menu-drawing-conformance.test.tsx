// @vitest-environment jsdom
//
// DropdownMenu — the graded checklist for the components drawing's
// "Select / Dropdown" section, on the clauses that reach this primitive
// (cinatra#3189, shared-primitives wave, leg 1). The section names
// `<DropdownMenu />` in its own component line, so its clauses govern this
// file as well as `select.tsx`.
//
//   pnpm exec vitest run src/components/ui/__tests__/dropdown-menu-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "popover token"
//   "surface-strong"
//   "inherits input chrome"
//   "scrollbar-thin"
//   "Trigger mirrors Input chrome. Open popover sits on --surface-strong with
//    the same hairline border, slightly higher shadow. Use scrollbar-thin on
//    long lists."
//
// NO DEPARTURE FOUND in the main panel's chrome; the committed checklist
// (docs/internals/records/audits/3189-g2-checklist.md) is the record. The
// trigger clause does not reach this file and the row below says why.
//
// THREE CLAUSES OF THE "Context menu" SECTION WERE FIXED, and the cases at the
// end of this file grade them, in the host copy and in the portable sdk-ui
// copy, on the compiled rules that match the rendered rows:
//
//   "indigo tint active row" — the highlighted rows drew the sage accent-soft;
//     every highlightable row now takes the indigo soft-tint (#364e81 at 6%),
//     the destructive row keeps its own red tint.
//   "mono shortcut hints" — the shortcut hint was set in the body face and took
//     the accent ink on a highlighted row; it is now mono and stays slate.
//   "the same hairline border" — the sub-menu panel drew no border; it now
//     draws the menu panel's hairline.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import * as PortableMenu from "../../../../packages/sdk-ui/src/ui/dropdown-menu";
import { compileHostSheet, compilePortableSheet, readCompiledCss, type CompiledSheet } from "./compiled-utilities";

afterEach(cleanup);

function renderMenu() {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>Most-used today</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Run details</DropdownMenuItem>
        <DropdownMenuItem>Tool calls</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  const q = (slot: string) =>
    document.querySelector(`[data-slot="${slot}"]`) as HTMLElement;
  return { content: q("dropdown-menu-content"), trigger: q("dropdown-menu-trigger") };
}

describe('clause: "Open popover sits on --surface-strong"', () => {
  it("draws the open panel on the popover token, which resolves to surface-strong", () => {
    const { content } = renderMenu();
    // `bg-popover` -> `--popover` -> `--surface-strong`. The computed rgb is
    // read on the boot ("dropdown panel ground", primitive-wave-leg1.spec.ts)
    // in both palettes, because the token resolves to a different value in each.
    expect(content.className).toContain("bg-popover");
    expect(content.className).toContain("text-popover-foreground");
  });
});

describe('clause: "with the same hairline border"', () => {
  it("strokes the panel with the shared hairline, the stroke every sibling panel draws", () => {
    const { content } = renderMenu();
    expect(content.className).toContain("border");
    expect(content.className).toContain("border-line");
  });
});

describe('clause: "slightly higher shadow"', () => {
  it("lifts the panel one shadow step above the resting chrome it opened from", () => {
    const { content } = renderMenu();
    // `shadow-md` stands over the resting control's `shadow-xs`. The two
    // computed box-shadows are compared on the boot.
    expect(content.className).toContain("shadow-md");
    expect(content.className).not.toContain("shadow-xs");
  });
});

describe('clause: "Use scrollbar-thin on long lists."', () => {
  it("scrolls the panel itself once the list outgrows the space it has", () => {
    const { content } = renderMenu();
    expect(content.className).toContain("overflow-y-auto");
    expect(content.className).toContain(
      "max-h-(--radix-dropdown-menu-content-available-height)",
    );
  });

  // The clause names a utility this product does not have. The value it asks
  // for is set once, in the app's base layer, over every element, so the
  // panel's computed `scrollbar-width` is already `thin` — the same reading
  // this wave recorded for the select panel. It is read on the boot rather
  // than asserted here, because a base-layer rule cannot be seen from jsdom.
  it.skip(
    "read on the boot instead: the app sets scrollbar-width: thin once in its base layer, so the panel's computed value is already thin — no per-element utility exists to assert here",
    () => {},
  );
});

describe('clause: "Trigger mirrors Input chrome."', () => {
  it("leaves the trigger unstyled, so the chrome comes from the control the caller passes", () => {
    const { trigger } = renderMenu();
    // The trigger adds no ground, stroke or box of its own — a consumer wraps
    // a Button or another control in it.
    expect(trigger.className === "" || trigger.className === undefined).toBe(true);
  });

  // NOT APPLICABLE at this primitive, with the reason: this file ships no
  // trigger chrome to mirror Input with. The clause is answerable at
  // `select.tsx`, whose trigger IS the control, and it is graded there.
  it.skip(
    "not applicable at this primitive: DropdownMenuTrigger ships no chrome; the mirror clause is graded on select's trigger",
    () => {},
  );
});

describe("panel behaviour the section's chrome clauses depend on", () => {
  it("keeps the panel in the same stacking band as its sibling overlays", () => {
    const { content } = renderMenu();
    // A panel that opened under the header band would put every chrome reading
    // above out of reach of a proof round.
    expect(content.className).toContain("z-[160]");
  });

  it("names the item rows so a status or destructive row is readable as one", () => {
    renderMenu();
    const items = Array.from(
      document.querySelectorAll('[data-slot="dropdown-menu-item"]'),
    );
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("data-variant")).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// The three fixed clauses of the "Context menu" section, graded on the compiled
// rules that match the rendered rows (not on the class strings), in the host
// copy against the shipped globals.css and in the portable sdk-ui copy against
// the portable sheet it is drawn with.

const HostMenu = {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
type MenuModule = typeof HostMenu;

const COPIES: { name: "host" | "portable"; menu: MenuModule; sheet: () => Promise<CompiledSheet> }[] = [
  { name: "host", menu: HostMenu, sheet: compileHostSheet },
  { name: "portable", menu: PortableMenu, sheet: compilePortableSheet },
];

/** The drawing's indigo ink (#364e81) and brand red (#a6384f), each mixed at the drawn tint. */
const INDIGO_TINT = "color-mix(in oklab, #364e81 6%, transparent)";
const DESTRUCTIVE_TINT = "color-mix(in oklab, #a6384f 10%, transparent)";
const MONO_STACK = 'var(--font-jetbrains-mono), "SFMono-Regular", "IBM Plex Mono", "Menlo", monospace';

function renderRows(menu: MenuModule, subOpen = false) {
  const M = menu;
  document.documentElement.className = "cinatra";
  render(
    <M.DropdownMenu open>
      <M.DropdownMenuTrigger>Run actions</M.DropdownMenuTrigger>
      <M.DropdownMenuContent>
        <M.DropdownMenuItem>
          Rename<M.DropdownMenuShortcut>⌘R</M.DropdownMenuShortcut>
        </M.DropdownMenuItem>
        <M.DropdownMenuItem variant="destructive">Delete run</M.DropdownMenuItem>
        <M.DropdownMenuCheckboxItem checked>
          Pinned<M.DropdownMenuShortcut>⌘P</M.DropdownMenuShortcut>
        </M.DropdownMenuCheckboxItem>
        <M.DropdownMenuRadioGroup value="list">
          <M.DropdownMenuRadioItem value="list">
            List view<M.DropdownMenuShortcut>⌘L</M.DropdownMenuShortcut>
          </M.DropdownMenuRadioItem>
        </M.DropdownMenuRadioGroup>
        <M.DropdownMenuSub open={subOpen} onOpenChange={() => {}}>
          <M.DropdownMenuSubTrigger>
            Move to<M.DropdownMenuShortcut>⌘M</M.DropdownMenuShortcut>
          </M.DropdownMenuSubTrigger>
          <M.DropdownMenuSubContent>
            <M.DropdownMenuItem>Archive</M.DropdownMenuItem>
          </M.DropdownMenuSubContent>
        </M.DropdownMenuSub>
      </M.DropdownMenuContent>
    </M.DropdownMenu>,
  );
  const one = (selector: string) => {
    const found = document.querySelectorAll(selector);
    expect(found).toHaveLength(1);
    return found[0] as HTMLElement;
  };
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-content"] > [data-slot="dropdown-menu-item"]'));
  expect(items).toHaveLength(2);
  return {
    item: items[0],
    destructive: items[1],
    checkbox: one('[data-slot="dropdown-menu-checkbox-item"]'),
    radio: one('[data-slot="dropdown-menu-radio-item"]'),
    subTrigger: one('[data-slot="dropdown-menu-sub-trigger"]'),
  };
}

function focusRow(row: HTMLElement) {
  act(() => row.focus());
  expect(document.activeElement).toBe(row);
}

/** The winning declaration of `property`, with its var() chain resolved on the element. */
function won(sheet: CompiledSheet, element: Element, property: string) {
  const winner = sheet.winning(element, property);
  return winner ? { ...winner, resolved: sheet.resolve(element, winner.value) } : undefined;
}

function shortcutOf(row: HTMLElement) {
  const shortcut = row.querySelector<HTMLElement>('[data-slot="dropdown-menu-shortcut"]');
  expect(shortcut).not.toBeNull();
  return shortcut as HTMLElement;
}

/** The slate hint of a highlighted row: an !important group-focus rule whose group is that row. */
function expectSlateFromRowGroup(sheet: CompiledSheet, row: HTMLElement) {
  const shortcut = shortcutOf(row);
  const color = won(sheet, shortcut, "color");
  expect(color?.value).toBe("var(--muted-foreground)");
  expect(color?.important).toBe(true);
  expect(color?.selector).toContain("group-focus\\/dropdown-menu-item");
  expect(shortcut.parentElement?.closest(".group\\/dropdown-menu-item")).toBe(row);
}

describe.each(COPIES)("the $name copy, on its compiled rules", ({ menu, sheet: load }) => {
  let sheet: CompiledSheet;
  beforeAll(async () => {
    sheet = await load();
  });
  afterEach(() => {
    document.documentElement.className = "";
  });

  it('clause: "indigo tint active row" — every highlightable row takes the indigo soft-tint, host and portable', () => {
    const rows = renderRows(menu);
    for (const row of [rows.item, rows.checkbox, rows.radio, rows.subTrigger]) {
      focusRow(row);
      expect(won(sheet, row, "background-color")?.resolved).toBe(INDIGO_TINT);
    }
    // The destructive row keeps its own red tint.
    focusRow(rows.destructive);
    expect(won(sheet, rows.destructive, "background-color")?.resolved).toBe(DESTRUCTIVE_TINT);
    cleanup();
    // With its sub-menu open, the sub-menu trigger holds the tint without focus.
    const open = renderRows(menu, true);
    expect(open.subTrigger.getAttribute("data-state")).toBe("open");
    focusRow(open.item);
    expect(open.subTrigger.matches(":focus")).toBe(false);
    expect(won(sheet, open.subTrigger, "background-color")?.resolved).toBe(INDIGO_TINT);
  });

  it('clause: "mono shortcut hints" — the shortcut is mono and stays slate on every highlighted row', () => {
    const rows = renderRows(menu);
    for (const row of [rows.item, rows.checkbox, rows.radio, rows.subTrigger]) {
      // The stack's first face is set on the document by the font loader at
      // run time, not by the stylesheet, so the declared value is read, unresolved.
      const family = sheet.winning(shortcutOf(row), "font-family");
      expect(family?.value === "var(--font-mono)" ? sheet.customProperty(shortcutOf(row), "--font-mono") : family?.value).toBe(MONO_STACK);
      focusRow(row);
      expectSlateFromRowGroup(sheet, row);
    }
    cleanup();
    const open = renderRows(menu, true);
    expect(open.subTrigger.getAttribute("data-state")).toBe("open");
    focusRow(open.subTrigger);
    expectSlateFromRowGroup(sheet, open.subTrigger);
  });

  it('clause: "the same hairline border" — the sub-menu panel draws it too', () => {
    renderRows(menu, true);
    const panel = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-content"]');
    expect(panel).not.toBeNull();
    expect(won(sheet, panel as HTMLElement, "border-width")?.value).toBe("1px");
    const color = won(sheet, panel as HTMLElement, "border-color");
    expect(color?.value).toBe("var(--line)");
    expect(color?.resolved).toBe("rgba(21, 33, 58, 0.14)");
  });
});

// The shared compiled-CSS test helper grades a rendered element by the compiled
// rules that match it and throws on a rule or a selector it cannot read instead
// of skipping it: a rule it cannot read is never a pass.
describe("the compiled-rule reading the cases above rely on", () => {
  function row() {
    render(<div className="row" />);
    return document.querySelector<HTMLElement>(".row") as HTMLElement;
  }

  it("throws on an at-rule it cannot flatten", () => {
    const sheet = readCompiledCss("@scope (.menu) { .row { color: red; } }");
    expect(() => sheet.winning(row(), "color")).toThrow("cannot flatten the at-rule @scope");
  });

  it("throws on a selector matches() rejects", () => {
    const sheet = readCompiledCss(".row:-moz-focusring { color: red; }");
    expect(() => sheet.winning(row(), "color")).toThrow("matches() rejects the selector");
  });

  it("throws on a matching rule under a condition it cannot evaluate", () => {
    const sheet = readCompiledCss("@media (orientation: portrait) { .row { color: red; } }");
    expect(() => sheet.winning(row(), "color")).toThrow("cannot evaluate the condition");
  });

  it("ranks importance over specificity over source order", () => {
    const sheet = readCompiledCss(
      ".row { color: red; } div.row { color: green; } .row { color: blue !important; } .row { color: black; }",
    );
    const element = row();
    expect(sheet.winning(element, "color")?.value).toBe("blue");
    expect(sheet.matching(element, "color").map((d) => d.value)).toEqual(["red", "green", "blue", "black"]);
  });
});
