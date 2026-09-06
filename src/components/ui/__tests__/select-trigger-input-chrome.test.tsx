// @vitest-environment jsdom
//
// Select vs its own section in the components drawing (cinatra#3189, audit leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/select-trigger-input-chrome.test.tsx
//
// The section's first sentence is "Trigger mirrors Input chrome", and its spec
// column repeats it ("inherits input chrome"). The shipped trigger mirrored
// none of the four chrome values the Input section pins: it drew a transparent
// ground instead of surface-strong, an 8px corner instead of 7px, a 36px box
// instead of 32px, and 12px/8px padding instead of Input's 10px/4px.
//
// The assertions READ Input's own rendered classes rather than restating them,
// so the mirror cannot silently drift: change Input's chrome and this test
// demands the trigger follow.
//
// jsdom applies no stylesheet, so this asserts the class contract; the computed
// background, radius and border-box height are measured in the real browser by
// tests/e2e/design/conformance/primitive-chrome.spec.ts.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

afterEach(cleanup);

function classesOf(selector: string, node: HTMLElement): string[] {
  const el = node.querySelector(selector);
  if (!el) throw new Error(`nothing rendered for ${selector}`);
  return Array.from(el.classList);
}

function inputChrome(): string[] {
  const { container } = render(<Input aria-label="Name" />);
  const classes = classesOf('[data-slot="input"]', container);
  cleanup();
  return classes;
}

function triggerChrome(): string[] {
  const { container } = render(
    <Select>
      <SelectTrigger aria-label="Cadence">
        <SelectValue placeholder="Pick one" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="daily">Daily</SelectItem>
      </SelectContent>
    </Select>,
  );
  const classes = classesOf('[data-slot="select-trigger"]', container);
  cleanup();
  return classes;
}

/** Input's own class for one chrome axis — the value the trigger must mirror. */
function inputValueFor(prefix: RegExp): string {
  const found = inputChrome().filter((c) => prefix.test(c));
  if (found.length !== 1) {
    throw new Error(
      `Input carries ${found.length} classes matching ${prefix} (${found.join(", ")}) — the mirror has no single value to follow`,
    );
  }
  return found[0]!;
}

describe("SelectTrigger — components drawing, Select / Dropdown section", () => {
  it("mirrors Input's ground: pure-white surface-strong, not a transparent box", () => {
    const ground = inputValueFor(/^bg-(?!clip)/);
    expect(ground).toBe("bg-surface-strong");
    expect(triggerChrome()).toContain(ground);
  });

  it("mirrors Input's 7px corner", () => {
    const radius = inputValueFor(/^rounded-/);
    expect(radius).toBe("rounded-[7px]");
    expect(triggerChrome()).toContain(radius);
  });

  it("mirrors Input's strong navy hairline", () => {
    const border = inputValueFor(/^border-(?!0)/);
    expect(triggerChrome()).toContain(border);
  });

  it("mirrors Input's 32px box at the default size, one step down at sm", () => {
    const height = inputValueFor(/^h-\d/);
    expect(height).toBe("h-8");
    const trigger = triggerChrome();
    expect(trigger).toContain(`data-[size=default]:${height}`);
    expect(trigger).toContain("data-[size=sm]:h-7");
  });

  it("mirrors Input's inline and block padding", () => {
    const trigger = triggerChrome();
    for (const pad of inputChrome().filter((c) => /^p[xy]-/.test(c))) {
      expect(trigger, `Input pads with ${pad}; the trigger must mirror it`).toContain(
        pad,
      );
    }
  });
});

describe("SelectContent — components drawing, Select / Dropdown section", () => {
  function contentClasses(): string[] {
    const { container, baseElement } = render(
      <Select defaultOpen>
        <SelectTrigger aria-label="Cadence">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="daily">Daily</SelectItem>
        </SelectContent>
      </Select>,
    );
    const el =
      baseElement.querySelector('[data-slot="select-content"]') ??
      container.querySelector('[data-slot="select-content"]');
    if (!el) throw new Error("SelectContent rendered nothing");
    return Array.from(el.classList);
  }

  it("sits on the popover token, which the palette maps to surface-strong", () => {
    expect(contentClasses()).toContain("bg-popover");
  });

  it("carries the same hairline border the sibling popover panels draw", () => {
    expect(contentClasses()).toContain("border");
  });

  it("lifts on a higher shadow than the trigger it opens from", () => {
    expect(triggerChrome()).toContain("shadow-xs");
    expect(contentClasses()).toContain("shadow-md");
  });
});
