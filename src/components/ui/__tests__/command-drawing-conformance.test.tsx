// @vitest-environment jsdom
//
// Command menu: the graded checklist for the components drawing's "Command
// menu" section (cinatra#3189, shared-primitives wave).
//
//   pnpm exec vitest run src/components/ui/__tests__/command-drawing-conformance.test.tsx
//
// The section's clause, quoted verbatim:
//
//   "Global cmd+K palette and inline pickers. Section labels in 10px mono;
//    rows at 13px; the selected row uses the indigo soft-tint background, not
//    a border."
//
// ONE DEPARTURE FOUND AND FIXED: the default row size. The row was set at
// Tailwind's text-sm (14px); the drawing sets it at 13px. A caller that passes
// its own font size on a row keeps it.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

// cmdk scrolls the active row into view and measures its list; jsdom has
// neither, so both are installed for this file only.
beforeAll(() => {
  if (!("scrollIntoView" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderRows(rowClassName?: string): HTMLElement[] {
  const { container } = render(
    <Command>
      <CommandList>
        <CommandGroup heading="Suggestions">
          <CommandItem className={rowClassName}>New run</CommandItem>
          <CommandItem className={rowClassName}>Open settings</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>,
  );
  return Array.from(
    container.querySelectorAll('[data-slot="command-item"]'),
  ) as HTMLElement[];
}

describe('clause: "rows at 13px"', () => {
  it("sets every default row at the drawn 13px, not text-sm (14px)", () => {
    const rows = renderRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const cls = row.className.split(/\s+/);
      expect(cls).toContain("text-[13px]");
      expect(cls).not.toContain("text-sm");
    }
  });

  it("keeps a caller's own font size on a row", () => {
    const rows = renderRows("text-xs");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const cls = row.className.split(/\s+/);
      expect(cls).toContain("text-xs");
      expect(cls).not.toContain("text-[13px]");
      expect(cls).not.toContain("text-sm");
    }
  });
});
