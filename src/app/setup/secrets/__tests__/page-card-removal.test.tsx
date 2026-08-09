/**
 * cinatra#2502 item A — the Secrets step's fields sit directly on the wizard
 * column. The white-background card (`rounded-card border border-line
 * bg-surface-strong p-6 shadow-sm` section) that used to encapsulate the form
 * is REMOVED, matching the migration #2477/#2483 already applied to `name` and
 * `key`. This is the white background the owner reported.
 *
 * Design spec `specs/app-setup.html` revision 0.3.0 §I: "The step
 * body is cardless" — Rule #8 keeps pure-white `--surface-strong` for the
 * elements the operator actually touches, and this step's two inputs are those
 * elements, not the container around them.
 *
 * Same convention as ../../name/__tests__/page-card-removal.test.tsx: the shared
 * field/input components are stubbed so no unrelated component's own
 * `bg-surface-strong` can shadow the assertion.
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
vi.mock("@/app/campaigns/actions", () => ({
  saveNangoConnectionAction: vi.fn(),
}));
vi.mock("@/lib/setup-wizard", () => ({
  getSetupWizardSteps: vi.fn().mockResolvedValue([]),
  getFirstIncompleteStep: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/nango-system", () => ({
  getNangoStatus: () => ({ status: "not_connected", detail: "" }),
  getNangoSettings: () => ({}),
  getNangoSettingsEnvManaged: () => ({ secretKey: false, serverUrl: false }),
}));
// Element stubs via React.createElement (no JSX) — the raw-element lint rule
// targets JSX literals; this mirrors the repo's next/link stub convention.
vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) =>
    React.createElement("input", { "data-testid": `stub-input-${props.name ?? "x"}`, ...props }),
}));
vi.mock("@/components/ui/input-group", () => ({
  InputGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  InputGroupAddon: ({ children }: { children: ReactNode }) => <>{children}</>,
  InputGroupInput: (props: Record<string, unknown>) =>
    React.createElement("input", { "data-testid": `stub-input-${props.name ?? "x"}`, ...props }),
}));
vi.mock("@/components/ui/field", () => ({
  FieldGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  Field: ({ children }: { children: ReactNode }) => <>{children}</>,
  FieldLabel: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) =>
    React.createElement("button", { type: "submit" }, children),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SetupSecretsPage — cardless (cinatra#2502 item A)", () => {
  it('is headed "Secrets" and renders its fields without the white-background card wrapper', async () => {
    const { default: SetupSecretsPage } = await import("../page");
    const html = renderToStaticMarkup((await SetupSecretsPage({})) as ReactElement);

    // The step's own name, and both fields, are present…
    expect(html).toContain("Secrets");
    expect(html).toMatch(/data-testid="stub-input-secretKey"/);
    expect(html).toMatch(/data-testid="stub-input-serverUrl"/);

    // …with no card chrome around them.
    expect(html).not.toMatch(/rounded-card/);
    expect(html).not.toMatch(/bg-surface-strong/);
    expect(html).not.toMatch(/shadow-sm/);
  });

  it("no longer calls the step Connections — the label the owner renamed is gone from the surface", async () => {
    const { default: SetupSecretsPage } = await import("../page");
    const html = renderToStaticMarkup((await SetupSecretsPage({})) as ReactElement);
    // "connections" survives only as prose describing what Nango stores (OAuth
    // connections), never as this step's own name — so the HEADING is the
    // assertion, not a blanket word ban.
    expect(html).toMatch(/<h2[^>]*>Secrets<\/h2>/);
    expect(html).not.toMatch(/<h2[^>]*>Connections<\/h2>/);
  });
});
