/**
 * Trigger tab visibility unit coverage.
 *
 * Locks the visibility rule per DESIGN.md §"Two Distinct Surfaces":
 *   - row exists AND triggerType IN ('scheduled','recurring') → persistent tab
 *   - otherwise → first-step form
 *
 * Tested in isolation via the exported `shouldShowPersistentTab` helper, so
 * the rule is independent of DB / auth / Next.js render machinery.
 *
 * Run:
 *   cd packages/agent-builder && pnpm exec vitest run src/__tests__/trigger-tab-visibility.test.tsx
 */
import { describe, expect, it } from "vitest";

import {
  isTerminalRunStatus,
  shouldShowFinishedRunNotice,
  shouldShowPersistentTab,
} from "../instance-screens";

describe("shouldShowPersistentTab", () => {
  it("returns false for null trigger (no row)", () => {
    expect(shouldShowPersistentTab(null)).toBe(false);
  });

  it("returns false for triggerType === 'immediate'", () => {
    expect(shouldShowPersistentTab({ triggerType: "immediate" })).toBe(false);
  });

  it("returns true for triggerType === 'scheduled'", () => {
    expect(shouldShowPersistentTab({ triggerType: "scheduled" })).toBe(true);
  });

  it("returns true for triggerType === 'recurring'", () => {
    expect(shouldShowPersistentTab({ triggerType: "recurring" })).toBe(true);
  });

  it("returns false for an unknown / future triggerType (defensive)", () => {
    expect(shouldShowPersistentTab({ triggerType: "webhook" })).toBe(false);
  });

  // cinatra#2482 Defect 1 — "the Trigger tab appears, then disappears".
  //
  // The asymmetry that produced it (Setup computing the persistent-tab rule,
  // /trigger hardcoding `!!run`) was removed by cinatra#2487: all three routes
  // now feed the strip from THIS one predicate. The regression that would bring
  // the defect back is a route re-introducing its own rule, so what has to hold
  // is that the predicate depends on the TRIGGER ROW ALONE — nothing about
  // which route is being rendered, and nothing about the run.
  //
  // The nav-level route matrix is locked separately in
  // `src/components/__tests__/agent-instance-nav.test.tsx`; this case pins the
  // immediate-trigger input that the issue was filed on.
  it("gives the immediate-trigger run ONE answer for every route (cinatra#2482 Defect 1)", () => {
    const immediate = { triggerType: "immediate" };
    // Same input, evaluated once per route the strip renders on.
    const perRoute = ["setup", "trigger", "permissions"].map(() =>
      shouldShowPersistentTab(immediate),
    );
    expect(new Set(perRoute).size).toBe(1);
    expect(perRoute).toEqual([false, false, false]);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2482 Defect 2 — the /trigger half of the dead-end loop.
// ---------------------------------------------------------------------------
describe("isTerminalRunStatus", () => {
  it.each(["completed", "failed", "stopped"])("is true for %s", (status) => {
    expect(isTerminalRunStatus(status)).toBe(true);
  });

  it.each([
    "pending_input",
    "pending_trigger",
    "armed",
    "queued",
    "running",
    "pending_approval",
    "waiting_trigger",
  ])("is false for the live status %s — the trigger form still applies", (status) => {
    expect(isTerminalRunStatus(status)).toBe(false);
  });

  it("is false for a missing status rather than hiding the form", () => {
    expect(isTerminalRunStatus(null)).toBe(false);
    expect(isTerminalRunStatus(undefined)).toBe(false);
  });
});

describe("shouldShowFinishedRunNotice", () => {
  const immediate = { triggerType: "immediate" };

  it.each(["completed", "failed", "stopped"])(
    "states the finished condition for a %s run whose trigger step is already done",
    (status) => {
      expect(shouldShowFinishedRunNotice(immediate, status)).toBe(true);
    },
  );

  // THE regression a live walk caught, and the reason both halves exist.
  //
  // `completed` with NO trigger row is the GENUINE setup-success state the
  // standalone form is built for (cinatra#580): setup finished, no trigger
  // chosen yet, and the run view redirects here so the user can choose one.
  // An earlier cut gated on terminal status alone and told that user their run
  // was over on the very screen that exists to start it.
  it.each(["completed", "failed", "stopped"])(
    "stays silent for a %s run that has NO trigger yet (cinatra#580 setup-success)",
    (status) => {
      expect(shouldShowFinishedRunNotice(null, status)).toBe(false);
    },
  );

  it.each(["pending_input", "pending_trigger", "armed", "queued", "running"])(
    "stays silent for a live run (%s) even once a trigger row exists",
    (status) => {
      expect(shouldShowFinishedRunNotice(immediate, status)).toBe(false);
    },
  );

  it("never fires with neither half satisfied", () => {
    expect(shouldShowFinishedRunNotice(null, "running")).toBe(false);
  });

  // The predicate gates the NOTICE only, and it still does: a finished
  // immediate run lands on the standalone branch either way, because
  // `shouldShowPersistentTab` sends only scheduled/recurring rows to the
  // persistent tab. What that branch OFFERS is a separate decision, taken by
  // `shouldFreezeFiredOneOffSchedule` once the one-off has fired (cinatra#2980,
  // plan (A) §7.2 item 4) and locked in
  // `trigger-tab-finished-immediate-2980.test.ts`.
  it("does not imply the persistent tab — a finished immediate run keeps the form route", () => {
    expect(shouldShowFinishedRunNotice(immediate, "completed")).toBe(true);
    expect(shouldShowPersistentTab(immediate)).toBe(false);
  });
});
