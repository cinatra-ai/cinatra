// @vitest-environment jsdom
//
// THE TIMEZONE FIELD NAMES AND REFUSES ITS OWN CONTROL (cinatra#3189).
//
// The schedule card now draws its Timezone fields with the shared
// `TimezoneField` instead of free text inputs. The card addresses each field by
// `data-field` and draws it refusing for a reader who may see but not act, so
// the component takes both as props and puts them on the ONE element that
// carries `disabled` — the Combobox trigger past the size rule, the
// SelectTrigger at or below it. Without the props nothing changes for the
// in-flow step, which passes neither.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/timezone-field-api-3189.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { TimezoneField } from "../timezone-field";
import type { TimezoneFieldResolution } from "../trigger-timezone";

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
  });
}
if (typeof Element !== "undefined") {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function hasPointerCapture() {
      return false;
    };
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function setPointerCapture() {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function releasePointerCapture() {};
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
  });
}

afterEach(() => {
  cleanup();
});

const MANY: TimezoneFieldResolution = {
  value: "Europe/Berlin",
  options: [
    "America/New_York",
    "Asia/Tokyo",
    "Australia/Sydney",
    "Europe/Berlin",
    "Europe/Lisbon",
    "Europe/London",
    "Europe/Paris",
    "Pacific/Auckland",
    "UTC",
  ],
  degraded: false,
  control: "combobox",
};

const FEW: TimezoneFieldResolution = {
  value: "Europe/Berlin",
  options: ["Europe/Berlin", "Europe/Lisbon", "UTC"],
  degraded: false,
  control: "select",
};

describe("TimezoneField dataField and disabled (cinatra#3189)", () => {
  it("combobox: data-field lands on the trigger, the element that carries disabled", () => {
    const { container } = render(
      <TimezoneField id="tz" field={MANY} onValueChange={() => {}} dataField="recurring-timezone" disabled />,
    );
    const control = container.querySelector('[data-field="recurring-timezone"]') as HTMLButtonElement | null;
    expect(control).not.toBeNull();
    expect(control!.getAttribute("role")).toBe("combobox");
    expect(control!.getAttribute("data-slot")).toBe("combobox-trigger");
    expect(control!.disabled).toBe(true);
    expect(container.querySelectorAll("[data-field]")).toHaveLength(1);
  });

  it("combobox: a disabled trigger does not open its list and changes nothing", () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <TimezoneField id="tz" field={MANY} onValueChange={onValueChange} dataField="recurring-timezone" disabled />,
    );
    fireEvent.click(container.querySelector('[data-field="recurring-timezone"]')!);
    expect(document.querySelector('[data-slot="command-list"]')).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("combobox: an enabled trigger opens and a picked zone reaches onValueChange", () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <TimezoneField id="tz" field={MANY} onValueChange={onValueChange} dataField="schedule-timezone" />,
    );
    const control = container.querySelector('[data-field="schedule-timezone"]') as HTMLButtonElement;
    expect(control.disabled).toBe(false);
    fireEvent.click(control);
    const row = document.querySelector('[data-slot="command-item"][data-value="Europe/Lisbon"]');
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    expect(onValueChange).toHaveBeenCalledWith("Europe/Lisbon");
  });

  it("select: data-field lands on the SelectTrigger, the element that carries disabled", () => {
    const { container } = render(
      <TimezoneField id="tz" field={FEW} onValueChange={() => {}} dataField="schedule-timezone" disabled />,
    );
    const control = container.querySelector('[data-field="schedule-timezone"]') as HTMLButtonElement | null;
    expect(control).not.toBeNull();
    expect(control!.tagName).toBe("BUTTON");
    expect(control!.id).toBe("tz");
    expect(control!.disabled).toBe(true);
    expect(control!.textContent).toBe("Europe/Berlin");
    expect(container.querySelectorAll("[data-field]")).toHaveLength(1);
  });

  it("select: a disabled trigger does not open its list", () => {
    const { container } = render(
      <TimezoneField id="tz" field={FEW} onValueChange={() => {}} dataField="schedule-timezone" disabled />,
    );
    fireEvent.pointerDown(container.querySelector('[data-field="schedule-timezone"]')!, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  for (const [name, field] of [["combobox", MANY], ["select", FEW]] as const) {
    it(`${name}: without the props, no data-field is stamped and nothing is disabled`, () => {
      const { container } = render(<TimezoneField id="tz" field={field} onValueChange={() => {}} />);
      expect(container.querySelectorAll("[data-field]")).toHaveLength(0);
      const trigger = container.querySelector("button") as HTMLButtonElement;
      expect(trigger.disabled).toBe(false);
      expect(trigger.textContent).toContain("Europe/Berlin");
    });
  }
});
