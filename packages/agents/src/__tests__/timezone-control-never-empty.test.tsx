// @vitest-environment jsdom
/**
 * NEITHER TIMEZONE CONTROL CAN DRAW EMPTY (cinatra#3142 §1, acceptance 1 and 3).
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/timezone-control-never-empty.test.tsx
 *
 * On the schedule step both Timezone controls — the one in the scheduled block
 * and the one in the recurring block — drew with no selected value, in light and
 * in dark: a required field whose value a person cannot read before pressing
 * Continue.
 *
 * The drawing, of the select family: "a select trigger inherits the input chrome
 * and shows its current value"; and, for a list this long, "Reach for it over
 * Select whenever the option count passes ~8", the type-to-filter combobox being
 * the drawn control past that size, where "the current value carries an indigo
 * check".
 *
 * This suite drives the three conditions the issue names deliberately — the
 * ordinary case, `Intl.supportedValuesOf` throwing, and a bound timezone of the
 * empty string — and asserts that in no case is either trigger's text empty.
 * It then asserts the drawn behaviour of the control the size rule asks for:
 * typing filters the list, and the current value carries the check.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

// ---------------------------------------------------------------------------
// jsdom shims — the popover/list primitives call layout APIs jsdom omits.
// ---------------------------------------------------------------------------
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../run-actions", () => ({
  setRunTrigger: vi.fn(),
}));

import {
  TriggerScreenClient,
  type TriggerScreenClientProps,
} from "../trigger-screen-client";
import { TIMEZONE_DEGRADED_NOTE, TIMEZONE_PLACEHOLDER } from "../trigger-timezone";

/** A stand-in for the browser's full IANA set — far past the drawing's ~8. */
const ZONES = [
  "Africa/Cairo",
  "America/Chicago",
  "America/New_York",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Madrid",
  "Pacific/Auckland",
  "UTC",
];

const STATED = {
  kind: "scheduled" as const,
  runAt: "2030-04-01T09:00",
  timezone: "Europe/Berlin",
};

const TRIGGER_IDS = ["timezone-scheduled", "timezone-recurring"] as const;

function renderStep(overrides: Partial<TriggerScreenClientProps> = {}) {
  const props = {
    agentId: "demo-agent",
    instanceId: "run-abc",
    templateId: "tpl-test",
    humanPresent: true,
    statedSchedule: STATED,
    setupComplete: true,
    ...overrides,
  } as TriggerScreenClientProps;
  return render(<TriggerScreenClient {...props} />);
}

