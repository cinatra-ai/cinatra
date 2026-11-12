// @vitest-environment jsdom
//
// Combobox - the graded checklist for the components drawing's "Combobox"
// section (cinatra#3189, shared-primitives wave).
//
//   pnpm exec vitest run src/components/ui/__tests__/combobox-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "Input trigger + chevron"
//   "cmdk-filtered list"
//   "check on selected"
//   "indigo tint active row"
//   "A Select crossed with the Command menu: an Input-chrome trigger opens a
//    type-to-filter list. The current value carries an indigo check; the
//    highlighted row uses the indigo soft-tint."
//
// and the values the section's own Example writes out in full:
//
//   trigger chevron   "width:14px;height:14px;color:var(--muted)"
//   search row text   "font: 12.5px var(--font-sans)"
//   option row        "padding: 7px 9px; border-radius: 5px; ... font-size: 13px"
//   the check         "stroke-width=\"2.4\" ... width:13px;height:13px;color:var(--blue)"
//
// DEPARTURE FOUND AND FIXED. The trigger, the joined list, the flat search row,
// the indigo check and the indigo soft-tint already met the drawing. Four
// values in the list and on the trigger did not:
//   - the option rows took the shared Command row's 8px x 6px inset, its
//     palette-varying `rounded-sm` (6px in one palette, 4px in the other) and
//     14px type, where the Example draws 9px x 7px, 5px and 13px;
//   - the check took the shared row's 16px icon size at the default stroke,
//     where the Example draws a 13px check at stroke 2.4;
//   - the search row set its text at 14px, where the Example sets 12.5px;
//   - the trigger chevron was 16px at half opacity, where the Example draws a
//     14px chevron in the full muted ink.
// Each is fixed in the Combobox's own call site; the shared Command primitive
// and every other caller keep their recipe.
//
// The trigger's TYPE SIZE and inset are graded against the family clause the
// Select section states for every trigger of the select family, "Trigger
// mirrors Input chrome": the trigger keeps the Input's `text-sm`, so a list
// that crosses the ~8 threshold changes its behaviour without changing how the
// row reads beside the Input next to it.
//
// What is graded here is the RECIPE (class names). Colours that only resolve
// through palette tokens are re-read on the live boot in both palettes.
import * as React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render } from "@testing-library/react"

import { Combobox } from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"

// jsdom omits the layout APIs the popover primitive calls. These are
// test-ENVIRONMENT shims, not relaxed assertions.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  })
}
if (typeof Element !== "undefined") {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {}
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function hasPointerCapture() {
      return false
    }
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function setPointerCapture() {}
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function releasePointerCapture() {}
  }
}
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  })
}

afterEach(cleanup)

const OPTIONS = [
  { value: "gmail", label: "Gmail Connector" },
  { value: "slack", label: "Slack Connector" },
  { value: "salesforce", label: "Salesforce Connector" },
]

function classes(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)
}

function renderTrigger() {
  render(<Combobox id="under-test" value="gmail" options={OPTIONS} />)
  return document.getElementById("under-test") as HTMLElement
}

function openList() {
  const trigger = renderTrigger()
  fireEvent.click(trigger)
  const content = document.querySelector(
    '[data-slot="combobox-content"]',
  ) as HTMLElement
  expect(content, "the combobox must open its list").not.toBeNull()
  return content
}

function rows(content: HTMLElement): HTMLElement[] {
  return Array.from(
    content.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
  )
}

describe('clause: "an Input-chrome trigger" / "Input trigger + chevron"', () => {
  it("draws the trigger on the Input's chrome", () => {
    const trigger = classes(renderTrigger())
    for (const token of [
      "h-8",
      "rounded-[7px]",
      "border",
      "border-input",
      "bg-surface-strong",
    ]) {
      expect(trigger, `the trigger lost the Input chrome's ${token}`).toContain(
        token,
      )
    }
  })

  it("keeps the Input's type size, as the family clause asks", () => {
    // "Trigger mirrors Input chrome": the Input sets its type at text-sm from
    // md up, and the trigger takes the same size so the two read alike.
    const { container } = render(<Input aria-label="Name" />)
    const input = container.querySelector('[data-slot="input"]') as HTMLElement
    expect(classes(input)).toContain("md:text-sm")
    expect(classes(renderTrigger())).toContain("text-sm")
  })

  it('draws the chevron at the Example\'s 14px in the full muted ink ("width:14px;height:14px;color:var(--muted)")', () => {
    const chevron = renderTrigger().querySelector("svg") as SVGElement
    expect(chevron, "the trigger draws no chevron").not.toBeNull()
    const tokens = classes(chevron)
    expect(tokens, "the chevron is not 14px").toContain("size-3.5")
    expect(tokens, "the chevron is drawn at 16px").not.toContain("size-4")
    expect(tokens, "the chevron is not in the muted ink").toContain(
      "text-muted-foreground",
    )
    expect(
      tokens,
      "the chevron is dimmed to half opacity, a lighter ink than the drawing's muted",
    ).not.toContain("opacity-50")
  })
})

