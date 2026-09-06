// @vitest-environment jsdom
//
// The conformance harness mount for the in-conversation schedule card
// (cinatra#3161, epic #3155 W5).
//
// WHAT THIS PINS, and why it is not a second copy of the e2e drivers. The
// functional-acceptance drivers assert the nine manifest surfaces in a browser
// against the built app; this asserts what those drivers depend on and what a
// browser run cannot tell you separately — that each harness MOUNT is the
// SHIPPED drawn card, and that every drawn consequence of a press is computed by
// the product rather than written by the harness. If the harness ever started
// naming a floor, a control, a word or a reading itself, this is red.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LifecycleScheduleCardFixtures } from "../lifecycle-schedule-card-fixtures";
import {
  LIFECYCLE_SCHEDULE_CARD_FIXTURES,
  LIFECYCLE_SCHEDULE_CARD_SURFACES,
} from "../lifecycle-schedule-card-fixture-data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(surfaceId: string): HTMLElement {
  const { container } = render(<LifecycleScheduleCardFixtures />);
  const root = container.querySelector(`[data-surface-id="${surfaceId}"]`);
  expect(root, `the fixture row for "${surfaceId}" draws its declared mount`).not.toBeNull();
  return root as HTMLElement;
}

function card(root: HTMLElement): HTMLElement {
  const el = root.querySelector('[data-conformance-id="schedule-proposal-card"]');
  expect(el, "the mount draws the SHIPPED card, not a stand-in").not.toBeNull();
  return el as HTMLElement;
}

function roads(root: HTMLElement): string[] {
  return Array.from(
    root.querySelectorAll('[data-harness-id="schedule-decision-log"] [data-harness-road]'),
  ).map((el) => el.getAttribute("data-harness-road") ?? "");
}

