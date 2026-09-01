// @vitest-environment jsdom
//
// A COMBOBOX ROW IS IDENTIFIED BY ITS OPTION'S VALUE, NEVER BY ITS LABEL.
//
//   pnpm exec vitest run src/components/ui/__tests__/combobox-option-identity.test.tsx
//
// The generic Combobox contracts `value` as the unique half of an option and
// `label` as the drawn half — "What the row and the trigger draw. Defaults to
// `value`." Two options may therefore legitimately carry the SAME label, and
// the list primitive underneath identifies a row by the `value` it is handed:
// two rows handed the same one collide, and the highlight and the keyboard
// selection then address the wrong row.
//
// So the row is handed the option's own value, and the label rides in the
// keywords the search matches on, which is what keeps typing a label a way to
// find its row.
import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

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

/** Two zones of the same city name — same label, different values. */
const SHARED_LABEL = [
  { value: "America/Santiago", label: "Santiago" },
  { value: "Atlantic/Santiago", label: "Santiago" },
  { value: "Europe/Berlin", label: "Berlin" },
]

function open(options: typeof SHARED_LABEL, value?: string) {
  const onValueChange = vi.fn()
  render(
    <Combobox
      id="under-test"
      value={value}
      options={options}
      onValueChange={onValueChange}
    />,
  )
  fireEvent.click(document.getElementById("under-test") as HTMLElement)
  const list = document.querySelector('[data-slot="command-list"]') as HTMLElement
  expect(list, "the combobox must open its list").not.toBeNull()
  return { list, onValueChange }
}

function rows(list: HTMLElement): HTMLElement[] {
  return Array.from(
    list.querySelectorAll('[data-slot="command-item"]'),
  ) as HTMLElement[]
}

describe("options that share a label", () => {
  it("give the list primitive a DISTINCT identity per row", () => {
    const { list } = open(SHARED_LABEL)
    const identities = rows(list).map((row) => row.getAttribute("data-value"))
    expect(identities.length).toBe(SHARED_LABEL.length)
    expect(
      new Set(identities).size,
      `two rows were handed the same identity (${identities.join(", ")}) — the ` +
        "highlight and the keyboard selection then address the wrong row",
    ).toBe(identities.length)
  })

  it("commits the value of the row that was chosen, not the first row sharing its label", () => {
    const { list, onValueChange } = open(SHARED_LABEL)
    const second = rows(list)[1]
    fireEvent.click(second)
    expect(onValueChange).toHaveBeenCalledWith("Atlantic/Santiago")
  })

  it("checks exactly the bound option, even while its label is drawn twice", () => {
    const { list } = open(SHARED_LABEL, "Atlantic/Santiago")
    const checked = rows(list).filter(
      (row) => row.getAttribute("data-checked") === "true",
    )
    expect(checked.length).toBe(1)
    expect(checked[0].getAttribute("data-value")).toBe("Atlantic/Santiago")
  })
})

describe("the label stays searchable once the row is identified by its value", () => {
  it("typing a label narrows the list to the rows that draw it", () => {
    const { list } = open(SHARED_LABEL)
    const search = document.querySelector('[data-slot="command-input"]')
    expect(search, "the combobox must offer a type-to-filter input").not.toBeNull()
    fireEvent.change(search as HTMLInputElement, { target: { value: "Santiago" } })
    const drawn = rows(list).map((row) => (row.textContent ?? "").trim())
    expect(drawn.length).toBe(2)
    expect(screen.queryByText("Berlin")).toBeNull()
  })
})

describe("the highlight follows the bound value, not only the first mount", () => {
  // cmdk reads a seed ONCE, when the list mounts. The list is seeded with the
  // bound value so it opens on the current value's row — highlighted and
  // checked at once, the way the drawing draws it. A value that changes from
  // OUTSIDE while the list is open must move the highlight with the check:
  // otherwise the check sits on one row and the highlight on another, and the
  // keyboard commit addresses the row the reader is no longer looking at.
  it("moves the highlight when the bound value changes while the list is open", () => {
    const view = render(
      <Combobox id="under-test" value="America/Santiago" options={SHARED_LABEL} />,
    )
    fireEvent.click(document.getElementById("under-test") as HTMLElement)
    const list = document.querySelector(
      '[data-slot="command-list"]',
    ) as HTMLElement
    expect(list, "the combobox must open its list").not.toBeNull()
    const highlighted = () =>
      rows(list)
        .filter((row) => row.getAttribute("data-selected") === "true")
        .map((row) => row.getAttribute("data-value"))
    expect(highlighted(), "the list opens on the bound row").toEqual([
      "America/Santiago",
    ])

    view.rerender(
      <Combobox id="under-test" value="Europe/Berlin" options={SHARED_LABEL} />,
    )
    const list2 = document.querySelector(
      '[data-slot="command-list"]',
    ) as HTMLElement
    const checked = rows(list2)
      .filter((row) => row.getAttribute("data-checked") === "true")
      .map((row) => row.getAttribute("data-value"))
    expect(checked).toEqual(["Europe/Berlin"])
    expect(
      rows(list2)
        .filter((row) => row.getAttribute("data-selected") === "true")
        .map((row) => row.getAttribute("data-value")),
      "the highlight stayed on the row the value left — the check and the " +
        "highlight then name different rows, and the keyboard commit takes the " +
        "row the reader is no longer looking at",
    ).toEqual(["Europe/Berlin"])
  })
})