function trigger(id: (typeof TRIGGER_IDS)[number]): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no timezone control with id ${id} on the schedule step`);
  return el;
}

/** The text a reader sees in the closed control. */
function triggerText(id: (typeof TRIGGER_IDS)[number]): string {
  return (trigger(id).textContent ?? "").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  vi.spyOn(Intl, "supportedValuesOf").mockImplementation(
    (() => [...ZONES]) as typeof Intl.supportedValuesOf,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a select trigger shows its current value — the ordinary case", () => {
  it("both Timezone triggers draw readable text, never an empty control", () => {
    renderStep();
    for (const id of TRIGGER_IDS) {
      const text = triggerText(id);
      expect(text, `${id} draws nothing a reader can read`).not.toBe("");
      expect(text).toContain("Europe/Berlin");
    }
  });
});

describe("Intl.supportedValuesOf unavailable — the option list takes its fallback", () => {
  beforeEach(() => {
    vi.spyOn(Intl, "supportedValuesOf").mockImplementation((() => {
      throw new TypeError("supportedValuesOf is not a function");
    }) as typeof Intl.supportedValuesOf);
  });

  it("both Timezone triggers still draw readable text", () => {
    renderStep();
    for (const id of TRIGGER_IDS) {
      expect(
        triggerText(id),
        `${id} draws nothing once the zone list degrades`,
      ).not.toBe("");
    }
  });

  it("the degrade is surfaced beside each control, not swallowed", () => {
    const { container } = renderStep();
    const notes = Array.from(container.querySelectorAll('[data-slot="timezone-degraded"]'));
    expect(
      notes.length,
      "a degraded zone list must be visible beside both controls, not only in a console",
    ).toBe(2);
    for (const note of notes) {
      expect(note.getAttribute("role")).toBe("status");
      expect((note.textContent ?? "").trim()).toBe(TIMEZONE_DEGRADED_NOTE);
    }
  });

  it("the healthy render carries no such note — the two renders are observably different", () => {
    vi.spyOn(Intl, "supportedValuesOf").mockImplementation(
      (() => [...ZONES]) as typeof Intl.supportedValuesOf,
    );
    const { container } = renderStep();
    expect(container.querySelectorAll('[data-slot="timezone-degraded"]').length).toBe(0);
  });
});

describe("a bound timezone of the empty string", () => {
  it("both Timezone triggers draw readable text rather than the empty value", async () => {
    renderStep({ embeddedAsRenderer: true, aiSuggestions: { timezone: "" } });
    await waitFor(() => {
      for (const id of TRIGGER_IDS) {
        expect(
          triggerText(id),
          `${id} passed an empty string straight through to the control`,
        ).not.toBe("");
      }
    });
    for (const id of TRIGGER_IDS) {
      expect(triggerText(id)).not.toBe(TIMEZONE_PLACEHOLDER);
    }
  });
});

describe('"Reach for it over Select whenever the option count passes ~8"', () => {
  it("the browser's full zone set is drawn as the type-to-filter combobox", () => {
    renderStep();
    for (const id of TRIGGER_IDS) {
      expect(
        trigger(id).getAttribute("role"),
        `${id} is still a plain select for a list of ${ZONES.length} zones`,
      ).toBe("combobox");
      expect(trigger(id).getAttribute("data-slot")).toBe("combobox-trigger");
    }
  });

  it("typing filters the list, and the current value carries the indigo check", () => {
    renderStep();
    fireEvent.click(trigger("timezone-scheduled"));

    const list = document.querySelector('[data-slot="command-list"]');
    expect(list, "the combobox must open a filtered list").not.toBeNull();
    const listing = within(list as HTMLElement);

    // The current value carries the check; nothing else does.
    const checked = (list as HTMLElement).querySelectorAll('[data-checked="true"]');
    expect(checked.length).toBe(1);
    expect((checked[0].textContent ?? "").trim()).toBe("Europe/Berlin");
    const mark = checked[0].querySelector("svg");
    expect(mark, "the current value must carry a check").not.toBeNull();
    expect(mark?.getAttribute("class") ?? "").toMatch(/lucide-check/);
    // The check's indigo is declared on the row that reveals it. The ink itself
    // is a colour claim and is measured on the real boot, never here: jsdom
    // resolves no token.
    expect(checked[0].getAttribute("class") ?? "").toMatch(/text-primary/);

    // Typing narrows the list to the matches.
    expect(listing.queryByText("Asia/Tokyo")).not.toBeNull();
    const search = document.querySelector('[data-slot="command-input"]');
    expect(search, "the combobox must offer a type-to-filter input").not.toBeNull();
    fireEvent.change(search as HTMLInputElement, { target: { value: "Berl" } });

    expect(listing.queryByText("Europe/Berlin")).not.toBeNull();
    expect(
      listing.queryByText("Asia/Tokyo"),
      "typing did not filter the list — every zone is still offered",
    ).toBeNull();
  });
});

describe("what the control draws is what the form submits", () => {
  /**
   * ACCEPTANCE 1, THE OTHER HALF (cinatra#3142). A trigger that draws a zone
   * while the field beneath it still holds the blank one is the same fault
   * wearing a better face: the reader reads Europe/Berlin, presses Continue,
   * and the submit either bounces off `z.string().min(1)` or persists the
   * blank. Resolution decides what is DRAWN; the form must hold that same zone.
   */
  async function submitWith(bound: string) {
    const onSubmit = vi.fn();
    const { container } = renderStep({
      embeddedAsRenderer: true,
      aiSuggestions: { timezone: bound },
      onSubmit,
    } as Partial<TriggerScreenClientProps>);
    await waitFor(() => {
      expect(triggerText("timezone-scheduled")).not.toBe("");
    });
    const form = container.querySelector("form");
    expect(form, "the schedule step must render its form").not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    return { onSubmit, drawn: triggerText("timezone-scheduled") };
  }

  it("submits the zone the trigger drew when the bound value is the empty string", async () => {
    const { onSubmit, drawn } = await submitWith("");
    await waitFor(() => {
      expect(
        onSubmit,
        "the form refused its own submit: the control drew a zone the field " +
          "never held, so the required timezone was still empty",
      ).toHaveBeenCalled();
    });
    const values = onSubmit.mock.calls[0]?.[0] as { timezone?: string };
    expect(values.timezone).toBe(drawn);
    expect(values.timezone?.trim()).not.toBe("");
  });

  it("submits the zone the trigger drew when the bound value is blank space", async () => {
    const { onSubmit, drawn } = await submitWith("   ");
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    const values = onSubmit.mock.calls[0]?.[0] as { timezone?: string };
    expect(
      values.timezone,
      "a run of spaces clears the min(1) check and is persisted as the run's " +
        "zone, while the control draws something else entirely",
    ).toBe(drawn);
  });

  it("leaves a zone the person chose exactly as they chose it", async () => {
    const onSubmit = vi.fn();
    const { container } = renderStep({
      embeddedAsRenderer: true,
      aiSuggestions: { timezone: "Asia/Tokyo" },
      onSubmit,
    } as Partial<TriggerScreenClientProps>);
    await waitFor(() => {
      expect(triggerText("timezone-scheduled")).toContain("Asia/Tokyo");
    });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    const values = onSubmit.mock.calls[0]?.[0] as { timezone?: string };
    expect(values.timezone).toBe("Asia/Tokyo");
  });
});
