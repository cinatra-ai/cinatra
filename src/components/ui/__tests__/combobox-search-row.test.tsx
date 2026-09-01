// @vitest-environment jsdom
//
// THE COMBOBOX'S TYPE-TO-FILTER ROW IS A ROW, NOT A FIELD PILL (cinatra#3142).
//
// The drawing draws the row inside the open list as flat chrome — a search
// glyph, the placeholder, and a rule closing it off from the options below:
//
//   `display: flex; align-items: center; gap: 8px; padding: 9px 12px;
//    border-bottom: 1px solid var(--line)`, holding a 13px glyph in
//   `var(--muted)` and placeholder text in `var(--muted)`
//
// while the shared Command primitive's default chrome wraps that input in a
// bordered, separately-filled field pill — right for a command palette, and a
// second control floating inside the list here.
//
// The ground, the ink and the rule are COLOURS, and a colour cannot be settled
// in jsdom, where no token resolves; those are measured on the real boot in
// tests/e2e/design/conformance/combobox-chrome.spec.ts. What IS settleable here
// is the row's structure, and it is settleable in milliseconds: which chrome the
// row is built from, that the pill is gone, that the glyph exists beside the
// input, and that the placeholder a caller passes reaches it.
import * as React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render } from "@testing-library/react"

import { Combobox } from "@/components/ui/combobox"

// jsdom omits the layout APIs the popover primitive calls.
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
]

function open(searchPlaceholder?: string) {
  render(
    <Combobox
      id="under-test"
      value="gmail"
      options={OPTIONS}
      searchPlaceholder={searchPlaceholder}
    />,
  )
  fireEvent.click(document.getElementById("under-test") as HTMLElement)
  const content = document.querySelector(
    '[data-slot="combobox-content"]',
  ) as HTMLElement
  expect(content, "the combobox must open its list").not.toBeNull()
  return content
}

describe("the open list's type-to-filter row", () => {
  it("is built from the drawing's flat chrome, not the palette's field pill", () => {
    const content = open()
    const row = content.querySelector('[data-slot="command-input-wrapper"]')
    expect(row, "the open list draws no search row at all").not.toBeNull()
    expect(
      row!.getAttribute("data-chrome"),
      "the search row is built from the shared field chrome — a bordered, " +
        "separately-filled pill — where the drawing draws a flat row ruled off " +
        "from the options beneath it",
    ).toBe("flush")
  })

  it("drops the bordered field pill the shared chrome wraps the input in", () => {
    const content = open()
    expect(
      content.querySelectorAll('[data-slot="input-group"]').length,
      "a field pill is still drawn inside the open list, so the list holds a " +
        "second control instead of the drawing's row",
    ).toBe(0)
  })

  it("draws the search glyph beside the input, inside the row", () => {
    const content = open()
    const row = content.querySelector(
      '[data-slot="command-input-wrapper"]',
    ) as HTMLElement
    const glyph = row.querySelector('[data-slot="command-input-icon"]')
    const input = row.querySelector('[data-slot="command-input"]')
    expect(glyph, "the drawing opens the row with a search glyph").not.toBeNull()
    expect(input, "the row holds the type-to-filter input").not.toBeNull()
    expect(
      glyph!.compareDocumentPosition(input!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      "the glyph is drawn after the input — the drawing opens the row with it",
    ).toBeTruthy()
  })

  it("carries the placeholder its caller passes through to the row", () => {
    const content = open("Search connectors…")
    const input = content.querySelector(
      '[data-slot="command-input"]',
    ) as HTMLInputElement
    expect(input.getAttribute("placeholder")).toBe("Search connectors…")
  })
})
