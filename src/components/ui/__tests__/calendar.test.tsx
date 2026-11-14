// @vitest-environment jsdom
/**
 * THE CALENDAR ANSWERS THE KEYBOARD, AND ONLY NAMES DAYS THAT EXIST
 * (cinatra#3182, convergence round).
 *
 * The first draft of this primitive declared `role="grid"` over children that
 * are not rows of cells, put every day of the month in the tab order, named a
 * day "1", and let an impossible key such as 2027-02-30 be normalised into a
 * DIFFERENT day for display while the field still held the impossible one.
 *
 *   pnpm exec vitest run src/components/ui/__tests__/calendar.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Calendar, DatePicker, formatDayKey, fromDayKey, toDayKey } from "@/components/ui/calendar";

afterEach(() => cleanup());

describe("a day key names itself or it names nothing", () => {
  it("reads a real day", () => {
    const d = fromDayKey("2027-02-28");
    expect(d).not.toBeNull();
    expect(toDayKey(d as Date)).toBe("2027-02-28");
  });

  it("refuses an impossible day instead of rolling it forward", () => {
    // `new Date(2027, 1, 30)` is 2 March — drawn as one date, stored as another.
    expect(fromDayKey("2027-02-30")).toBeNull();
    expect(fromDayKey("2027-13-01")).toBeNull();
    expect(fromDayKey("2027-00-10")).toBeNull();
    expect(formatDayKey("2027-02-30")).toBe("2027-02-30");
  });

  it("refuses a key with anything after the day", () => {
    expect(fromDayKey("2027-02-28T09:00")).toBeNull();
    expect(fromDayKey("")).toBeNull();
    expect(fromDayKey(null)).toBeNull();
  });

  it("reads a leap day in a leap year and refuses it outside one", () => {
    expect(fromDayKey("2028-02-29")).not.toBeNull();
    expect(fromDayKey("2027-02-29")).toBeNull();
  });
});

describe("the month is a named group with one tab stop", () => {
  it("names every day the way a reader hears it", () => {
    render(<Calendar value="2027-03-10" today="2027-03-05" />);
    expect(screen.getByRole("button", { name: "March 10, 2027" })).toBeTruthy();
  });

  it("declares the month as a group, not as an ill-formed grid", () => {
    const { container } = render(<Calendar value="2027-03-10" today="2027-03-05" />);
    expect(container.querySelector('[role="grid"]')).toBeNull();
    expect(screen.getByRole("group", { name: "March 2027" })).toBeTruthy();
  });

  it("puts exactly one day in the tab order — the selected one", () => {
    const { container } = render(<Calendar value="2027-03-10" today="2027-03-05" />);
    const tabbable = container.querySelectorAll(
      '[data-slot="calendar-day"][tabindex="0"]',
    );
    expect(tabbable.length).toBe(1);
    expect(tabbable[0].getAttribute("data-day")).toBe("2027-03-10");
  });

  it("falls back to today, then to the first of the month", () => {
    const a = render(<Calendar today="2027-03-05" />);
    expect(
      a.container.querySelector('[data-slot="calendar-day"][tabindex="0"]')
        ?.getAttribute("data-day"),
    ).toBe("2027-03-05");
    cleanup();
    const b = render(<Calendar value="2027-05-02" today="2027-05-09" />);
    fireEvent.click(screen.getByLabelText("Previous month"));
    expect(
      b.container.querySelector('[data-slot="calendar-day"][tabindex="0"]')
        ?.getAttribute("data-day"),
    ).toBe("2027-04-01");
  });
});

describe("the arrows walk the month", () => {
  function dayEl(key: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(`[data-day="${key}"]`);
    if (el === null) throw new Error(`no day ${key}`);
    return el;
  }

  it("moves a day right and a week down", () => {
    render(<Calendar value="2027-03-10" today="2027-03-05" />);
    fireEvent.keyDown(dayEl("2027-03-10"), { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("data-day")).toBe("2027-03-11");
    fireEvent.keyDown(dayEl("2027-03-11"), { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-day")).toBe("2027-03-18");
  });

  it("turns the page under the focus at a month boundary", () => {
    render(<Calendar value="2027-03-01" today="2027-03-05" />);
    fireEvent.keyDown(dayEl("2027-03-01"), { key: "ArrowLeft" });
    expect(screen.getByRole("group", { name: "February 2027" })).toBeTruthy();
    expect(document.activeElement?.getAttribute("data-day")).toBe("2027-02-28");
  });

  it("goes to the ends of the month with Home and End", () => {
    render(<Calendar value="2027-03-10" today="2027-03-05" />);
    fireEvent.keyDown(dayEl("2027-03-10"), { key: "Home" });
    expect(document.activeElement?.getAttribute("data-day")).toBe("2027-03-01");
    fireEvent.keyDown(dayEl("2027-03-01"), { key: "End" });
    expect(document.activeElement?.getAttribute("data-day")).toBe("2027-03-31");
  });

  it("pages a month at a time and clamps a day the next month is too short for", () => {
    render(<Calendar value="2027-03-31" today="2027-03-05" />);
    fireEvent.keyDown(dayEl("2027-03-31"), { key: "PageDown" });
    expect(screen.getByRole("group", { name: "April 2027" })).toBeTruthy();
    expect(document.activeElement?.getAttribute("data-day")).toBe("2027-04-30");
  });

  it("selects the focused day with a click and reports the key", () => {
    const onValueChange = vi.fn();
    render(
      <Calendar value="2027-03-10" today="2027-03-05" onValueChange={onValueChange} />,
    );
    fireEvent.click(dayEl("2027-03-12"));
    expect(onValueChange).toHaveBeenCalledWith("2027-03-12");
  });
});

/** Additive controlled range reading (cinatra#3189); the original cases above stay unchanged. */
type DayRange = { from: string; to: string | null };
function RangeCalendar({ initial = null }: { initial?: DayRange | null }) {
  const [range, setRange] = React.useState<DayRange | null>(initial);
  return <Calendar mode="range" range={range} onRangeChange={setRange} today="2026-05-15" />;
}
function RangePicker() {
  const [range, setRange] = React.useState<DayRange | null>(null);
  return <DatePicker mode="range" range={range} onRangeChange={setRange} today="2026-05-15" />;
}
const rangeDay = (key: string) => document.querySelector<HTMLButtonElement>(`[data-slot="calendar-day"][data-day="${key}"]`)!;

