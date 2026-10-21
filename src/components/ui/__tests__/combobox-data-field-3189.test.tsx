// @vitest-environment jsdom
//
// THE COMBOBOX PASSES `data-field` TO ITS TRIGGER (cinatra#3189).
//
// A form that addresses its fields by `data-field` (the schedule card does)
// has to find the element that carries `disabled` and the drawn value. The
// Combobox takes that one attribute and stamps it on its trigger; nothing else
// passes through, and without it nothing is stamped.
import * as React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { Combobox } from "@/components/ui/combobox"

// jsdom shims — the app's Select (Radix) and the Combobox's popover and list
// call layout APIs jsdom omits. Test-environment only.
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

afterEach(() => {
  cleanup()
})

const OPTIONS = [{ value: "alpha" }, { value: "beta" }]

describe("Combobox data-field (cinatra#3189)", () => {
  it("stamps data-field on the trigger, beside disabled and the drawn value", () => {
    const { container } = render(
      <Combobox value="beta" onValueChange={() => {}} options={OPTIONS} data-field="some-field" disabled />,
    )
    const trigger = container.querySelector('[data-field="some-field"]') as HTMLButtonElement | null
    expect(trigger).not.toBeNull()
    expect(trigger!.getAttribute("data-slot")).toBe("combobox-trigger")
    expect(trigger!.disabled).toBe(true)
    expect(trigger!.querySelector('[data-slot="combobox-value"]')?.textContent).toBe("beta")
    expect(container.querySelectorAll("[data-field]")).toHaveLength(1)
  })

  it("stamps nothing when no data-field is given", () => {
    const { container } = render(<Combobox value="beta" onValueChange={() => {}} options={OPTIONS} />)
    expect(container.querySelectorAll("[data-field]")).toHaveLength(0)
    expect(container.querySelector('[data-slot="combobox-trigger"]')).not.toBeNull()
  })
})
