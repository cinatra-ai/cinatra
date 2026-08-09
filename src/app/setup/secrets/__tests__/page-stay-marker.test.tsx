/**
 * cinatra#2502 — the Secrets step honours the DELIBERATE-NAVIGATION MARKER.
 *
 * Design spec `specs/app-setup.html` revision 0.3.0 §IV: a rail link
 * carries a marker on its destination so the step it lands on knows the
 * operator asked for it and does not immediately forward them on. Without it
 * the link is indistinguishable from an ordinary arrival, the step bounces,
 * "and the rail would look navigable and behave as if it were not".
 *
 * WHY THIS TEST EXISTS. Before #2502 the Secrets step could never be `done` —
 * it left the rail the moment it was satisfied — so its pill was never a
 * revisit link and its unconditional forward-on-connected was harmless. Making
 * the step permanent made that pill a link for the first time, which made the
 * missing `?stay=1` read a live silent bounce. Same contract `/setup/key`,
 * `/setup/name` and `/setup/model` have honoured all along.
 *
 * The two arms are deliberately opposite: without the marker the page MUST
 * forward (that is what keeps a satisfied step out of the operator's way), and
 * with it the page MUST render.
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
  getSetupWizardSteps: vi.fn().mockResolvedValue([
    { id: "secrets", title: "Secrets", href: "/setup/secrets", status: "done" },
    { id: "ai", title: "Model", href: "/setup/model", status: "upcoming" },
  ]),
  getFirstIncompleteStep: vi
    .fn()
    .mockReturnValue({ id: "ai", title: "Model", href: "/setup/model", status: "upcoming" }),
}));
// CONNECTED — the state in which the step forwards on, and therefore the only
// state in which the marker does any work.
vi.mock("@/lib/nango-system", () => ({
  getNangoStatus: () => ({ status: "connected", detail: "" }),
  getNangoSettings: () => ({ secretKey: "already-on-file" }),
  getNangoSettingsEnvManaged: () => ({ secretKey: false, serverUrl: false }),
}));
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

describe("SetupSecretsPage — the ?stay=1 navigation marker (cinatra#2502, spec §IV)", () => {
  it("WITHOUT the marker, a satisfied step forwards on to the wizard's frontier", async () => {
    const { default: SetupSecretsPage } = await import("../page");
    await expect(SetupSecretsPage({})).rejects.toThrow("NEXT_REDIRECT:/setup/model");
  });

  it("WITH the marker, the rail's revisit link RENDERS the step instead of bouncing", async () => {
    const { default: SetupSecretsPage } = await import("../page");
    const ui = (await SetupSecretsPage({
      searchParams: Promise.resolve({ stay: "1" }),
    })) as ReactElement;
    const html = renderToStaticMarkup(ui);

    // The operator asked for this step and gets it — heading, both fields, and
    // the rotate-or-keep affordance for the key already on file.
    expect(html).toMatch(/<h2[^>]*>Secrets<\/h2>/);
    expect(html).toMatch(/data-testid="stub-input-secretKey"/);
    expect(html).toMatch(/data-testid="stub-input-serverUrl"/);
    expect(html).toContain("Leave blank to keep the current saved key.");
  });

  it("reads the marker from a REPEATED query param too (?stay=1&stay=x)", async () => {
    // Next hands a repeated param through as an array; a naive `=== "1"` on the
    // raw value would silently fail to match and bounce the operator.
    const { default: SetupSecretsPage } = await import("../page");
    const ui = (await SetupSecretsPage({
      searchParams: Promise.resolve({ stay: ["1", "x"] }),
    })) as ReactElement;
    expect(renderToStaticMarkup(ui)).toMatch(/<h2[^>]*>Secrets<\/h2>/);
  });

  it("a value that is not exactly 1 is NOT the marker — the step still forwards", async () => {
    const { default: SetupSecretsPage } = await import("../page");
    await expect(
      SetupSecretsPage({ searchParams: Promise.resolve({ stay: "true" }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/setup/model");
  });
});
