// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { TriggerScheduleProposalSettledView } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ScheduleProposalCard } from "../schedule-proposal-card";

const TITLE = "Stop this recurring schedule?";
const DESCRIPTION = "No further runs will start from it. The runs it has already started are not affected, and this run is not changed. The schedule stays here, and you will not be able to change it afterwards.";
const BODY: TriggerScheduleProposalSettledView = {
  phase: "settled", version: 1, agentName: "Weekly cohort sweep", runId: "run-777",
  schedule: { kind: "recurring", timezone: "Europe/Berlin", selection: {
    frequency: "weekly", interval: 1, weekdays: [1, 2, 3, 4, 5], dayOfMonth: 1,
    monthlyMode: "date", nthWeek: 1, monthlyWeekday: 1, quarterAnchor: "start",
    yearlyMonth: 1, hour: 9, minute: 0,
  } },
  triggerType: "recurring", scheduleCopy: "Every weekday at 9:00 AM",
  timezone: "Europe/Berlin", gatedSteps: [], released: false, arming: false,
  canSave: true, canCancel: true,
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mount(host: "run_card" | "page_gate_region", refuse = false) {
  let stopped = false;
  const requests: Record<string, unknown>[] = [];
  const reads = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(init?.body as string) as Record<string, unknown>;
    if (request.op) {
      requests.push(request);
      if (!refuse) stopped = true;
      return new Response(JSON.stringify({ outcome: refuse
        ? { kind: "not-permitted", message: "This action could not be taken on this surface." }
        : { kind: "cancelled" } }), { status: 200 });
    }
    reads();
    return new Response(JSON.stringify({ kind: "trigger_schedule_proposal",
      state: { state: "settled" }, firedOnce: true,
      body: stopped ? { ...BODY, stopped: true, canSave: false, canCancel: false } : BODY,
    }), { status: 200 });
  }));
  const view = render(<LifecycleCardSurfaceProvider host={host}>
    <ScheduleProposalCard view={{ viewType: "trigger_schedule_proposal", schemaVersion: 1, ref: "opaque-schedule-ref" }} />
  </LifecycleCardSurfaceProvider>);
  return { ...view, requests, reads };
}

async function open() {
  fireEvent.click(await screen.findByRole("button", { name: "Cancel schedule" }));
  return screen.getByRole("alertdialog", { name: TITLE });
}

describe("#3280 — the shared destructive schedule-cancel modal", () => {
  for (const host of ["run_card", "page_gate_region"] as const) {
    it(`${host}: portals the shared modal above the card and Keep makes no request`, async () => {
      const view = mount(host);
      const dialog = await open();
      expect(view.container.contains(dialog)).toBe(false);
      expect(dialog.getAttribute("data-slot")).toBe("alert-dialog-content");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.getAttribute("data-conformance-id")).toBe("schedule-cancel-confirm");
      expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe(DESCRIPTION);
      expect(document.querySelector('[data-slot="alert-dialog-overlay"]')).not.toBeNull();
      const cancel = within(dialog).getByRole("button", { name: "Cancel schedule" });
      expect(cancel.className).toContain("bg-destructive");
      expect(cancel.getAttribute("data-action")).toBe("cancel-schedule");
      fireEvent.click(within(dialog).getByRole("button", { name: "Keep schedule" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(view.requests).toEqual([]);
      expect(view.reads).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Cancel schedule" })).toBeTruthy();
      expect(view.container.querySelector('[data-conformance-id="schedule-proposal-floor"]')).not.toBeNull();
    });

    it.each(["Keep schedule", "Escape"] as const)(`${host}: %s restores focus without changing or cancelling the schedule`, async (dismiss) => {
      const view = mount(host);
      const trigger = await screen.findByRole("button", { name: "Cancel schedule" });
      const rows = view.container.querySelector('[data-conformance-id="schedule-option-rows"]')!;
      const before = rows.textContent;
      const beforeInputs = [...rows.querySelectorAll("input")].map((input) => input.value);
      trigger.focus();
      expect(document.activeElement).toBe(trigger);
      fireEvent.click(trigger);
      const dialog = screen.getByRole("alertdialog", { name: TITLE });
      const keep = within(dialog).getByRole("button", { name: "Keep schedule" });
      await waitFor(() => expect(document.activeElement).toBe(keep));
      if (dismiss === "Escape") fireEvent.keyDown(keep, { key: "Escape", code: "Escape" });
      else fireEvent.click(keep);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(screen.getByRole("button", { name: "Cancel schedule" })).toBe(trigger);
      expect(view.requests).toEqual([]);
      expect(view.reads).toHaveBeenCalledTimes(1);
      expect(view.container.querySelector('[data-conformance-id="schedule-option-rows"]')).toBe(rows);
      expect(rows.textContent).toBe(before);
      expect([...rows.querySelectorAll("input")].map((input) => input.value)).toEqual(beforeInputs);
      expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
    });

    it(`${host}: confirms one opaque-ref cancel, then draws the server's stopped readback`, async () => {
      const view = mount(host);
      const dialog = await open();
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel schedule" }));
      await waitFor(() => expect(view.reads).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(view.container.querySelector('[data-conformance-id="schedule-proposal-floor"]')).toBeNull());
      expect(view.requests).toEqual([{ kind: "trigger_schedule_proposal", ref: "opaque-schedule-ref", op: "cancel" }]);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(view.container.querySelector('[data-conformance-id="schedule-option-rows"]')).not.toBeNull();
      // The current read-only form retains its values; it has no prose summary.
      expect(view.container.textContent).toContain("Hour: 09:00");
      expect(view.container.textContent).toContain("Europe/Berlin");
      expect(view.container.querySelectorAll("button, input, [role=combobox]")).toHaveLength(0);
      expect(view.container.querySelector('[data-action="cancel-trigger-schedule"]')).toBeNull();
      for (const field of view.container.querySelectorAll("button, input, [role=combobox]")) {
        expect(field.hasAttribute("disabled") || field.getAttribute("aria-disabled") === "true").toBe(true);
      }
    });
  }

  it("a refused cancel closes the ask and leaves the existing editable schedule", async () => {
    const view = mount("run_card", true);
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel schedule" }));
    await screen.findByText("This action could not be taken on this surface.");
    expect(view.requests).toHaveLength(1);
    expect(view.reads).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(view.container.querySelector('[data-conformance-id="schedule-proposal-floor"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Cancel schedule" }).hasAttribute("disabled")).toBe(false);
  });
});