describe("the controlled range carries the approved tint reading", () => {
  it("first click starts an incomplete range; second sorts and completes it", () => {
    render(<RangeCalendar />);
    fireEvent.click(rangeDay("2026-05-18"));
    expect(rangeDay("2026-05-18").getAttribute("data-range-start")).toBe("");
    expect(document.querySelectorAll("[data-range-end]").length).toBe(0);
    fireEvent.click(rangeDay("2026-05-15"));
    expect(rangeDay("2026-05-15").getAttribute("data-range-start")).toBe("");
    expect(rangeDay("2026-05-18").getAttribute("data-range-end")).toBe("");
    expect(rangeDay("2026-05-16").getAttribute("data-in-range")).toBe("");
    expect(rangeDay("2026-05-17").getAttribute("data-in-range")).toBe("");
  });
  it("the interior has soft tint, the start is outlined and the end is filled", () => {
    render(<RangeCalendar initial={{ from: "2026-05-15", to: "2026-05-18" }} />);
    expect(rangeDay("2026-05-16").className).toContain("bg-primary/[0.12]");
    expect(rangeDay("2026-05-16").className).toContain("rounded-none");
    expect(rangeDay("2026-05-15").getAttribute("aria-pressed")).toBe("true");
    expect(rangeDay("2026-05-15").className).toContain("ring-primary");
    expect(rangeDay("2026-05-15").className).not.toContain("bg-primary");
    expect(rangeDay("2026-05-18").className).toContain("bg-primary");
    expect(rangeDay("2026-05-14").hasAttribute("data-in-range")).toBe(false);
    expect(rangeDay("2026-05-19").hasAttribute("data-in-range")).toBe(false);
  });
  it("a third click replaces a complete range with a new start", () => {
    render(<RangeCalendar initial={{ from: "2026-05-15", to: "2026-05-18" }} />);
    fireEvent.click(rangeDay("2026-05-21"));
    expect(rangeDay("2026-05-21").hasAttribute("data-range-start")).toBe(true);
    expect(document.querySelectorAll("[data-in-range], [data-range-end]").length).toBe(0);
    expect(rangeDay("2026-05-15").getAttribute("aria-pressed")).toBe("false");
  });
  it("an equal second endpoint completes a one-day range without an interior", () => {
    render(<RangeCalendar />);
    fireEvent.click(rangeDay("2026-05-15"));
    fireEvent.click(rangeDay("2026-05-15"));
    expect(rangeDay("2026-05-15").hasAttribute("data-range-start")).toBe(true);
    expect(rangeDay("2026-05-15").hasAttribute("data-range-end")).toBe(true);
    expect(document.querySelectorAll("[data-in-range]").length).toBe(0);
  });
  it("sorts reversed controlled endpoints without mutating their value", () => {
    const initial = { from: "2026-05-18", to: "2026-05-15" };
    render(<RangeCalendar initial={initial} />);
    expect(rangeDay("2026-05-15").hasAttribute("data-range-start")).toBe(true);
    expect(rangeDay("2026-05-18").hasAttribute("data-range-end")).toBe(true);
    expect(initial).toEqual({ from: "2026-05-18", to: "2026-05-15" });
  });
  it("invalid start names no range; an invalid end leaves only the valid start", () => {
    const a = render(<RangeCalendar initial={{ from: "2026-02-30", to: "2026-05-18" }} />);
    expect(a.container.querySelectorAll("[data-range-start], [data-range-end], [data-in-range]").length).toBe(0);
    cleanup();
    render(<RangeCalendar initial={{ from: "2026-05-15", to: "2026-05-99" }} />);
    expect(rangeDay("2026-05-15").hasAttribute("data-range-start")).toBe(true);
    expect(document.querySelectorAll("[data-range-end], [data-in-range]").length).toBe(0);
  });
  it("reports day-key endpoints and does not change an externally controlled value", () => {
    const onRangeChange = vi.fn();
    render(<Calendar mode="range" range={{ from: "2026-05-15", to: null }} onRangeChange={onRangeChange} today="2026-05-15" />);
    fireEvent.click(rangeDay("2026-05-18"));
    expect(onRangeChange).toHaveBeenCalledWith({ from: "2026-05-15", to: "2026-05-18" });
    expect(document.querySelectorAll("[data-range-end]").length).toBe(0);
  });
  it("preserves one tab stop and keyboard focus across a month boundary", () => {
    render(<RangeCalendar initial={{ from: "2026-05-31", to: null }} />);
    expect(document.querySelectorAll('[data-slot="calendar-day"][tabindex="0"]').length).toBe(1);
    fireEvent.keyDown(rangeDay("2026-05-31"), { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("data-day")).toBe("2026-06-01");
    fireEvent.click(rangeDay("2026-06-02"));
    expect(rangeDay("2026-06-01").hasAttribute("data-in-range")).toBe(true);
    expect(rangeDay("2026-06-02").hasAttribute("data-range-end")).toBe(true);
  });
});

describe("DatePicker preserves single selection and closes a range only when complete", () => {
  it("keeps the popover open after the first range day and closes after the second", () => {
    render(<RangePicker />);
    fireEvent.click(document.querySelector('[data-slot="date-picker-trigger"]')!);
    fireEvent.click(screen.getByRole("button", { name: "May 15, 2026" }));
    expect(screen.queryByRole("button", { name: "May 18, 2026" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "May 18, 2026" }));
    expect(screen.queryByRole("button", { name: "May 18, 2026" })).toBeNull();
    expect(document.querySelector('[data-slot="date-picker-trigger"]')?.textContent).toContain("May 15, 2026 – May 18, 2026");
  });
  it("omitted mode still reports one string and closes on one selection", () => {
    const onValueChange = vi.fn();
    render(<DatePicker id="scheduled-day" value="2026-05-15" today="2026-05-15" onValueChange={onValueChange} className="existing-caller" />);
    fireEvent.click(document.querySelector('[data-slot="date-picker-trigger"]')!);
    fireEvent.click(screen.getByRole("button", { name: "May 18, 2026" }));
    expect(onValueChange).toHaveBeenCalledWith("2026-05-18");
    expect(screen.queryByRole("button", { name: "May 18, 2026" })).toBeNull();
    expect(document.querySelector('#scheduled-day')).not.toBeNull();
    expect(document.querySelector('#scheduled-day')?.className).toContain("existing-caller");
  });
  it("the existing disabled trigger opens no picker in either mode", () => {
    render(<DatePicker mode="range" today="2026-05-15" disabled />);
    expect((document.querySelector('[data-slot="date-picker-trigger"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-slot="calendar"]')).toBeNull();
  });
});
