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

import { Calendar, formatDayKey, fromDayKey, toDayKey } from "@/components/ui/calendar";

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
