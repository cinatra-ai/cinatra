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
// NO DEPARTURE FOUND in this primitive's panel chrome; the committed checklist
// is the record. The trigger clause does not reach this file and the row below
// says why.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
