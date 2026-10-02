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

// THE TRIGGER KNOWS WHICH EDGE IT MEETS ITS LIST ON (cinatra#3142).
//
// The drawing draws the joined pair once, opening downward, and squares only
// the seam. The placement is not the trigger's to choose — the popover layer
// flips the list above the trigger whenever there is no room beneath it — so a
// trigger that squares its BOTTOM corners on `data-[state=open]` alone squares
// the wrong edge for half the placements the layer can produce, which is what
// the third proof round measured. The side the list actually took is therefore
// carried back onto the trigger, and the seam is drawn from that.
//
// The geometry itself is a real-boot reading (the popover layer positions
// nothing in jsdom); what is settleable here is that the trigger publishes the
// side at all, and only while the list is open.
describe("the open trigger's seam follows the list's placement", () => {
  it("carries the side its list took while the list is open", () => {
    render(<Combobox id="under-test" value="gmail" options={OPTIONS} />)
    const trigger = document.getElementById("under-test") as HTMLElement
    expect(
      trigger.getAttribute("data-join"),
      "a closed trigger draws no seam at all, so it must publish no side",
    ).toBeNull()

    fireEvent.click(trigger)
    const content = document.querySelector(
      '[data-slot="combobox-content"]',
    ) as HTMLElement
    expect(content, "the combobox must open its list").not.toBeNull()

    const side = content.getAttribute("data-side")
    expect(
      side,
      "the popover layer publishes the side it placed the list on",
    ).not.toBeNull()
    expect(
      trigger.getAttribute("data-join"),
      `the list was placed on the ${side} side while the trigger squares its ` +
        `seam from "${trigger.getAttribute("data-join")}" — a trigger that ` +
        "cannot see the placement squares the wrong edge whenever the list flips",
    ).toBe(side)
  })

  it("stops publishing a side once the list closes", () => {
    render(<Combobox id="under-test" value="gmail" options={OPTIONS} />)
    const trigger = document.getElementById("under-test") as HTMLElement
    fireEvent.click(trigger)
    expect(trigger.getAttribute("data-join")).not.toBeNull()
    fireEvent.click(trigger)
    expect(
      trigger.getAttribute("data-join"),
      "the closed trigger keeps squaring a seam against a list that is gone",
    ).toBeNull()
  })
})

// THE SEAM LASTS AS LONG AS THE LIST DOES (cinatra#3142, convergence round).
//
// Closing the list does not remove it: the popover layer holds the closing
// content in the document for its own 100ms exit animation, and that content
// keeps the squared corner and the dropped border it was drawn with all the
// way through. A trigger that stops squaring its seam the instant the OPEN
// FLAG turns therefore rounds its corner back underneath a list that is still
// standing flush against it, and the pair reads as two objects with a notch
// between them for the whole of the fade — the very picture the join exists to
// remove, restored on every close.
//
// The exit window is a real-boot behaviour, but its cause is settleable here.
// The layer decides whether to hold a closing node by asking the node whether
// it carries an exit animation; jsdom resolves no animation at all, which is
// why an ordinary jsdom close unmounts on the spot and never enters the window.
// Answering that one question the way a browser answers it — an animation name
// that changes when the node's own `data-state` does — puts the window back,
// and the seam can then be read inside it.
describe("the trigger keeps its seam while the closing list is still standing", () => {
  const realGetComputedStyle = window.getComputedStyle.bind(window)

  afterEach(() => {
    window.getComputedStyle = realGetComputedStyle
  })

  function answerLikeABrowserWithAnExitAnimation() {
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      const styles = realGetComputedStyle(element, pseudo ?? undefined)
      const state = element.getAttribute?.("data-state")
      if (state !== "open" && state !== "closed") return styles
      return new Proxy(styles, {
        get(target, property) {
          if (property === "animationName") {
            return state === "open" ? "combobox-enter" : "combobox-exit"
          }
          const value = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    }) as typeof window.getComputedStyle
  }

  it("still squares the edge it meets while the closing list is on screen", () => {
    answerLikeABrowserWithAnExitAnimation()
    render(<Combobox id="under-test" value="gmail" options={OPTIONS} />)
    const trigger = document.getElementById("under-test") as HTMLElement

    fireEvent.click(trigger)
    const opened = document.querySelector(
      '[data-slot="combobox-content"]',
    ) as HTMLElement
    expect(opened, "the combobox must open its list").not.toBeNull()
    const side = opened.getAttribute("data-side")
    expect(trigger.getAttribute("data-join")).toBe(side)

    fireEvent.click(trigger)
    const closing = document.querySelector(
      '[data-slot="combobox-content"]',
    ) as HTMLElement | null
    expect(
      closing,
      "the closing list left the document at once, so this reading never " +
        "entered the exit window it is meant to measure",
    ).not.toBeNull()
    expect(
      closing!.getAttribute("data-state"),
      "the held node is the CLOSING one",
    ).toBe("closed")

    expect(
      trigger.getAttribute("data-join"),
      "the list is still standing flush against the trigger, squared and " +
        "missing the border on the seam, while the trigger has already " +
        "rounded its corner back — a notch opens between the two halves for " +
        "the whole of the close",
    ).toBe(side)
  })
})
