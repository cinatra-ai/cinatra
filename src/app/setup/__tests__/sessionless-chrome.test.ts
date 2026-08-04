/**
 * cinatra#2386 (setup-flow S1) — SetupLayout's sessionless chrome branch.
 *
 * /setup/sign-up is the ONLY /setup/* route a sessionless visitor can reach
 * (see src/lib/__tests__/auth-route-guard-public-paths.test.ts for the
 * middleware-level pin). Its parent layout (src/app/setup/layout.tsx) must:
 *   - render a STATIC single-step "Sign up" progress chrome for that visitor,
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
  it("renders a static single-step 'Sign up' progress chrome, never calling getSetupWizardSteps()", async () => {
    const { getAuthSession } = await import("@/lib/auth-session");
    const { getSetupWizardSteps } = await import("@/lib/setup-wizard");
    (getAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { default: SetupLayout } = await import("../layout");
    const ui = (await SetupLayout({ children: null })) as ReactElement;

    // The readiness reader must NEVER run for a sessionless visitor.
    expect(getSetupWizardSteps).not.toHaveBeenCalled();

    const steps = findStepsProp(ui);
    expect(steps).toBeDefined();
    expect(steps).toHaveLength(1);
    expect(steps?.[0]).toMatchObject({ id: "sign-up", href: "/setup/sign-up", ready: false });
  });
});

describe("SetupLayout — authenticated branch (session present)", () => {
  it("computes the real, live step rail via getSetupWizardSteps()", async () => {
    const { getAuthSession } = await import("@/lib/auth-session");
    const { getSetupWizardSteps } = await import("@/lib/setup-wizard");
    const liveSteps = [
      { id: "key", title: "Key", href: "/setup/key", ready: true },
      { id: "name", title: "Name", href: "/setup/name", ready: false },
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