describe('clause: "opens a type-to-filter list" / "cmdk-filtered list"', () => {
  it("opens a list with a search row and the options under it", () => {
    const content = openList()
    expect(
      content.querySelector('[data-slot="command-input"]'),
      "the list has no type-to-filter field",
    ).not.toBeNull()
    expect(rows(content)).toHaveLength(OPTIONS.length)
  })

  it('sets the search text at the Example\'s 12.5px ("font: 12.5px var(--font-sans)")', () => {
    const input = openList().querySelector(
      '[data-slot="command-input"]',
    ) as HTMLElement
    const tokens = classes(input)
    expect(tokens, "the search text is not 12.5px").toContain("text-[12.5px]")
    expect(tokens, "the search text is still 14px").not.toContain("text-sm")
  })

  it("keeps the Example's 5px inset around the rows", () => {
    const list = openList().querySelector(
      '[data-slot="command-list"]',
    ) as HTMLElement
    expect(classes(list)).toContain("p-[5px]")
  })
})

describe('the Example\'s option row ("padding: 7px 9px; border-radius: 5px; ... font-size: 13px")', () => {
  it("insets every row 9px across and 7px down", () => {
    for (const row of rows(openList())) {
      const tokens = classes(row)
      expect(tokens, "a row is not inset 9px across").toContain("px-[9px]")
      expect(tokens, "a row is not inset 7px down").toContain("py-[7px]")
      expect(tokens, "a row keeps the shared 8px inset").not.toContain("px-2")
      expect(tokens, "a row keeps the shared 6px inset").not.toContain("py-1.5")
    }
  })

  it("rounds every row at 5px in both palettes", () => {
    // `rounded-sm` is derived from a `--radius` the two palettes set
    // differently; the drawing writes one number.
    for (const row of rows(openList())) {
      const tokens = classes(row)
      expect(tokens, "a row is not rounded at 5px").toContain("rounded-[5px]")
      expect(tokens, "a row keeps the palette-varying radius").not.toContain(
        "rounded-sm",
      )
    }
  })

  it("sets every row's text at 13px", () => {
    for (const row of rows(openList())) {
      const tokens = classes(row)
      expect(tokens, "a row's text is not 13px").toContain("text-[13px]")
      expect(tokens, "a row's text is still 14px").not.toContain("text-sm")
    }
  })
})

describe('clause: "The current value carries an indigo check" / "check on selected"', () => {
  it("marks only the current value's row as checked", () => {
    const checked = rows(openList()).filter(
      (row) => row.getAttribute("data-checked") === "true",
    )
    expect(checked).toHaveLength(1)
    expect(checked[0].textContent).toContain("Gmail Connector")
  })

  it("draws the check in the indigo ink", () => {
    for (const row of rows(openList())) {
      expect(classes(row)).toContain("data-[checked=true]:[&_svg]:text-indigo-ink!")
    }
  })

  it('draws the check at the Example\'s 13px and stroke 2.4 ("width:13px;height:13px", stroke-width="2.4")', () => {
    for (const row of rows(openList())) {
      const tokens = classes(row)
      expect(tokens, "the check is not 13px").toContain(
        "[&_svg:not([class*='size-'])]:size-[13px]",
      )
      expect(tokens, "the check keeps the shared 16px size").not.toContain(
        "[&_svg:not([class*='size-'])]:size-4",
      )
      expect(tokens, "the check is not drawn at stroke 2.4").toContain(
        "[&_svg]:[stroke-width:2.4]",
      )
    }
  })
})

describe('clause: "the highlighted row uses the indigo soft-tint" / "indigo tint active row"', () => {
  it("tints only the highlighted row, in the indigo soft-tint", () => {
    for (const row of rows(openList())) {
      const tokens = classes(row)
      expect(tokens).toContain("data-selected:bg-transparent")
      expect(tokens).toContain("data-[selected=true]:bg-indigo-ink/[0.06]!")
    }
  })
})
