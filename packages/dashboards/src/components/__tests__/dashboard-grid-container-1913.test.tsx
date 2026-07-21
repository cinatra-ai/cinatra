// @vitest-environment jsdom
// cinatra#1913 — the grid container is the SINGLE seam between our typed save
// results and the third-party drizzle-cube grid. Pins:
//   - a { ok:false } result → in-product toast with the card-naming copy,
//     NOTHING rejects into the grid (the issue's overlay), and the edit is
//     NOT committed as persisted — a later save retries it;
//   - a transport rejection → generic "Not saved" toast, same containment;
//   - a { ok:true } / void result → no toast, commit proceeds.
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { act } from "react";

const toastError = vi.fn();
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() },
}));

// Capture the props the container hands the (heavy, third-party-wrapping)
// composed dashboard; the test drives its onSave exactly as DC would.
const composed = vi.hoisted(() => ({
  props: null as null | {
    onSave?: (next: unknown) => Promise<void>;
    editable?: boolean;
  },
}));
vi.mock("../composed-dashboard", () => ({
  ComposedDashboard: (props: Record<string, unknown>) => {
    composed.props = props as typeof composed.props;
    return <div data-testid="composed" />;
  },
}));

import { DashboardGridContainer } from "../dashboard-grid-container";

const INITIAL = { portlets: [] } as never;
const EDIT = { portlets: [{ id: "p1" }] } as never;

afterEach(() => cleanup());
beforeEach(() => {
  toastError.mockReset();
  composed.props = null;
});

async function driveSave(): Promise<void> {
  // The DC grid awaits onSave; the guard must RESOLVE (never reject) — an
  // unhandled rejection here is exactly the #1913 overlay.
  await act(async () => {
    await composed.props!.onSave!(EDIT);
  });
}

describe("DashboardGridContainer — typed save results at the DC seam (cinatra#1913)", () => {
  test("invalid-config result: card-naming toast, no rejection, edit retries on next save", async () => {
    const onSave = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        reason: "invalid-config",
        message: 'DashboardConfig validation failed: card "Demo": mixed sources.',
      });
    render(
      <DashboardGridContainer initialConfig={INITIAL} editable onSave={onSave} />,
    );
    await driveSave();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      'Not saved: DashboardConfig validation failed: card "Demo": mixed sources.',
    );

    // NOT committed as persisted → the same edit saves again (retry works).
    await driveSave();
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  test("failure without message falls back to the reason copy", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: false, reason: "denied" });
    render(
      <DashboardGridContainer initialConfig={INITIAL} editable onSave={onSave} />,
    );
    await driveSave();
    expect(toastError).toHaveBeenCalledWith(
      "Not saved: You don’t have permission to do that.",
    );
  });

  test("transport rejection: generic toast, still contained", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("fetch failed"));
    render(
      <DashboardGridContainer initialConfig={INITIAL} editable onSave={onSave} />,
    );
    await driveSave();
    expect(toastError).toHaveBeenCalledWith(
      "Not saved — something went wrong. Try again.",
    );
  });

  test("ok result: no toast; legacy void resolution also passes clean", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(
      <DashboardGridContainer initialConfig={INITIAL} editable onSave={onSave} />,
    );
    await driveSave();
    expect(toastError).not.toHaveBeenCalled();

    cleanup();
    composed.props = null;
    const legacyVoid = vi.fn().mockResolvedValue(undefined);
    render(
      <DashboardGridContainer initialConfig={INITIAL} editable onSave={legacyVoid} />,
    );
    await driveSave();
    expect(toastError).not.toHaveBeenCalled();
  });
});
