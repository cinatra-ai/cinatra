// @vitest-environment jsdom
//
// READING 1 OF cinatra#3004's live-proof round — CONTINUE KEEPS THE FORM WHERE
// IT IS.
//
// What the proofs showed: pressing **Continue** on the run page's scheduling
// step left that surface and landed the reader somewhere else, where the
// schedule was drawn again as a different thing. The plan's words for the
// moment after the press: "After Confirm the card stays where it is and stays
// editable … the same option rows show the schedule as it stands."
//
// SO THE PRESS THAT ARMS A SCHEDULE NAVIGATES NOWHERE. It re-renders the
// surface it was pressed on, and that surface — the run page's schedule step,
// the run's schedule surface, and (when it lands) the setup rail's schedule
// step, all of which mount THIS component — comes back drawing the armed form
// through the one schedule renderer.
//
// AND "RUN RIGHT AFTER SETUP" STILL GOES TO THE RUN. That press is not a
// schedule at all: it starts the run, and the run page is where a run is
// watched. Its landing is unchanged.
//
// Run:
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/schedule-continue-in-place-3004.test.tsx
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const routerState = vi.hoisted(() => ({
  push: vi.fn() as ReturnType<typeof vi.fn>,
  refresh: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerState.push, refresh: routerState.refresh }),
}));

vi.mock("../run-actions", () => ({
  setRunTrigger: vi.fn(),
}));

import { setRunTrigger } from "../run-actions";
import {
  TriggerScreenClient,
  scheduleContinueLanding,
  type TriggerScreenClientProps,
} from "../trigger-screen-client";

const mockedSetRunTrigger = vi.mocked(setRunTrigger);

function renderForm(overrides: Partial<TriggerScreenClientProps> = {}) {
  const props: TriggerScreenClientProps = {
    agentId: "demo-agent",
    instanceId: "run-abc",
    templateId: "tpl-test",
    durationEstimate: undefined,
    inputParams: {},
    requiredFields: [],
    properties: {},
    setupComplete: true,
    ...overrides,
  };
  return render(<TriggerScreenClient {...props} />);
}

beforeEach(() => {
  routerState.push.mockReset();
  routerState.refresh.mockReset();
  mockedSetRunTrigger.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("scheduleContinueLanding — where the press lands, read on its own", () => {
  it("keeps a schedule on the surface it was armed from", () => {
    expect(scheduleContinueLanding("scheduled")).toBe("in-place");
    expect(scheduleContinueLanding("recurring")).toBe("in-place");
  });

  it("sends **Run right after setup** to the run, which is what that press starts", () => {
    expect(scheduleContinueLanding("immediate")).toBe("run-page");
  });

  it("sends a kind nobody has named a schedule surface for to the run as well", () => {
    // The two SCHEDULED kinds are named; anything else keeps the landing it
    // has always had rather than staying on a surface that draws nothing for
    // it (the resolver answers `absent` for exactly those rows).
    expect(scheduleContinueLanding("webhook")).toBe("run-page");
  });
});

describe("Continue on a schedule re-renders the surface instead of leaving it", () => {
  it("a one-off: the step redraws in place, and the reader is not navigated", async () => {
    mockedSetRunTrigger.mockResolvedValueOnce({ ok: true, runId: "abc", jobSchedulerId: null });
    renderForm({ agentId: "demo-agent", instanceId: "abc" });
    fireEvent.click(screen.getByText("Schedule for later"));
    fireEvent.change(document.querySelector("#scheduledAt") as HTMLInputElement, {
      target: { value: "2099-01-01T09:00" },
    });
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => {
      expect(routerState.refresh).toHaveBeenCalledTimes(1);
    });
    expect(routerState.push).not.toHaveBeenCalled();
    expect(mockedSetRunTrigger).toHaveBeenCalledTimes(1);
    expect(mockedSetRunTrigger.mock.calls[0][0]).toMatchObject({
      runId: "abc",
      triggerType: "scheduled",
    });
  });

  it("a recurring schedule: the same, on the same press", async () => {
    mockedSetRunTrigger.mockResolvedValueOnce({ ok: true, runId: "abc", jobSchedulerId: null });
    renderForm({ agentId: "demo-agent", instanceId: "abc" });
    fireEvent.click(screen.getByText("Recurring"));
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => {
      expect(routerState.refresh).toHaveBeenCalledTimes(1);
    });
    expect(routerState.push).not.toHaveBeenCalled();
    expect(mockedSetRunTrigger.mock.calls[0][0]).toMatchObject({ triggerType: "recurring" });
  });

  it("**Run right after setup** still lands on the run page — that press starts the run", async () => {
    mockedSetRunTrigger.mockResolvedValueOnce({ ok: true, runId: "abc", jobSchedulerId: null });
    renderForm({ agentId: "demo-agent", instanceId: "abc" });
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => {
      expect(routerState.push).toHaveBeenCalledTimes(1);
    });
    expect(routerState.push).toHaveBeenCalledWith("/agents/demo-agent/abc");
    expect(routerState.refresh).not.toHaveBeenCalled();
  });

  it("a refused write navigates nowhere at all and says why", async () => {
    mockedSetRunTrigger.mockResolvedValueOnce({ ok: false, error: "Nope." });
    renderForm({ agentId: "demo-agent", instanceId: "abc" });
    fireEvent.click(screen.getByText("Recurring"));
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => {
      expect(screen.getByText("Nope.")).toBeTruthy();
    });
    expect(routerState.push).not.toHaveBeenCalled();
    expect(routerState.refresh).not.toHaveBeenCalled();
  });
});
