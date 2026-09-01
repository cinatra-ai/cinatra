// @vitest-environment jsdom
/**
 * THE SCHEDULING STEP, AGAINST THE DRAWING THAT GIVES IT (cinatra#3182).
 *
 * Application Design — Components, "Standard scheduling step". Each case below
 * quotes the sentence of that drawing it pins, so a later reader can grade the
 * step against the drawing without leaving this file.
 *
 *   pnpm exec vitest run packages/agents/src/__tests__/trigger-form-per-drawing.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../run-actions", () => ({
  setRunTrigger: vi.fn(),
}));

import {
  TriggerScreenClient,
  type TriggerScreenClientProps,
} from "../trigger-screen-client";
import type { DurationEstimate } from "../trigger-duration-estimate";

function renderForm(overrides: Partial<TriggerScreenClientProps> = {}) {
  const props: TriggerScreenClientProps = {
    agentId: "demo-agent",
    instanceId: "run-abc",
    templateId: "tpl-test",
    inputParams: {},
    requiredFields: [],
    properties: {},
    setupComplete: true,
    ...overrides,
  };
  return render(<TriggerScreenClient {...props} />);
}

/** The row element the drawing draws — the box that carries the disc, the icon and the label. */
function row(label: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-schedule-option="${label}"]`);
  if (el === null) throw new Error(`no option row for ${label}`);
  return el;
}

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// 1. "each row's svg immediately after the radio-disc span"
// ---------------------------------------------------------------------------
describe("every option row carries its icon, between the disc and the label", () => {
  for (const option of ["immediate", "scheduled", "recurring"] as const) {
    it(`draws exactly one icon on the ${option} row, after the disc and before the label`, () => {
      renderForm();
      const head = row(option).querySelector<HTMLElement>("[data-schedule-option-head]");
      expect(head).not.toBeNull();
      const children = Array.from(head!.children);
      expect(children.length).toBe(3);
      expect(children[0].getAttribute("data-schedule-option-disc")).not.toBeNull();
      expect(children[1].tagName.toLowerCase()).toBe("svg");
      expect(children[2].getAttribute("data-schedule-option-label")).not.toBeNull();
      expect(head!.querySelectorAll("svg").length).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. every row's ground is the reserved surface; the chosen row layers the tint
// ---------------------------------------------------------------------------
describe("the rows sit on the reserved surface, not on the card's own ground", () => {
  it("gives every row the --surface-strong base, chosen or not", () => {
    renderForm();
    for (const option of ["immediate", "scheduled", "recurring"] as const) {
      expect(row(option).className).toContain("bg-surface-strong");
    }
  });

  it("layers the primary tint on the chosen row, on that same base", () => {
    renderForm();
    const chosen = row("immediate");
    expect(chosen.className).toContain("bg-surface-strong");
    expect(chosen.className).toContain("from-primary/5");
    expect(chosen.className).toContain("to-primary/5");
  });
});

// ---------------------------------------------------------------------------
// 3. "not the chosen row, so it carries no fields"
// ---------------------------------------------------------------------------
describe("an unchosen row collapses to disc, icon and label", () => {
  it("draws no date, time or timezone control on the unchosen scheduled row", () => {
    renderForm();
    expect(row("scheduled").querySelector("[data-schedule-fields]")).toBeNull();
    expect(screen.queryByLabelText("Run at")).toBeNull();
  });

  it("draws no recurrence control on the unchosen recurring row", () => {
    renderForm();
    expect(row("recurring").querySelector("[data-schedule-fields]")).toBeNull();
    expect(screen.queryByText("Repeat every")).toBeNull();
  });

  it("reveals the fields of the row that IS chosen, and only that row", () => {
    renderForm();
    fireEvent.click(screen.getByText("Recurring"));
    expect(row("recurring").querySelector("[data-schedule-fields]")).not.toBeNull();
    expect(row("scheduled").querySelector("[data-schedule-fields]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. "chosen row border: 1px solid var(--blue)" — in BOTH palettes
// ---------------------------------------------------------------------------
describe("the chosen row's border is the primary token in both palettes", () => {
  it("carries border-primary and no dark-palette boundary override", () => {
    renderForm();
    const chosen = row("immediate");
    expect(chosen.className).toContain("border-primary");
    // A `dark:` boundary utility outranks `border-primary` by specificity, so
    // one on this row is exactly the dark-mode neutral edge the issue measured.
    expect(chosen.className).not.toMatch(/dark:border-/);
    expect(chosen.className).not.toMatch(/dark:bg-input-fill/);
  });
});

// ---------------------------------------------------------------------------
// 5. the duration line reads only wording the drawing gives
// ---------------------------------------------------------------------------
describe("Estimated run duration says only what the drawing draws", () => {
  const estimate: DurationEstimate = {
    source: "history",
    runCount: 12,
    prepMinSeconds: 7200,
    prepMaxSeconds: 14400,
    gatedMinSeconds: 60,
    gatedMaxSeconds: 120,
    confidence: "high",
    notes: "",
    computedAt: new Date().toISOString(),
  };

  it("reads the drawing's own populated wording", () => {
    renderForm({ durationEstimate: estimate });
    expect(screen.getByText("About 2.0 hr – 4.0 hr.")).toBeTruthy();
  });

  it("draws no line at all where there is no estimate — the drawing gives none", () => {
    renderForm({ durationEstimate: null });
    expect(screen.queryByText("Estimated run duration")).toBeNull();
    expect(screen.queryByText("Unavailable.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. "DatePicker is the calendar inside a Popover triggered from an
//    Input-styled button" — no native browser chrome anywhere
// ---------------------------------------------------------------------------
describe("Run at is the app's own control, not the browser's", () => {
  it("reaches the DOM with no native date, time or datetime input", () => {
    const { container } = renderForm();
    fireEvent.click(screen.getByText("Schedule for later"));
    expect(container.querySelector("input[type='datetime-local']")).toBeNull();
    expect(container.querySelector("input[type='date']")).toBeNull();
    expect(container.querySelector("input[type='time']")).toBeNull();
  });

  it("opens the app's own calendar from an Input-styled button", () => {
    renderForm();
    fireEvent.click(screen.getByText("Schedule for later"));
    const trigger = screen.getByLabelText("Run at");
    expect(trigger.tagName.toLowerCase()).toBe("button");
    expect(trigger.getAttribute("data-slot")).toBe("date-picker-trigger");
    expect(trigger.className).toContain("border-input");
    expect(trigger.className).toContain("bg-surface-strong");
  });
});

// ---------------------------------------------------------------------------
// 7. "unselected weekday cell: border: 1px solid var(--line-strong);
//     background: var(--surface-strong)"
// ---------------------------------------------------------------------------
describe("the weekday toggles sit on the reserved surface when unselected", () => {
  it("gives an unselected weekday the reserved ground and the control boundary", () => {
    renderForm();
    fireEvent.click(screen.getByText("Recurring"));
    const sunday = screen.getByRole("button", { name: "Sun" });
    expect(sunday.className).toContain("bg-surface-strong");
    expect(sunday.className).toContain("border-input");
    expect(sunday.className).not.toContain("bg-background");
  });

  it("leaves the selected weekday's fill alone", () => {
    renderForm();
    fireEvent.click(screen.getByText("Recurring"));
    fireEvent.click(screen.getByRole("button", { name: "Mon" }));
    const monday = screen.getByRole("button", { name: "Mon" });
    expect(monday.className).toContain("bg-primary");
    expect(monday.className).toContain("text-primary-foreground");
  });
});

// ---------------------------------------------------------------------------
// 6b. the calendar itself — "the calendar inside a Popover", and what a day
//     chosen in it does to the field the step stores
// ---------------------------------------------------------------------------
describe("the calendar the Run at trigger opens", () => {
  it("draws a month grid with mono weekday heads, and fills Run at from a day", async () => {
    renderForm();
    fireEvent.click(screen.getByText("Schedule for later"));
    fireEvent.click(screen.getByLabelText("Run at"));

    const heads = await screen.findAllByText(
      (_, el) => el?.getAttribute("data-slot") === "calendar-weekday",
    );
    expect(heads.length).toBe(7);
    expect(heads[0].className).toContain("font-mono");

    const days = document.querySelectorAll("[data-slot='calendar-day']");
    expect(days.length).toBeGreaterThanOrEqual(28);

    const day = days[10] as HTMLButtonElement;
    const key = day.getAttribute("data-day") ?? "";
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    fireEvent.click(day);

    // The field the step stores is still one naive local date-time string.
    const stored = document.querySelector<HTMLInputElement>("input[name='scheduledAt']");
    expect(stored?.value).toBe(`${key}T09:00`);
  });
});

// ---------------------------------------------------------------------------
// 8. THE COLLAPSE MUST NOT LOCK THE KEYBOARD OUT (convergence round). Item 3
//    takes the fields of an unchosen row out of the document, and those fields
//    were the only way a keyboard used to reach that row. The rows are one
//    radio group; each row head is a radio.
// ---------------------------------------------------------------------------
describe("a keyboard can choose every row, not only the first", () => {
  function head(option: string): HTMLElement {
    const el = row(option).querySelector<HTMLElement>("[data-schedule-option-head]");
    if (el === null) throw new Error(`no head for ${option}`);
    return el;
  }

  it("groups the rows as one radio group", () => {
    renderForm();
    const group = screen.getByRole("radiogroup", { name: "When should this run?" });
    expect(group.querySelectorAll('[role="radio"]').length).toBe(3);
  });

  it("puts every unchosen row in the tab order and marks it unchecked", () => {
    renderForm();
    // THE HEAD IS THE RADIO IN ALL THREE ROWS. The immediate row used to be
    // its own radio because it was the one row drawn as a bare `button`
    // element; the three rows are one shape now, so the reading is taken from
    // the same place in each of them.
    for (const option of ["immediate", "scheduled", "recurring"] as const) {
      expect(head(option).getAttribute("tabindex")).toBe("0");
    }
    for (const option of ["scheduled", "recurring"] as const) {
      expect(head(option).getAttribute("aria-checked")).toBe("false");
    }
    expect(head("immediate").getAttribute("aria-checked")).toBe("true");
  });

  it("chooses the scheduled row from the keyboard, and reveals its fields", () => {
    renderForm();
    expect(screen.queryByLabelText("Run at")).toBeNull();
    fireEvent.keyDown(head("scheduled"), { key: "Enter" });
    expect(screen.getByLabelText("Run at")).toBeTruthy();
    expect(head("scheduled").getAttribute("aria-checked")).toBe("true");
  });

  it("chooses the recurring row with the space bar", () => {
    renderForm();
    fireEvent.keyDown(head("recurring"), { key: " " });
    expect(row("recurring").querySelector("[data-schedule-fields]")).not.toBeNull();
  });

  it("leaves a space typed inside the chosen row's own fields alone", () => {
    renderForm();
    fireEvent.keyDown(head("scheduled"), { key: "Enter" });
    const trigger = screen.getByLabelText("Run at");
    fireEvent.keyDown(trigger, { key: " ", bubbles: true });
    // Still the scheduled row: the guard did not re-fire the row's own handler
    // on an event that merely passed through it.
    expect(row("scheduled").querySelector("[data-schedule-fields]")).not.toBeNull();
  });

  it("takes the rows out of the tab order in the read-only reading", () => {
    renderForm({ readOnly: true });
    for (const option of ["scheduled", "recurring"] as const) {
      expect(head(option).getAttribute("tabindex")).toBe("-1");
    }
  });
});
