// @vitest-environment jsdom
//
// The "Skills autosave" row of the prompt field's options menu (cinatra#4297).
//
// Design specs/app-components.html: "Switches are reserved for
// immediate-effect settings; checkboxes for confirmable form choices". The
// autosave row takes effect the moment it is toggled (the menu stays open and
// `onToggle` fires at once), so the row draws a switch, not a checkbox.
//
// This suite renders the real `PromptField` with `autosave` set, opens the
// options menu, and reads the row: it must draw the switch primitive and no
// checkbox, the switch must show the current value, and a toggle must call
// `onToggle` with the new value.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PromptField, type PromptFieldAutosave } from "../prompt-field";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function openAutosaveRow(autosave: PromptFieldAutosave): HTMLElement {
  render(
    <PromptField storageKey="test-4297" onSubmit={() => {}} autosave={autosave} />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Prompt options" }), { key: "Enter" });
  return screen.getByRole("menuitemcheckbox", { name: "Skills autosave" });
}

describe("PromptField Skills autosave row (cinatra#4297)", () => {
  it("draws a switch, not a checkbox, showing the current value", () => {
    const row = openAutosaveRow({ enabled: false, canToggle: true, onToggle: vi.fn() });
    const control = row.querySelector("[data-slot='switch']");
    expect(control).not.toBeNull();
    expect(control?.querySelector("[data-slot='switch-thumb']")).not.toBeNull();
    expect(control?.getAttribute("data-state")).toBe("unchecked");
    const switchRole = screen.getByRole("switch", { hidden: true });
    expect(switchRole).toBe(control);
    expect(switchRole.getAttribute("aria-checked")).toBe("false");
    expect(row.querySelector("[data-slot='checkbox']")).toBeNull();
    expect(row.getAttribute("aria-checked")).toBe("false");
  });

  it("shows the switch on when autosave is enabled", () => {
    const row = openAutosaveRow({ enabled: true, canToggle: true, onToggle: vi.fn() });
    expect(row.querySelector("[data-slot='switch']")?.getAttribute("data-state")).toBe("checked");
    expect(screen.getByRole("switch", { hidden: true }).getAttribute("aria-checked")).toBe("true");
    expect(row.getAttribute("aria-checked")).toBe("true");
  });

  it("calls onToggle with the new value and keeps the menu open", () => {
    const onToggle = vi.fn();
    const row = openAutosaveRow({ enabled: false, canToggle: true, onToggle });
    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(screen.getByRole("menuitemcheckbox", { name: "Skills autosave" })).toBeTruthy();
  });

  it("calls onToggle with false when autosave is on", () => {
    const onToggle = vi.fn();
    const row = openAutosaveRow({ enabled: true, canToggle: true, onToggle });
    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("keeps the row disabled when no toggle handler is given", () => {
    // `hasLeftMenu` needs `canToggle`, so the disabled row is reached through
    // the missing handler; the switch still shows the value.
    const row = openAutosaveRow({ enabled: true, canToggle: true });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.querySelector("[data-slot='switch']")?.getAttribute("data-state")).toBe("checked");
  });
});
