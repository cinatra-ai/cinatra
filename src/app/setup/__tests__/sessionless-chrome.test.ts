/**
 * cinatra#2386 (setup-flow S1) — SetupLayout's sessionless chrome branch.
 *
 * /setup/account is the ONLY /setup/* route a sessionless visitor can reach
 * (see src/lib/__tests__/auth-route-guard-public-paths.test.ts for the
 * middleware-level pin). Its parent layout (src/app/setup/layout.tsx) must:
 *   - render a STATIC full-rail progress chrome for that visitor — sign-up as
 *     step 1 followed by the wizard's unconditional steps, every entry
 *     `status: "upcoming"` (cinatra#2477: the signup page carries the same
 *     step indicator as every other setup page; cinatra#2502: Secrets is one
 *     of those unconditional steps, so it is on this rail too),
 *   - WITHOUT ever calling getSetupWizardSteps() — the readiness reader
 *     (readSetupReadinessState / getNangoStatus / readInstanceIdentity are
 *     all real DB reads) must never run for an unauthenticated caller.
 * An authenticated visitor keeps getting the real, live step rail exactly as
 * before.
 *
 * These tests inspect the returned React element tree directly (no DOM
 * renderer / no ReactDOM render) — the codebase's own convention for this
 * surface notes there is no RTL/jsdom runner configured
 * (src/app/setup/key/__tests__/page.test.tsx), and several of SetupLayout's
 * descendants (SearchParamToast, SetupStepNav) are client components that
 * call Next.js navigation hooks unavailable outside a real app-router render.
 * Walking the plain React element props sidesteps that entirely while still
 * proving exactly what this issue cares about: which steps array reaches
 * <SetupStepNav>, and whether the DB-backed step computation ran at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(),
}));
vi.mock("@/lib/setup-wizard", () => ({
  getSetupWizardSteps: vi.fn(),
}));

/** Depth-first search for the first element whose props carry a `steps` array. */
function findStepsProp(node: unknown): unknown[] | undefined {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findStepsProp(child);
      if (found) return found;
    }
    return undefined;
  }
  const el = node as { props?: Record<string, unknown> };
  if (!el.props) return undefined;
  if (Array.isArray(el.props.steps)) return el.props.steps as unknown[];
  return findStepsProp(el.props.children);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SetupLayout — sessionless branch (no session)", () => {
  it("renders the static full step rail (sign-up first, all not-ready), never calling getSetupWizardSteps()", async () => {
    const { getAuthSession } = await import("@/lib/auth-session");
    const { getSetupWizardSteps } = await import("@/lib/setup-wizard");
    (getAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { default: SetupLayout } = await import("../layout");
    const ui = (await SetupLayout({ children: null })) as ReactElement;

    // The readiness reader must NEVER run for a sessionless visitor.
    expect(getSetupWizardSteps).not.toHaveBeenCalled();

    // cinatra#2477 — the FULL static rail: the wizard's unconditional steps
    // with sign-up as step 1. Every entry is `status: "upcoming"` (nothing
    // disclosed, nothing navigable).
    //
    // cinatra#2502 (owner, 2026-08-08) — SECRETS IS ON IT. "Always visible,
    // never hidden by state" covers the signed-out first screen: the step is
    // unconditional now, so drawing its pill performs no readiness read and
    // discloses nothing about the instance behind it.
    const steps = findStepsProp(ui);
    expect(steps).toBeDefined();
    expect(steps).toEqual([
      { id: "sign-up", title: "Account", href: "/setup/account", status: "upcoming" },
      { id: "key", title: "Key", href: "/setup/key", status: "upcoming" },
      { id: "name", title: "Name", href: "/setup/name", status: "upcoming" },
      { id: "secrets", title: "Secrets", href: "/setup/secrets", status: "upcoming" },
      { id: "ai", title: "Model", href: "/setup/model", status: "upcoming" },
    ]);
    // …and it is a FORECAST, not a status: no step may arrive pre-passed, or
    // the sessionless screen would be reporting progress it never read.
    expect(
      (steps ?? []).every((s) => (s as { status: string }).status === "upcoming"),
    ).toBe(true);
  });
});

describe("SetupLayout — authenticated branch (session present)", () => {
  it("computes the real, live step rail via getSetupWizardSteps()", async () => {
    const { getAuthSession } = await import("@/lib/auth-session");
    const { getSetupWizardSteps } = await import("@/lib/setup-wizard");
    const liveSteps = [
      { id: "key", title: "Key", href: "/setup/key", status: "done" },
      { id: "name", title: "Name", href: "/setup/name", status: "upcoming" },
    ];
    (getAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "user-1" },
    });
    (getSetupWizardSteps as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(liveSteps);

    const { default: SetupLayout } = await import("../layout");
    const ui = (await SetupLayout({ children: null })) as ReactElement;

    expect(getSetupWizardSteps).toHaveBeenCalledTimes(1);
    const steps = findStepsProp(ui);
    expect(steps).toEqual(liveSteps);
  });
});
