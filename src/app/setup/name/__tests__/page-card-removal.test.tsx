/**
 * cinatra#2477 (owner acceptance review) — the Name step's two text fields
 * sit directly on the page: the white-background card (`rounded-card border
 * border-line bg-surface-strong p-6 shadow-sm` section) that used to
 * encapsulate the form is REMOVED.
 *
 * renderToStaticMarkup over the server component with every heavy seam
 * stubbed (same mock-shape conventions as ../../sign-up/__tests__/page.test.tsx);
 * the field inputs are stubbed too so no unrelated component's own
 * `bg-surface-strong` styling can shadow the assertion.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { ReactElement, ReactNode } from "react";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("../actions", () => ({
  saveInstanceIdentityAction: vi.fn(),
}));
// Element stubs via React.createElement (no JSX) — the raw-element lint rule
// targets JSX literals; this mirrors the repo's next/link stub convention.
vi.mock("../instance-namespace-input", () => ({
  NamespaceValidationProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  InstanceDisplayNameInput: () =>
    React.createElement("input", { "data-testid": "display-name-input" }),
  InstanceNamespaceInput: () => React.createElement("input", { "data-testid": "namespace-input" }),
  SubmitContinueButton: () => React.createElement("button", { type: "submit" }, "Continue"),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: () => null,
}));
vi.mock("@/lib/instance-namespace/approved-list", () => ({
  getApprovedInstanceNamespaces: () => [],
}));
vi.mock("@/lib/setup-wizard", () => ({
  getSetupWizardSteps: vi.fn().mockResolvedValue([]),
  getFirstIncompleteStep: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/setup-defaults", () => ({
  getSetupNameDefaults: () => null,
}));
vi.mock("@/lib/instance-identity-copy", () => ({
  getNamespaceMutabilityCopy: () => "mutability copy",
  getNetworkParticipationCopy: () => "participation copy",
  isMarketplaceManagedInstance: () => false,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SetupNamePage — no card around the fields (cinatra#2477)", () => {
  it("renders the identity form directly on the page, without the white-background card wrapper", async () => {
    const { default: SetupNamePage } = await import("../page");
    const ui = (await SetupNamePage({
      searchParams: Promise.resolve({}),
    })) as ReactElement;
    const html = renderToStaticMarkup(ui);

    // The form and both (stubbed) fields are present…
    expect(html).toMatch(/id="instance-name-form"/);
    expect(html).toMatch(/data-testid="display-name-input"/);
    expect(html).toMatch(/data-testid="namespace-input"/);

    // …but no card chrome wraps them: the section styled with the card
    // classes is gone from this surface entirely.
    expect(html).not.toMatch(/rounded-card/);
    expect(html).not.toMatch(/<section/);
  });
});
