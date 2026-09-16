/**
 * @vitest-environment jsdom
 *
 * cinatra#3447 — the §V settings page of an installed agent, rendered with the
 * props its LOADER resolves.
 *
 * The sibling suite pins the §V section set; these arms pin the two readings
 * the loader hands the view for an installed, never-published first-party
 * agent: the header byline names the vendor, and the Marketplace group offers
 * the gated publish action instead of declaring the extension published. The
 * view's markup already draws both correctly — the departure lived in the data,
 * so every prop here is computed by the real resolution chain rather than typed
 * in by hand.
 */
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// The view reads one lookup table from the server-only loader module; the
// sibling suite mocks it to that table for the same reason.
vi.mock("@cinatra-ai/extensions/screens/installed-rows", () => ({
  KIND_LABEL: {
    agent: "Agent",
    connector: "Connector",
    skill: "Skill",
    artifact: "Artifact",
    workflow: "Workflow",
  },
  settingsHrefFor: (kind: string, packageName: string) =>
    `/configuration/extensions/settings/${kind}/${packageName}`,
}));

// A plain element host for next/link (never a raw anchor: the design-system
// gate rejects one anywhere in the tree), keeping the destination readable.
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <span data-href={typeof href === "string" ? href : "#"}>{children}</span>
  ),
}));

import {
  ExtensionSettingsView,
  type ExtensionSettingsActions,
  type ExtensionSettingsViewProps,
} from "@cinatra-ai/extensions/screens/extension-settings-view";
import { resolveInstalledRowVisibility } from "@cinatra-ai/extensions/screens/installed-visibility";
import { declaredVendorNameForScope, resolveInstalledVendorName } from "@cinatra-ai/registries";

const ACTIONS: ExtensionSettingsActions = {
  archive: vi.fn(),
  activate: vi.fn(),
  retryActivation: vi.fn(),
  rollBackToBundled: vi.fn(),
  reinstall: vi.fn(),
  publish: vi.fn(),
  forceDelete: vi.fn(),
};

/**
 * The generated static manifest as the loader reads it: the first-party AGENT
 * entry declares no vendor of its own, its scope siblings declare the vendor
 * identity.
 */
const MANIFEST_ENTRIES = [
  { packageName: "@cinatra-ai/deep-research-agent", vendor: null },
  { packageName: "@cinatra-ai/apify-connector", vendor: { key: "cinatra-ai", name: "Cinatra" } },
];

const PACKAGE_NAME = "@cinatra-ai/deep-research-agent";

/** The vendor the loader resolves for that row (`vendorFor`'s chain). */
function loaderVendor(): string | null {
  return resolveInstalledVendorName({
    manifestVendorName: null,
    author: null,
    scopeVendorName: declaredVendorNameForScope(MANIFEST_ENTRIES, PACKAGE_NAME),
  });
}

/**
 * The visibility the loader resolves for a row: its catalog origin block, and
 * whether the package carries a marketplace catalog summary at all (a summary
 * with no origin block is a legacy published package, grandfathered public).
 */
function loaderIsPublic(
  origin: { visibility: string; scope: string } | null,
  hasCatalogSummary = origin != null,
): boolean {
  return (
    resolveInstalledRowVisibility({ nativeVisibility: null, origin, hasCatalogSummary }) ===
    "public"
  );
}

function props(overrides: Partial<ExtensionSettingsViewProps> = {}): ExtensionSettingsViewProps {
  return {
    kind: "agent",
    packageName: PACKAGE_NAME,
    displayName: "Deep Research Agent",
    vendor: loaderVendor(),
    recovery: { showRetryActivation: false, showRollBackToBundled: false },
    updateRow: {
      enabled: false,
      description: "Currently on version 0.5.0 — up to date.",
      disabledReason: "Already on the newest version.",
    },
    archiveDisabled: null,
    activateDisabled: null,
    reinstallDisabled: null,
    forceDeleteDisabled: null,
    isPublic: loaderIsPublic(null),
    isRegisteredVendor: false,
    canPublish: false,
    permissions: <p data-slot="seeded-permissions">Seeded permissions control</p>,
    actions: ACTIONS,
    ...overrides,
  } as ExtensionSettingsViewProps;
}

function marketplaceGroup(container: HTMLElement): HTMLElement {
  const group = container.querySelector<HTMLElement>('[data-slot="settings-marketplace"]');
  expect(group).not.toBeNull();
  return group!;
}

afterEach(() => {
  cleanup();
});

describe("§V settings header — the byline names the vendor (cinatra#3447)", () => {
  it("reads '{Kind} by {Vendor}' for an installed first-party agent", () => {
    const { container } = render(<ExtensionSettingsView {...props()} />);

    const name = container.querySelector('[data-slot="extension-settings-name"]');
    expect(name).not.toBeNull();
    const byline = name!.parentElement!.querySelector("p");
    expect(byline).not.toBeNull();
    expect(byline!.textContent?.replace(/\s+/g, " ").trim()).toBe("Agent by Cinatra");
  });
});

describe("§V Marketplace group — the gated publish action (cinatra#3447)", () => {
  it("offers the muted action beside 'Register for marketplace' when the instance is no registered vendor", () => {
    const { container } = render(<ExtensionSettingsView {...props()} />);
    const group = marketplaceGroup(container);

    expect(group.textContent).not.toContain("Published on the marketplace.");
    const action = group.querySelector<HTMLButtonElement>('[data-slot="disabled-action"]');
    expect(action).not.toBeNull();
    expect(action!.textContent).toContain("Publish on marketplace");
    expect(action!.disabled).toBe(true);
    expect(action!.getAttribute("data-disabled-reason")).toBe(
      "Register this instance as a marketplace vendor to publish.",
    );
    expect(group.textContent).toContain("Register for marketplace");
    expect(group.querySelector("[data-href]")?.getAttribute("data-href")).toBe(
      "/configuration/environment?tab=registries",
    );
  });

  it("mutes the action with the 'not available yet' reason for a registered vendor on an unpublishable kind", () => {
    const { container } = render(
      <ExtensionSettingsView {...props({ isRegisteredVendor: true, canPublish: false })} />,
    );
    const group = marketplaceGroup(container);

    expect(group.textContent).not.toContain("Published on the marketplace.");
    expect(group.textContent).not.toContain("Register for marketplace");
    const action = group.querySelector<HTMLButtonElement>('[data-slot="disabled-action"]');
    expect(action).not.toBeNull();
    expect(action!.disabled).toBe(true);
    expect(action!.getAttribute("data-disabled-reason")).toBe(
      "Marketplace publishing isn't available for this extension yet.",
    );
  });

  it("still reads as published for a row whose registry origin really is public", () => {
    const { container } = render(
      <ExtensionSettingsView
        {...props({ isPublic: loaderIsPublic({ visibility: "public", scope: "@cinatra-ai" }) })}
      />,
    );
    const group = marketplaceGroup(container);

    expect(group.textContent).toContain("Published on the marketplace.");
    expect(group.querySelector('[data-slot="disabled-action"]')).toBeNull();
  });

  it("still reads as published for a LEGACY published row — a catalog summary with no origin block", () => {
    // packages/registries/src/types.ts grandfathers a null origin on a package
    // that IS in the catalog to "public"; only a package with no catalog
    // summary at all reads as never published.
    const { container } = render(
      <ExtensionSettingsView {...props({ isPublic: loaderIsPublic(null, true) })} />,
    );
    const group = marketplaceGroup(container);

    expect(group.textContent).toContain("Published on the marketplace.");
    expect(group.querySelector('[data-slot="disabled-action"]')).toBeNull();
  });
});