describe("the conformance harness mounts for the schedule card", () => {
  it("draws one mount per manifest surface, each the SHIPPED card on the in-thread host", () => {
    expect(LIFECYCLE_SCHEDULE_CARD_FIXTURES.map((f) => f.surfaceId)).toEqual([
      ...LIFECYCLE_SCHEDULE_CARD_SURFACES,
    ]);
    for (const fixture of LIFECYCLE_SCHEDULE_CARD_FIXTURES) {
      const drawn = card(mount(fixture.surfaceId));
      expect(drawn.getAttribute("data-lifecycle-card")).toBe("trigger_schedule_proposal");
      // The host is READ from the declaration, never passed by the harness.
      expect(drawn.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
      // The phase is chosen by the product from the body the row carries.
      expect(drawn.getAttribute("data-lifecycle-card-phase")).toBe(fixture.body.phase);
      expect(drawn.querySelector('[data-conformance-id="schedule-option-rows"]')).not.toBeNull();
      cleanup();
    }
  });

  it("lets the PRODUCT decide which floor each reading carries", () => {
    // "First shown — nothing exists yet · editable · Confirm" and
    // "Expired — nothing was scheduled · editable · Confirm".
    for (const surfaceId of ["schedule-card-first-shown", "schedule-card-expired"]) {
      const drawn = card(mount(surfaceId));
      expect(drawn.querySelector('[data-conformance-id="schedule-proposal-floor"]')).not.toBeNull();
      expect(drawn.querySelector('[data-action="confirm-schedule-proposal"]')).not.toBeNull();
      expect(drawn.querySelector('[data-action="save-schedule-changes"]')).toBeNull();
      cleanup();
    }
    // "Configured · editable · Save changes" and "Fired, recurring · editable ·
    // Save changes".
    for (const surfaceId of ["schedule-card-configured", "schedule-card-fired-recurring"]) {
      const drawn = card(mount(surfaceId));
      expect(drawn.querySelector('[data-action="save-schedule-changes"]')).not.toBeNull();
      expect(drawn.querySelector('[data-action="confirm-schedule-proposal"]')).toBeNull();
      cleanup();
    }
    // "Fired, one-off — the schedule was spent · read-only · none at all": the
    // card carries no floor at all, no hairline, no button, nothing to press.
    const spent = card(mount("schedule-card-fired"));
    expect(spent.querySelector('[data-conformance-id="schedule-proposal-floor"]')).toBeNull();
    // Nothing to press: the rows stand, the values stay legible, and every
    // control the card still draws is dead — the pickers are gone with them.
    for (const control of Array.from(spent.querySelectorAll("button"))) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
    }
    for (const field of Array.from(spent.querySelectorAll("input"))) {
      expect((field as HTMLInputElement).disabled).toBe(true);
    }
    // Only the expired reading adds a line above the rows.
    expect(spent.querySelector('[data-conformance-id="schedule-proposal-expired"]')).toBeNull();
    expect(
      card(mount("schedule-card-expired")).querySelector(
        '[data-conformance-id="schedule-proposal-expired"]',
      ),
    ).not.toBeNull();
  });

  it("presses the shipped Confirm and the PRODUCT composes the request and the in-flight floor", async () => {
    const root = mount("schedule-card-confirm-floor");
    const confirm = card(root).querySelector('[data-action="confirm-schedule-proposal"]');
    fireEvent.click(confirm as HTMLElement);
    // The card's own in-flight presentation — the word and the dead control are
    // both the component's, computed while its answer is outstanding.
    await waitFor(() => expect(screen.getByText("Confirming…")).toBeTruthy());
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    // An UNEDITED proposal spends the ref it was drawn from: one confirm, and
    // no rows travel with it. The harness recorded what the card asked for; it
    // did not decide it.
    await waitFor(() => expect(roads(root)).toEqual(["confirm"]));
    expect(
      root
        .querySelector('[data-harness-id="schedule-decision-log"] [data-harness-road]')
        ?.getAttribute("data-harness-carried-rows"),
    ).toBe("none");
  });

  it("presses the shipped Save changes and the PRODUCT draws what a landed save means", async () => {
    const root = mount("schedule-card-save-floor");
    const drawn = card(root);
    const save = drawn.querySelector(
      '[data-action="save-schedule-changes"]',
    ) as HTMLButtonElement;
    // The floor is quiet until a row is actually changed, because there is
    // nothing to save until then — the component's rule, not the harness's.
    expect(save.disabled).toBe(true);
    fireEvent.click(
      drawn.querySelector('[data-schedule-option="immediate"] button') as HTMLElement,
    );
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    // The card carries the READER'S rows on a save, and says so once it lands.
    await waitFor(() => expect(roads(root)).toEqual(["save"]));
    expect(
      root
        .querySelector('[data-harness-id="schedule-decision-log"] [data-harness-road]')
        ?.getAttribute("data-harness-carried-rows"),
    ).toBe("the-reader-s-rows");
    // AND THEY ARE THE ROWS THE READER LEFT. The coarse mark says a payload
    // travelled; this says it is the CHANGED schedule and not the one the card
    // opened on, which is the only version of the claim a regression can fail.
    expect(
      root
        .querySelector('[data-harness-id="schedule-decision-log"] [data-harness-road]')
        ?.getAttribute("data-harness-rows"),
    ).toBe(JSON.stringify({ kind: "immediate" }));
    await waitFor(() =>
      expect(
        drawn.querySelector('[data-conformance-id="schedule-saved"]')?.textContent,
      ).toContain("Saved — the trigger is re-armed on these rows."),
    );
    // What was saved is what is armed, so the control goes quiet again.
    await waitFor(() => expect(save.disabled).toBe(true));
  });

  it("names none of the card's own words in the harness itself", () => {
    const harness = readFileSync(
      path.join(__dirname, "..", "lifecycle-schedule-card-fixtures.tsx"),
      "utf8",
    );
    const source = harness.slice(harness.indexOf('import { useCallback'));
    for (const drawn of [
      "Confirming…",
      "Save changes",
      "Saving…",
      "Cancel schedule",
      "Saved —",
      "schedule-proposal-floor",
      "schedule-option-rows",
      "When should this run?",
      "Estimated run duration",
    ]) {
      expect(source, `the harness must not draw or name "${drawn}"`).not.toContain(drawn);
    }
  });
});
