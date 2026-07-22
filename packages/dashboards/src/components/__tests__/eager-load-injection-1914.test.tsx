// @vitest-environment jsdom
// cinatra#1914 — the grid container injects DC's config-level `eagerLoad`
// flag at MOUNT (so cards fetch without waiting for the on-screen visibility
// signal) and strips it again on the SAVE path, keyed on whether the stored
// config carried an `eagerLoad` key at all:
//
//   initial absent  → mount with eagerLoad:true, persist WITHOUT the key
//   initial true    → pass through untouched, persist true
//   initial false   → NO injection (authored lazy opt-out), persist false
//
// Key PRESENCE decides, never truthiness — and both save paths (the
// debounced onConfigChange schedule and the explicit onSave flush) must
// strip symmetrically, or every save would silently mutate stored rows and
// the autosave baseline would go phantom-dirty.
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Capture the props the container hands the composed dashboard; the tests
// drive onSave/onConfigChange exactly as DC would (echoing the mounted
// config back, which is what DC's state machine does).
const composed = vi.hoisted(() => ({
  props: null as null | {
    config?: Record<string, unknown>;
    onSave?: (next: unknown) => Promise<void>;
    onConfigChange?: (next: unknown) => void;
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

const PORTLETS = [{ id: "p1" }];
// A REAL edit relative to PORTLETS — the autosave coordinator only calls the
// action when the (stripped) config differs from its persisted baseline, so
// save-path assertions must echo a genuine change, not just the injected flag.
const EDITED = [{ id: "p1" }, { id: "p2" }];

afterEach(() => cleanup());
beforeEach(() => {
  composed.props = null;
});

async function flushSave(next: unknown): Promise<void> {
  await act(async () => {
    await composed.props!.onSave!(next);
  });
}

describe("eagerLoad injection + save-path strip (cinatra#1914)", () => {
  test("stored config WITHOUT eagerLoad: mounts eager, persists without the key (flush path)", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(
      <DashboardGridContainer
        initialConfig={{ portlets: PORTLETS } as never}
        editable
        onSave={onSave}
      />,
    );
    expect(composed.props!.config).toMatchObject({ eagerLoad: true });

    // Echoing the mounted config UNCHANGED (just the injected flag) must be
    // a no-op: after the strip it equals the baseline — no phantom-dirty
    // write ever reaches the action.
    await flushSave({ portlets: PORTLETS, eagerLoad: true });
    expect(onSave).toHaveBeenCalledTimes(0);

    // A real edit persists — WITHOUT the injected key.
    await flushSave({ portlets: EDITED, eagerLoad: true });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect("eagerLoad" in (onSave.mock.calls[0]![0] as object)).toBe(false);
  });

  test("stored config WITHOUT eagerLoad: the debounced onConfigChange path strips too", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(
      <DashboardGridContainer
        initialConfig={{ portlets: PORTLETS } as never}
        editable
        onSave={onSave}
      />,
    );
    act(() => {
      composed.props!.onConfigChange!({ portlets: EDITED, eagerLoad: true });
    });
    // The schedule debounce is 350ms; wait for the flush to reach the action.
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    expect("eagerLoad" in (onSave.mock.calls[0]![0] as object)).toBe(false);
  });

  test("authored eagerLoad:true passes through untouched and persists true", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(
      <DashboardGridContainer
        initialConfig={{ portlets: PORTLETS, eagerLoad: true } as never}
        editable
        onSave={onSave}
      />,
    );
    expect(composed.props!.config).toMatchObject({ eagerLoad: true });
    await flushSave({ portlets: EDITED, eagerLoad: true });
    expect(onSave.mock.calls[0]![0]).toMatchObject({ eagerLoad: true });
  });

  test("authored eagerLoad:false is a lazy opt-out: no injection, persists false", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(
      <DashboardGridContainer
        initialConfig={{ portlets: PORTLETS, eagerLoad: false } as never}
        editable
        onSave={onSave}
      />,
    );
    expect(composed.props!.config).toMatchObject({ eagerLoad: false });
    await flushSave({ portlets: EDITED, eagerLoad: false });
    expect(onSave.mock.calls[0]![0]).toMatchObject({ eagerLoad: false });
  });

  test("read-only mount injects too (detail dashboards must also fetch eagerly)", () => {
    render(
      <DashboardGridContainer
        initialConfig={{ portlets: PORTLETS } as never}
        editable={false}
      />,
    );
    expect(composed.props!.config).toMatchObject({ eagerLoad: true });
    expect(composed.props!.editable).toBe(false);
  });
});
