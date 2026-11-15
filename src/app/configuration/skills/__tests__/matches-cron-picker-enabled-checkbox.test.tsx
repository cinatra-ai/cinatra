// @vitest-environment jsdom
//
// Configuration > Skills > Matches: the schedule's "Enabled" control is a
// checkbox (cinatra#4309, cron-picker site).
//
//   pnpm exec vitest run src/app/configuration/skills/__tests__/matches-cron-picker-enabled-checkbox.test.tsx
//
// The approved component rule for checkboxes reserves switches for settings
// that take effect at once and checkboxes for choices that a form action
// confirms. The schedule is applied only by "Save schedule", so its Enabled
// control is a confirmable form choice: it draws as a checkbox, and changing
// it writes nothing until Save schedule.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { setScheduleAction } = vi.hoisted(() => ({
  setScheduleAction: vi.fn(async (_fd: FormData) => undefined),
}));

vi.mock("../actions", () => ({ setScheduleAction }));
vi.mock("@/lib/cinatra-toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.doUnmock("../actions");
  vi.doUnmock("@/lib/cinatra-toast");
  vi.resetModules();
});

async function renderPicker(enabled: boolean) {
  const { MatchesCronPicker } = await import("../_matches-cron-picker");
  return render(
    <MatchesCronPicker initial={{ enabled, cronExpression: enabled ? "0 9 * * *" : null, timezone: "UTC" }} />,
  );
}

describe("Matches tab: the schedule's Enabled control", () => {
  it("is a checkbox named Enabled, not a switch", async () => {
    await renderPicker(true);
    const control = screen.getByRole("checkbox", { name: "Enabled" });
    expect(control.getAttribute("data-slot")).toBe("checkbox");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("reflects the stored off state and reveals the builder when ticked", async () => {
    await renderPicker(false);
    const control = screen.getByRole("checkbox", { name: "Enabled" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("Frequency")).toBeNull();
    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Frequency")).toBeTruthy();
    expect(setScheduleAction).not.toHaveBeenCalled();
  });

  it("writes nothing when unticked and ticked, and Save schedule while unticked posts the disabled payload", async () => {
    await renderPicker(true);
    const control = screen.getByRole("checkbox", { name: "Enabled" });
    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("Frequency")).toBeNull();
    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(setScheduleAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    expect(setScheduleAction).toHaveBeenCalledTimes(1);
    const fd = setScheduleAction.mock.calls[0][0] as FormData;
    expect(fd.get("enabled")).toBeNull();
    expect(fd.get("cronExpression")).toBeNull();
    expect(fd.get("timezone")).toBe("UTC");
  });

  it("is applied only by Save schedule, which posts enabled=on while ticked", async () => {
    await renderPicker(true);
    expect(setScheduleAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    expect(setScheduleAction).toHaveBeenCalledTimes(1);
    const fd = setScheduleAction.mock.calls[0][0] as FormData;
    expect(fd.get("enabled")).toBe("on");
  });
});
